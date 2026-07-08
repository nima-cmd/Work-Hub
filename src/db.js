// src/db.js — single Postgres connection pool for the tracker.
//
// Reads DATABASE_URL from the environment. Run scripts with
// `node --env-file=.env.local ...` (or the npm scripts, which do that for you)
// so the Neon connection string is loaded without hardcoding any secret.

import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Run with `node --env-file=.env.local ...` (see .env.local).',
  )
}

// One shared pool for the whole app.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Convenience wrapper: query(text, params) -> result
export const query = (text, params) => pool.query(text, params)
