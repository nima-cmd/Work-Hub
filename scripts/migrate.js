// scripts/migrate.js — apply db/schema.sql to the Neon database.
//
// Idempotent (the schema uses CREATE TABLE IF NOT EXISTS), so it's safe to
// re-run any time we change the schema. Run: `npm run migrate`.

import { readFileSync } from 'node:fs'
import { pool } from '../src/db.js'

const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

await pool.query(sql)

const { rows } = await pool.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
)

console.log('✅ Migration applied. Tables in the database:')
for (const r of rows) console.log('   -', r.table_name)

await pool.end()
