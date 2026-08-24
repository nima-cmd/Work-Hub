// src/db.js — single Postgres connection pool for the tracker.
//
// Reads DATABASE_URL from the environment. Run scripts with
// `node --env-file=.env.local ...` (or the npm scripts, which do that for you)
// so the Neon connection string is loaded without hardcoding any secret.

import { readFileSync } from 'node:fs'
import pg from 'pg'
import { poolSettings } from './model/poolLimits.js'
import { hostKind } from './model/dbCopyPlan.js'
import { stripMissingSslRootCert } from './model/connectionString.js'

const { Pool } = pg

// ── Neon or the local mirror ────────────────────────────────────────────────
//
// WHY THIS SWITCH EXISTS (2026-08-14). Neon's Free plan allows 5 GB/month of public
// network transfer and **SUSPENDS THE COMPUTE** when it runs out — not throttled,
// stopped, until the next billing period. We hit 84% by the 14th.
//
// Measured, the cause was not the app's normal use. It was DEVELOPMENT: 131 commits
// in two weeks, and every verification loop reads Neon over the public internet —
// `check:counters` alone is 5.3 MB per run, a page load touching every surface is
// 3.3 MB, and the whole database is only 26 MB. So the same 26 MB was crossing the
// wire hundreds of times a day to answer questions a local copy answers for free.
//
// `npm run db:mirror` clones Neon into local Postgres in ONE read. Development then
// runs against that, and Neon serves only the deployed app.
//
// ⚠️ THE DANGER, AND IT IS THE WORST BUG THIS REPO COULD HAVE. A mirror is stale by
// definition. Every field-assumption entry in src/model/fieldAssumptions.js is some
// version of "a number looked right and wasn't" — and a stale mirror reporting as
// live would be exactly that, at the scale of the whole app. So the target is never
// implicit: it is exported, logged at startup, shown on Health, and stamped with the
// clone's age. If you cannot tell which database a number came from, do not trust it.
const useMirror = process.env.WORKHUB_DB === 'mirror'
const url = useMirror ? process.env.DATABASE_URL_LOCAL : process.env.DATABASE_URL

if (!url) {
  throw new Error(
    useMirror
      ? 'WORKHUB_DB=mirror but DATABASE_URL_LOCAL is not set. Run `npm run db:mirror` first (it prints the line to add).'
      : 'DATABASE_URL is not set. Run with `node --env-file=.env.local ...` (see .env.local).',
  )
}

/**
 * Which database this process is actually talking to.
 *
 * ⚠️ THIS USED TO BE `useMirror ? 'mirror' : 'neon'` — it hardcoded "neon" for anything
 * that was not the mirror. That was true for exactly as long as Neon was the only remote,
 * and it became a LIE the moment the app was pointed at DigitalOcean (2026-08-18):
 * `npm run check:neon` cheerfully reported "✓ UP  NEON · 320 orders" while connected to DO,
 * and projected transfer against a 5 GB cap that no longer applies to anything.
 *
 * A green check naming the wrong database is worse than no check — it is the whole bug
 * class src/model/fieldAssumptions.js exists for, aimed at the one number that says
 * whether the app is alive. So the label is DERIVED FROM THE CONNECTION, never assumed:
 * 'mirror' · 'neon' · 'digitalocean' · 'other'.
 */
export const DB_TARGET = useMirror ? 'mirror' : hostKind(url)
export const IS_MIRROR = useMirror

// ── TLS to DigitalOcean, verified, everywhere ───────────────────────────────
//
// DO signs each cluster with a PRIVATE per-project CA (`CN=<uuid> Project CA`), which is
// in no public trust store — so node-pg's default verification correctly refuses it.
//
// ⚠️ The workaround the deploy shipped with was `uselibpqcompat=true&sslmode=require`:
// encrypted, but NOT verifying who is on the other end. That mattered more than usual
// here, because the database's trusted-source list has to admit Render's outbound ranges
// — and Render states those `/24`s are SHARED with other Render customers. The network
// boundary is weak by construction, which makes the certificate the real control.
//
// So the CA is committed (db/do-ca-certificate.crt — a public certificate, not a secret)
// and applied HERE rather than through a connection-string parameter. Two reasons: the
// deploy needs no env change to gain verification, and a URL is easy to paste without it.
//
// The leaf's SAN does list the public hostname, so `rejectUnauthorized` is genuine
// verify-full behaviour, not just chain-of-trust.
//
// ⚠️ Falls back silently to whatever the URL specifies if the file is unreadable. A
// missing cert must not take the app down — it should cost verification, not uptime.
function sslFor(u) {
  if (hostKind(u) !== 'digitalocean') return undefined
  try {
    const ca = readFileSync(new URL('../db/do-ca-certificate.crt', import.meta.url), 'utf8')
    return { ca, rejectUnauthorized: true, servername: new URL(u).hostname }
  } catch {
    return undefined
  }
}

/** Whether this process is verifying DigitalOcean's certificate (shown on Health). */
export const TLS_VERIFIED = !!sslFor(url)


const connectionString = stripMissingSslRootCert(url)

// One shared pool for the whole app.
//
// ⚠️ `max` IS SET DELIBERATELY — see src/model/poolLimits.js. node-pg's default of 10
// per process meant a deploy + a dev server + one script could want 30 connections, and
// DigitalOcean's 1 GiB plan allows 22. Neon never surfaced this because its limit was
// transfer, not connections; moving to a database that meters no transfer swaps one
// ceiling for another, and this is the other one.
export const POOL = poolSettings(process.env)
export const pool = new Pool({ connectionString, ...POOL, ...(sslFor(url) ? { ssl: sslFor(url) } : {}) })

// ── Transfer metering ───────────────────────────────────────────────────────
//
// Every result set is weighed on the way past, so "how much are we reading out of
// Neon, and which process is doing it" stops being a question we can only answer
// after an email. See src/model/transferMeter.js for what this can and cannot claim.
//
// ⚠️ An ESTIMATE and a LOWER BOUND: it counts row bytes, not TLS or the wire
// protocol's framing. Neon's console is the authority; this is for attribution.
//
// 'deploy' on Render, 'cron' when the recurring check is driving, else 'local'.
export const TRANSFER_SOURCE = process.env.RENDER || process.env.RENDER_SERVICE_ID
  ? 'deploy'
  : (process.env.WORKHUB_ROLE || 'local')

let pending = { bytes: 0, queries: 0 }
let lastFlush = Date.now()
let flushing = false
const FLUSH_MS = 5 * 60 * 1000
// ⚠️ A TIME-ONLY flush records nothing for the traffic that matters most. Almost all
// of this repo's Neon reads come from SHORT-LIVED SCRIPTS — check:counters, the syncs,
// the analyzers — which finish in seconds and call process.exit(), so neither a timer
// nor `beforeExit` ever fires. The meter would have quietly reported zero for exactly
// the processes that caused the problem it was built to find. So a heavy run flushes
// on VOLUME as well, and 2 MB is chosen to be well under one check:counters run (5.3 MB)
// while ignoring trivial scripts whose usage does not matter anyway.
const FLUSH_BYTES = 2 * 1024 * 1024

// ⚠️ MEASURED EXACTLY, after two attempts at being clever both failed.
//
//   sample row[0] x count   -> 88.6 MB for a run that was really 5.3 MB  (16x)
//   sample 8 rows, average  ->  8.1 MB for a run that was really 3.1 MB  (2.6x)
//
// Result sets here are wildly heterogeneous — a 3,872-row table with a JSON payload
// column sits next to a COUNT(*) — so no small sample represents the set, and a
// monitor that is 2.6x out is one nobody will act on. The reason for sampling was
// hot-path cost, and that reason does not survive contact with the numbers: pg has
// ALREADY parsed every one of these rows off the wire into JS objects, which is
// strictly more expensive than walking them again. Correctness wins.
function weigh(rows) {
  if (!rows?.length) return 0
  try { return Buffer.byteLength(JSON.stringify(rows)) } catch { return 0 }
}

async function flush() {
  if (flushing || (!pending.bytes && !pending.queries)) return
  flushing = true
  const batch = pending
  pending = { bytes: 0, queries: 0 }
  // ⚠️ On the mirror this write is pointless (local work costs Neon nothing) AND it
  // would trip the write guard above. Skip it rather than fail noisily every 5 minutes.
  if (useMirror && !mirrorWritesAllowed) { flushing = false; lastFlush = Date.now(); return }
  try {
    await rawQuery(
      `INSERT INTO transfer_log (day, source, bytes, queries, updated_at)
       VALUES (CURRENT_DATE, $1, $2, $3, now())
       ON CONFLICT (day, source) DO UPDATE
         SET bytes = transfer_log.bytes + EXCLUDED.bytes,
             queries = transfer_log.queries + EXCLUDED.queries,
             updated_at = now()`,
      [TRANSFER_SOURCE, batch.bytes, batch.queries],
    )
  } catch {
    // ⚠️ A diagnostic must never break the thing it is diagnosing. If the table does
    // not exist yet (pre-migration) or the write fails, the counts are put back and
    // the app carries on as though the meter were not here.
    pending.bytes += batch.bytes
    pending.queries += batch.queries
  } finally {
    flushing = false
    lastFlush = Date.now()
  }
}

// ── Say what a dead database MEANS ──────────────────────────────────────────
//
// Nima, 2026-08-17: "how will i know when its offline". Tested, and the honest answer
// was that he would NOT know: every endpoint reported `connect ECONNREFUSED
// 127.0.0.1:1`, which reads as "the app is broken" rather than "your database is
// suspended". He would have spent the morning debugging the wrong thing.
//
// Every query goes through one wrapper, so one place can translate the failure into
// what it means and what to do about it. Endpoints already surface `e.message`, so
// they all inherit this without being touched.
//
// ⚠️ NOW WE HAVE SEEN IT. 2026-08-18, the morning Neon actually suspended:
//
//     Your project has exceeded the data transfer quota. Upgrade your plan to
//     increase limits.
//
// The earlier version of this comment said the real error was unknown and matched only
// the CLASS of failure — and that pattern did NOT match this text, so the advice never
// fired on the one event it was written for. Neon's own wording is clear about the
// cause; what it does not say is what to do about it here, which is the half we add.
const QUOTA = /exceeded the data transfer quota|data transfer quota|exceeded .*quota/i
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|Connection terminated|termination|server closed the connection|timeout expired|too many connections/i

export function explainDbError(err) {
  // ⚠️ IDEMPOTENT. The pool wrapper already explains, and callers explain again defensively
  // — which nested the advice inside its own brackets twice over. An error message that
  // repeats itself is one people stop reading.
  if (err?.dbUnreachable) return err
  const msg = String(err?.message || err || '')
  // ⚠️ CONNECTION EXHAUSTION READS LIKE NOTHING AT ALL. Postgres says "too many clients
  // already" (SQLSTATE 53300) and node-pg says "timeout exceeded when trying to connect"
  // — neither of which suggests a capacity ceiling to anyone reading a stack trace. On a
  // 22-connection plan this is a real, reachable state, so it gets named.
  if (EXHAUSTED.test(msg) || err?.code === '53300') {
    const e = new Error(
      'Out of database connections — every client in this pool is checked out, or the '
      + `server refused a new one. This pool allows ${POOL.max} (role: ${POOL.role}); `
      + 'DigitalOcean\'s 1 GiB plan allows 22 across ALL processes. Close other servers '
      + 'and scripts, use a PgBouncer connection pool for the deploy, or raise '
      + `WORKHUB_POOL_MAX. [${msg}]`)
    e.connectionsExhausted = true
    return e
  }
  const quota = QUOTA.test(msg)
  if (!quota && !UNREACHABLE.test(msg)) return err
  // ⚠️ A QUOTA error can only come from Neon — local Postgres has no allowance to
  // exceed. So it names Neon regardless of which target this process is pointed at,
  // instead of reporting "Local Postgres is SUSPENDED", which is impossible and which
  // the first cut of this did say.
  const local = useMirror && !quota
  const where = local ? 'Local Postgres' : 'Neon'
  const advice = local
    ? 'Is the local server running?  pg_ctl -D /usr/local/var/postgresql@17 status'
    : 'It comes back at the billing reset or on upgrade. To keep working now: '
      + 'npm run dev:offline (local Postgres, writes permitted). Check with npm run check:neon.'
  // A quota suspension is a FACT Neon stated, so say it as one. Everything else is
  // still a guess, and keeps the hedge.
  // ⚠️ Three different situations, three different sentences. Saying "likely suspended"
  // about LOCAL Postgres is nonsense — it has no allowance to exceed, it is just not
  // running — and a diagnostic that suggests the wrong cause sends someone the wrong way.
  const lead = quota
    ? `${where} is SUSPENDED — the monthly data-transfer quota is used up.`
    : local
      ? 'Local Postgres is not answering.'
      : 'Neon is not answering — it may be suspended, or the network is down.'
  const e = new Error(`${lead} ${advice} [${msg}]`)
  e.dbUnreachable = true
  e.quotaExceeded = quota
  e.target = DB_TARGET
  e.original = msg
  return e
}

// The unmetered path, so flush() cannot count itself.
const rawQuery = (text, params) => pool.query(text, params)

const _poolQuery = pool.query.bind(pool)
pool.query = function meteredQuery(...args) {
  if (useMirror && !mirrorWritesAllowed) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
    if (text && WRITE_RE.test(text)) {
      return Promise.reject(new Error(
        'Refusing to write to the LOCAL MIRROR — the next `npm run db:mirror` would destroy it. '
        + 'Unset WORKHUB_DB to work against Neon, or set WORKHUB_MIRROR_WRITES=1 if this write is meant to be thrown away. '
        + `Query: ${String(text).replace(/\s+/g, ' ').slice(0, 80)}`))
    }
  }
  const out = _poolQuery(...args)
  if (out && typeof out.then === 'function') {
    return out.then((res) => {
      pending.bytes += weigh(res?.rows)
      pending.queries += 1
      if (pending.bytes > FLUSH_BYTES || Date.now() - lastFlush > FLUSH_MS) flush().catch(() => {})
      return res
    // ⚠️ Rethrow the EXPLAINED error, with the original text kept in brackets. A
    // friendlier message that hides the real one would just move the debugging problem.
    }, (err) => { throw explainDbError(err) })
  }
  return out
}

// ── The mirror must never silently eat real work ────────────────────────────
//
// ⚠️ Reading stale data is recoverable — you notice, you re-clone. WRITING to the
// mirror is not: the next `npm run db:mirror` DROPS the database, so a carton scan or
// a mark-shipped done against it is destroyed with no trace that it ever happened.
//
// Nima uses this app for real from localhost at work and from the Render deploy at
// home, so the mirror being the default even once is a data-loss bug. The default is
// Neon (see .env.local) and this is the second line of defence: on the mirror, a
// write is refused outright unless WORKHUB_MIRROR_WRITES=1 says it is deliberate —
// which the clone script and the tests set, because for them a throwaway write is the
// entire point.
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i
// "too many clients already" (Postgres) · "timeout exceeded when trying to connect" (node-pg)
const EXHAUSTED = /too many clients|timeout exceeded when trying to connect|remaining connection slots/i

// ── Offline mode (2026-08-17) ───────────────────────────────────────────────
//
// Neon hit 100% of its monthly transfer and suspends until the reset. The local mirror
// keeps the app fully working — and the NetSuite sync does not need Neon AT ALL, since
// `netsuiteApi.js` is a plain HTTPS client. Proven: a full sync wrote 270 orders, 192
// fulfilments and 1,175 invoices straight into local Postgres. So NOTHING has to fall
// back to CSV; the CSV path is the fallback for NETSUITE being down, not for Neon.
//
// ⚠️ But working offline means the app's OWN records — custody scans, BOL numbers,
// filing events, tasks — exist only locally, and `npm run db:mirror` DROPS the database
// on every clone. Two weeks of scanning could be destroyed by one habitual re-clone.
// That is the divergence this repo has refused to build all along, now unavoidable for
// a fortnight, so it is made explicit rather than left as a trap:
//
//   WORKHUB_OFFLINE=1   writes are permitted and the server says so at startup
//   npm run db:mirror   REFUSES when local holds app-owned rows newer than the clone
//
// WORKHUB_MIRROR_WRITES stays separate: it is the clone script's own internal flag for
// writes it is about to throw away, and must not double as "I am working offline".
const mirrorWritesAllowed = process.env.WORKHUB_MIRROR_WRITES === '1'
  || process.env.WORKHUB_OFFLINE === '1'
export const IS_OFFLINE = useMirror && process.env.WORKHUB_OFFLINE === '1'

/**
 * Tables the APP owns — nothing upstream can regenerate these, so losing them is
 * losing work. Everything else (orders, fulfillments, invoices, edi_*, catalogue) is a
 * projection of NetSuite or Orderful and comes back on the next sync.
 */
export const APP_OWNED_TABLES = [
  'order_events', 'routing_shipment', 'routing_auth', 'routing_hold', 'routing_shipment_edi',
  'bol_registry', 'dead_label', 'fulfillment_boxes', 'quest_tasks', 'quest_task_activity',
  'recurring_task_templates', 'notes', 'doc_links', 'email_links', 'oc_po_links',
  'edi_manual_links', 'edi_manual_orders', 'edi_po_resolutions', 'shipstation_order',
  'day_plan_item', 'email_character_prefs', 'doc_seasons',
]

// ⚠️ CLIENTS TOO, and this was a real hole. The meter originally wrapped only
// `pool.query`, while every transaction goes through `pool.connect()` and then
// `client.query` — so `withTransaction` was completely invisible. Measuring a full
// NetSuite refresh (271 orders, 194 fulfilments, 1,162 invoices, 113 seconds) through
// the meter reported TWO queries and 0.00 MB, because the entire sync runs in
// transactions.
//
// A meter that misses the heaviest path is worse than no meter: it would have said
// "0.06 MB this month" while the real traffic went unrecorded, and we would have
// trusted it. Found only by pointing it at a real workload — which is the same
// lesson as every entry in src/model/fieldAssumptions.js.
const _poolConnect = pool.connect.bind(pool)
pool.connect = async function meteredConnect(...args) {
  const client = await _poolConnect(...args)
  if (client && !client.__metered) {
    client.__metered = true
    const _clientQuery = client.query.bind(client)
    client.query = function meteredClientQuery(...qargs) {
      if (useMirror && !mirrorWritesAllowed) {
        const text = typeof qargs[0] === 'string' ? qargs[0] : qargs[0]?.text
        if (text && WRITE_RE.test(text)) {
          return Promise.reject(new Error(
            'Refusing to write to the LOCAL MIRROR — the next `npm run db:mirror` would destroy it. '
            + 'Unset WORKHUB_DB to work against Neon, or set WORKHUB_MIRROR_WRITES=1 if this write is meant to be thrown away.'))
        }
      }
      const out = _clientQuery(...qargs)
      if (out && typeof out.then === 'function') {
        return out.then((res) => {
          pending.bytes += weigh(res?.rows)
          pending.queries += 1
          return res
        })
      }
      return out
    }
  }
  return client
}

/** Write out whatever is pending — call before a short-lived script exits. */
export const flushTransferMeter = () => flush().catch(() => {})

// Best effort for scripts that let the loop drain rather than calling process.exit().
process.once('beforeExit', () => { flush().catch(() => {}) })

/**
 * When the mirror was cloned, and how old that makes it. Null on Neon — the live
 * database has no "as of", which is the whole point of the distinction.
 */
export async function mirrorAsOf() {
  if (!useMirror) return null
  try {
    const { rows } = await pool.query(
      `SELECT value FROM sync_meta WHERE key = 'mirror_cloned_at'`)
    const at = rows[0]?.value ? new Date(rows[0].value) : null
    if (!at || Number.isNaN(at.getTime())) return { at: null, ageHours: null }
    return { at, ageHours: (Date.now() - at.getTime()) / 36e5 }
  } catch {
    return { at: null, ageHours: null }
  }
}

// Convenience wrapper: query(text, params) -> result
export const query = (text, params) => pool.query(text, params)

// Run `fn` inside a single transaction, passing it a dedicated client.
// COMMIT on success, ROLLBACK on any throw — so a mid-ingest failure can never
// leave the tables half-written (which previously stranded orders at the wrong
// stage until a clean re-run). Pass the client through to the load* functions.
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
