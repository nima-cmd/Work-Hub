// src/db.js — single Postgres connection pool for the tracker.
//
// Reads DATABASE_URL from the environment. Run scripts with
// `node --env-file=.env.local ...` (or the npm scripts, which do that for you)
// so the Neon connection string is loaded without hardcoding any secret.

import pg from 'pg'

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

/** 'mirror' = local clone (STALE BY DEFINITION) · 'neon' = the real thing. */
export const DB_TARGET = useMirror ? 'mirror' : 'neon'
export const IS_MIRROR = useMirror

// One shared pool for the whole app.
export const pool = new Pool({ connectionString: url })

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
    })
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
const mirrorWritesAllowed = process.env.WORKHUB_MIRROR_WRITES === '1'

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
