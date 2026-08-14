// scripts/db-mirror.js — clone Neon into local Postgres, in ONE read.
// Run: npm run db:mirror        (needs .env.local; reads Neon, writes only locally)
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// Neon's Free plan allows 5 GB/month of public network transfer and SUSPENDS the
// compute when it runs out. On 2026-08-14 we were at 84% (4.2 GB) — and the measured
// cause was development, not the app: 131 commits in two weeks, with every
// verification loop reading Neon over the public internet. `check:counters` is 5.3 MB
// a run. A page load touching every surface is 3.3 MB. The entire database is 26 MB.
//
// So the same 26 MB was crossing the wire hundreds of times a day. This pulls it
// ONCE, and development runs locally from then on.
//
//   one clone   ~26 MB   (and only the bytes actually in the tables)
//   one day of the old way   ~300 MB
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// ⚠️ NOT a two-way sync, deliberately. Nima asked about keeping a local database and
// syncing it back up. The app OWNS some of its data — routing cards, BOL numbers,
// custody scans, dead labels, tasks, filing events — and two writable copies of that
// means conflict resolution on a BOL number that must never be reused. This repo
// already has the lesson written down (the Macy's routing ingest deliberately has no
// second table, "because a second copy is a thing that can disagree"), and a
// divergent order ledger is a far worse problem than a quota.
//
// So the flow is ONE WAY: Neon -> local, replacing the local copy each time. The
// mirror is a fast, free, disposable READ REPLICA for development. Anything you do on
// the mirror is thrown away by the next clone — which is exactly what makes it safe
// to test destructive things against.
//
// ⚠️ The mirror is STALE BY DEFINITION. `src/db.js` exports DB_TARGET, the server logs
// it at startup, and Health shows it with an age. Never report a mirror number as
// live — that is the whole class of bug src/model/fieldAssumptions.js exists for.

// The clone writes to the mirror by definition, so it opts into the write guard in
// src/db.js before anything imports the pool.
process.env.WORKHUB_MIRROR_WRITES = '1'

import { execFileSync } from 'node:child_process'
import pg from 'pg'

const NEON = process.env.DATABASE_URL
const LOCAL = process.env.DATABASE_URL_LOCAL || 'postgres://localhost:5432/workhub'
const dryRun = process.argv.includes('--dry')

if (!NEON) {
  console.error('DATABASE_URL is not set - run via `npm run db:mirror` so .env.local loads.')
  process.exit(1)
}
// ⚠️ Guard against the catastrophic typo. This script DROPS and recreates its target,
// so it must be impossible to point at Neon by accident.
if (/neon\.tech|\.neon\./i.test(LOCAL)) {
  console.error('DATABASE_URL_LOCAL points at a Neon host. This script DROPS its target - refusing.')
  process.exit(1)
}
const localName = new URL(LOCAL).pathname.replace(/^\//, '') || 'workhub'
const localAdmin = LOCAL.replace(/\/[^/]*$/, '/postgres')
const ident = (n) => '"' + String(n).replace(/"/g, '""') + '"'

const t0 = Date.now()
console.log(`\n  MIRROR NEON -> LOCAL\n  ${'-'.repeat(72)}`)
console.log(`  target: ${localName} (local)`)
if (dryRun) { console.log('  --dry: nothing read or written.\n'); process.exit(0) }

// ⚠️ NOT pg_dump. Neon runs Postgres 18 and the local client is 17, and pg_dump
// refuses to read a newer server. The wire protocol has no such restriction, so the
// data is copied with ordinary queries and the SCHEMA comes from db/schema.sql - the
// file this repo already calls canonical. That is better than a dump anyway: the
// mirror is then guaranteed to match what `npm run migrate` produces, and any drift
// between schema.sql and Neon shows up as a skipped column rather than silently.

// 1. Recreate the local database, so a table or column dropped upstream cannot leave
//    a stale artefact behind. A mirror that is MOSTLY current is worse than one that
//    is plainly a full copy.
const admin = new pg.Client({ connectionString: localAdmin })
try {
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${ident(localName)} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${ident(localName)}`)
  await admin.end()
  console.log('  ok  local database recreated')
} catch (e) {
  console.error(`  ERR could not recreate ${localName}: ${e.message}`)
  console.error('      Is local Postgres running?  pg_ctl -D /usr/local/var/postgresql@17 status')
  process.exit(1)
}

// 2. Canonical schema, applied locally (costs nothing).
try {
  execFileSync('psql', ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=0', '-f', 'db/schema.sql', LOCAL],
    { stdio: ['ignore', 'ignore', 'pipe'] })
} catch { /* schema.sql is idempotent DDL; warnings are expected, absence of tables is not */ }
const local = new pg.Client({ connectionString: LOCAL })
await local.connect()
const { rows: made } = await local.query(
  `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`)
if (!made[0].n) {
  console.error('  ERR db/schema.sql created no tables locally.')
  process.exit(1)
}
console.log(`  ok  schema applied (${made[0].n} tables)`)

// 3. Copy the data. This is the ONLY network read, one pass per table.
const neon = new pg.Client({ connectionString: NEON })
await neon.connect()
// ⚠️ Every value is round-tripped through its TEXT representation, and this is not
// incidental. node-pg parses a json/jsonb column into a JS object, and passing that
// object back as a parameter re-serialises it as a Postgres ARRAY literal for array
// types — which produced `Expected ":", but found ","` on the first real run. Text is
// the one representation every Postgres type round-trips through faithfully, so the
// SELECT casts to text and the INSERT casts back to the column's exact declared type
// (`format_type` gives `jsonb`, `text[]`, `character varying(50)` verbatim).
const colsOf = async (client, table) => (await client.query(
  `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [table])).rows

const { rows: tables } = await neon.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)

// FK order across ~40 tables is not worth deriving, so checks are suspended for the
// load. Local only, and the data already satisfied them on Neon.
let fkOff = true
try { await local.query(`SET session_replication_role = 'replica'`) } catch {
  fkOff = false
  console.log('  ..  could not suspend FK checks (not superuser) - some tables may skip rows')
}

let totalRows = 0, totalBytes = 0
const skipped = []
const failed = []
for (const { table_name: t } of tables) {
  const [nc, lc] = await Promise.all([colsOf(neon, t), colsOf(local, t)])
  const localByName = new Map(lc.map((c) => [c.name, c]))
  if (!lc.length) { skipped.push(`${t} (table not in schema.sql)`); continue }
  const cols = nc.filter((c) => localByName.has(c.name))
  if (!cols.length) { skipped.push(`${t} (no shared columns)`); continue }
  for (const c of nc) if (!localByName.has(c.name)) skipped.push(`${t}.${c.name} (column not in schema.sql)`)

  const selectList = cols.map((c) => `${ident(c.name)}::text`).join(',')
  const { rows } = await neon.query(`SELECT ${selectList} FROM ${ident(t)}`)
  totalBytes += Buffer.byteLength(JSON.stringify(rows))
  if (!rows.length) continue

  const BATCH = 400
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const params = []
      const tuples = chunk.map((r) => '(' + cols.map((c) => {
        params.push(r[c.name])
        // Cast back to the LOCAL column's declared type, not Neon's, so a type that
        // differs between the two fails loudly here instead of silently storing text.
        return `$${params.length}::${localByName.get(c.name).type}`
      }).join(',') + ')')
      await local.query(
        `INSERT INTO ${ident(t)} (${cols.map((c) => ident(c.name)).join(',')})
         VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params)
    }
    totalRows += rows.length
  } catch (e) {
    // One bad table must not abandon the whole mirror - report it and carry on, so
    // the result is a usable mirror with a named gap rather than nothing at all.
    failed.push(`${t}: ${e.message.slice(0, 90)}`)
  }
}
try { await local.query(`SET session_replication_role = 'origin'`) } catch { /* never set */ }
await neon.end()

// ⚠️ RESET EVERY SEQUENCE. Copying explicit id values leaves each local sequence at 1,
// so the very first insert collides on the primary key. Caught immediately on the
// first real start: `duplicate key value violates unique constraint
// "quest_task_activity_pkey" · Key (id)=(1) already exists`. Without this the mirror
// is read-only in practice, and every surface that records anything is broken — which
// is precisely the kind of half-working state that wastes a session.
const { rows: seqs } = await local.query(
  `SELECT c.relname AS tbl, a.attname AS col,
          pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL`)
let seqFixed = 0
for (const { tbl, col, seq } of seqs) {
  // is_called=false with COALESCE(max,0)+1 so an empty table starts at 1 rather than
  // handing out 1 twice.
  await local.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${ident(col)}) FROM ${ident(tbl)}), 0) + 1, false)`, [seq])
  seqFixed++
}

// 4. Stamp it. An unstamped mirror is indistinguishable from a live database, which is
//    precisely the failure this feature must not cause.
await local.query(
  `INSERT INTO sync_meta (key, value, updated_at) VALUES ('mirror_cloned_at', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [new Date().toISOString()])
await local.end()

console.log(`  ok  ${totalRows.toLocaleString()} rows across ${tables.length} tables`)
console.log(`  ok  ${(totalBytes / 1048576).toFixed(1)} MB read from Neon (one-off)`)
console.log(`  ok  ${seqFixed} sequence(s) advanced past the copied ids`)
if (skipped.length) {
  console.log(`  ..  ${skipped.length} skipped - schema.sql is behind Neon:`)
  for (const x of skipped.slice(0, 10)) console.log(`        ${x}`)
}
// ⚠️ Named loudly. A mirror with a silently empty table is the stale-number trap in
// its purest form: the app would render 0 and look perfectly healthy.
if (failed.length) {
  console.log(`  ERR ${failed.length} table(s) DID NOT COPY - treat these as empty locally:`)
  for (const x of failed) console.log(`        ${x}`)
}
console.log(`  ${'-'.repeat(72)}`)
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
console.log('  To develop against it, add to .env.local:')
console.log('      WORKHUB_DB=mirror')
console.log(`      DATABASE_URL_LOCAL=${LOCAL}`)
console.log('  Comment out WORKHUB_DB to go back to Neon. The server prints which one it')
console.log('  is using at startup, and Health shows it with an age.\n')
process.exit(0)
