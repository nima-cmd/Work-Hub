// scripts/migrate.js — apply db/schema.sql to the Neon database.
//
// Idempotent (the schema uses CREATE TABLE IF NOT EXISTS), so it's safe to
// re-run any time we change the schema. Run: `npm run migrate`.
//
// ⚠️ WHICH DATABASE, ANNOUNCED AND GUARDED. Once `WORKHUB_DB=mirror` is set in
// .env.local, every script silently follows it — including this one. That happened
// on the day the mirror landed: `npm run migrate` reported success having created
// `transfer_log` on the LOCAL CLONE, while Neon (the database that actually needed
// it, because the deploy writes there) never got the table. Nothing said a word.
//
// Migrating the mirror is also pointless: `npm run db:mirror` applies schema.sql on
// every clone. So this refuses the mirror unless you really mean it, and always says
// where it is pointed.

import { readFileSync } from 'node:fs'
import { pool, DB_TARGET, IS_MIRROR } from '../src/db.js'

if (IS_MIRROR && !process.argv.includes('--mirror')) {
  console.error('\n  ✗ WORKHUB_DB=mirror, so this would migrate the LOCAL CLONE, not Neon.')
  console.error('    The live database is almost certainly what you meant — the deploy reads it.\n')
  console.error('      npm run migrate                     # migrate the live database (DATABASE_URL)')
  console.error('      npm run migrate -- --mirror         # really migrate the clone\n')
  process.exit(1)
}

// ⚠️ Was `'mirror' ? … : 'NEON (live)'` — which announced "NEON" while migrating
// DigitalOcean after the 2026-08-18 cutover. Migrations are the last place to be vague
// about which database you are altering, so the name comes from the connection.
const TARGET_NAME = { mirror: 'the LOCAL MIRROR', neon: 'NEON (live)', digitalocean: 'DIGITALOCEAN (live)' }[DB_TARGET] || `${DB_TARGET} (live)`
console.log(`\n  Migrating: ${TARGET_NAME}`)

const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

await pool.query(sql)

const { rows } = await pool.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
)

console.log(`✅ Migration applied to ${TARGET_NAME}. Tables:`)
for (const r of rows) console.log('   -', r.table_name)

await pool.end()
