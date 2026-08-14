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
