// scripts/db-copy.js — copy a whole Work-Hub database from one Postgres to another,
// and PROVE row-for-row that it arrived.
//
//   npm run db:copy -- --from=mirror --to=do
//   npm run db:copy -- --from=mirror --to=do --dry
//   npm run db:copy -- --from=neon --to=do --truncate
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// `db-mirror.js` answered "how do we stop paying Neon's 5 GB/month transfer cap during
// development" by cloning Neon into local Postgres. It is hardcoded Neon -> local, and
// it DROPS its target, because a mirror is a disposable read replica.
//
// This is the other job: moving to a database we intend to KEEP. Neon suspended on
// 2026-08-18 and DigitalOcean Managed Postgres does not meter database transfer at
// all, so the copy that used to be a workaround becomes a migration. Two things change
// once the target is permanent:
//
//   1. It cannot DROP DATABASE. A managed database is handed to you already created,
//      often as `defaultdb`, and you may not own it. So the schema is applied over the
//      top and the target is EMPTIED explicitly, only when asked.
//   2. "It looked like it worked" stops being good enough. Every table is verified by
//      row count AND by an md5 over every shared column, computed identically on both
//      sides. A mismatch names the column.
//
// ⚠️ THE TARGET MAY NEVER BE NEON — see guardCopy() in src/model/dbCopyPlan.js. Neon
// currently holds the only copy of the app-owned rows written after the mirror was
// cloned (2026-08-17 16:52). This script empties its target; it must not be pointable
// at the one record of that.
//
// ⚠️ STILL ONE WAY, and still not a sync. It copies a snapshot. Two writable copies of
// bol_registry means conflict resolution on a number that must never be reused.

import { execFileSync } from 'node:child_process'
import pg from 'pg'
import {
  ENDPOINTS, SESSION_SETUP, columnHashSql, guardCopy, ident, insertParams, insertSql,
  planTable, resolveEndpoint, selectList, tableHashSql, verifyBasisLabel, verifyVerdict,
} from '../src/model/dbCopyPlan.js'

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const has = (name) => process.argv.includes(`--${name}`)

const dryRun = has('dry')
const doTruncate = has('truncate')
const skipSchema = has('no-schema')
const countsOnly = has('counts-only')
// ⚠️ Re-prove a copy that already ran, without touching either side. This is the mode
// you want the morning after a migration, or before pointing the app at a target.
const verifyOnly = has('verify-only')
const BATCH = Number(arg('batch') || 400)

const fromArg = arg('from')
const toArg = arg('to')
const from = resolveEndpoint(fromArg, process.env)
const to = resolveEndpoint(toArg, process.env)

const t0 = Date.now()
console.log(`\n  DB COPY\n  ${'-'.repeat(74)}`)
console.log(`  from:  ${from.error ? '(unresolved)' : from.label}  [${from.name}]`)
console.log(`  to:    ${to.error ? '(unresolved)' : to.label}  [${to.name}]`)

const refusals = guardCopy({ from, to })
if (refusals.length) {
  console.error('')
  for (const r of refusals) console.error(`  ERR ${r}`)
  console.error(`\n      usage: npm run db:copy -- --from=<endpoint> --to=<endpoint> [--truncate] [--dry]`)
  console.error(`      endpoints: ${Object.keys(ENDPOINTS).join(' · ')} (or a full postgres:// url)\n`)
  process.exit(1)
}

// The source is opened read-only in practice: nothing below issues a write against it.
const src = new pg.Client({ connectionString: from.url })
const dst = new pg.Client({ connectionString: to.url })
// ⚠️ The target is a real database the app will use. If it is the local mirror, the
// write guard in src/db.js does not apply here (this script owns its own clients), but
// say so, because a copy INTO the mirror is the direction db:mirror already owns.
if (to.kind === 'local') console.log('  ..  target is local — note that Neon -> local is db:mirror\'s job')

try {
  await src.connect()
} catch (e) {
  console.error(`\n  ERR cannot read the source (${from.label}): ${e.message}`)
  if (/quota|suspend/i.test(e.message)) console.error('      Neon is suspended — copy from the mirror instead: --from=mirror')
  process.exit(1)
}
try {
  await dst.connect()
} catch (e) {
  console.error(`\n  ERR cannot reach the target (${to.label}): ${e.message}`)
  console.error(`      Check ${to.envVar || 'the url'} — and that this machine's IP is allowed to connect.`)
  process.exit(1)
}
// Identical rendering on both sides, or the content hashes compare noise.
for (const stmt of SESSION_SETUP) { await src.query(stmt); await dst.query(stmt) }

const colsOf = async (client, table) => (await client.query(
  `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [table])).rows

const tablesOf = async (client) => (await client.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map((r) => r.table_name)

const srcTables = await tablesOf(src)
console.log(`  ok  source holds ${srcTables.length} tables`)

if (dryRun) {
  // A dry run must answer "would every table land" without reading the data or
  // writing anything. ⚠️ AND IT MUST NOT REPORT ITS OWN ORDERING AS A FINDING: on a
  // fresh target nothing exists yet, because db/schema.sql has not been applied — the
  // first version of this said "50 tables would be skipped" about a copy that would
  // have worked perfectly. An empty target is a different answer, not fifty problems.
  const dstNow = await tablesOf(dst)
  let rows = 0
  for (const t of srcTables) {
    const { rows: n } = await src.query(`SELECT COUNT(*)::bigint AS n FROM ${ident(t)}`)
    rows += Number(n[0].n)
  }
  if (!dstNow.length) {
    console.log(`  ..  the target has NO tables yet — db/schema.sql would create them.`)
    console.log(`      A dry run cannot compare columns against a schema that is not there,`)
    console.log(`      so this only reports the size of the job.`)
    console.log(`\n  --dry: ${rows.toLocaleString()} rows in ${srcTables.length} tables would be copied.`)
    console.log('  Nothing was written.\n')
    await src.end(); await dst.end()
    process.exit(0)
  }
  let missing = 0
  for (const t of srcTables) {
    const [sc, tc] = await Promise.all([colsOf(src, t), colsOf(dst, t)])
    const plan = planTable({ table: t, sourceCols: sc, targetCols: tc })
    if (plan.skip) { missing += 1; console.log(`  ..  ${t}: WOULD SKIP — ${plan.skip}`) }
    else if (plan.skippedColumns?.length) console.log(`  ..  ${t}: ${plan.skippedColumns.length} column(s) would not cross: ${plan.skippedColumns.join(', ')}`)
  }
  console.log(`\n  --dry: ${rows.toLocaleString()} rows in ${srcTables.length} tables, ${missing} table(s) would be skipped.`)
  console.log('  Nothing was written.\n')
  await src.end(); await dst.end()
  process.exit(missing ? 1 : 0)
}

// Steps 1-5 write to the target. --verify-only skips straight to step 6.
// 1. ⚠️ WAS THE TARGET ALREADY IN USE? Asked BEFORE the schema is applied, because
//    db/schema.sql SEEDS recurring_task_templates with 4 rows — so a target that has
//    had the schema applied is never "empty", and asking afterwards demanded
//    --truncate on a virgin database. The honest question is whether this target held
//    data before we touched it.
const preTables = verifyOnly ? [] : await tablesOf(dst)
const populated = []
for (const t of preTables) {
  const { rows: n } = await dst.query(`SELECT COUNT(*)::bigint AS n FROM ${ident(t)}`)
  if (Number(n[0].n) > 0) populated.push({ table: t, rows: Number(n[0].n) })
}
if (populated.length && !doTruncate) {
  console.error(`\n  ERR the target already holds data in ${populated.length} table(s):`)
  for (const p of populated.slice(0, 8)) console.error(`      ${p.table} (${p.rows.toLocaleString()} rows)`)
  if (populated.length > 8) console.error(`      ... and ${populated.length - 8} more`)
  console.error('\n      Copying on top would MERGE two databases row by row, and')
  console.error('      ON CONFLICT DO NOTHING makes the winner arbitrary. To empty it first:')
  console.error(`          npm run db:copy -- --from=${fromArg} --to=${toArg} --truncate\n`)
  await src.end(); await dst.end()
  process.exit(1)
}
if (populated.length) console.log(`  ..  --truncate: the target holds ${populated.length} populated table(s), emptying them`)

// 2. Canonical schema over the top. Idempotent DDL — this is how the target gets any
//    table or column that only exists in db/schema.sql.
if (!skipSchema && !verifyOnly) {
  try {
    execFileSync('psql', ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=0', '-f', 'db/schema.sql', to.url],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    const { rows: made } = await dst.query(
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`)
    console.log(`  ok  db/schema.sql applied to the target (${made[0].n} tables present)`)
  } catch (e) {
    console.error(`  ERR could not apply db/schema.sql: ${String(e.message).slice(0, 120)}`)
    process.exit(1)
  }
}

// 3. Empty every table, unconditionally. We have established the target held nothing
//    before this run (or --truncate said to discard it), and this also clears the rows
//    db/schema.sql seeds itself. ⚠️ THE POINT: after this the SOURCE is the only
//    authority on content. Leaving a seeded row in place would let ON CONFLICT DO
//    NOTHING silently keep the target's version of a row the source also has.
const dstTables = verifyOnly ? [] : await tablesOf(dst)
if (dstTables.length) {
  // One statement for every table, so FK order never has to be derived.
  await dst.query(`TRUNCATE ${dstTables.map(ident).join(', ')} CASCADE`)
  console.log(`  ok  target emptied (${dstTables.length} tables) — the source is the only authority now`)
}

// 4. Copy. FK checks are suspended for the load — the data already satisfied them at
//    the source, and deriving the order across ~49 tables is not worth it.
let fkOff = !verifyOnly
if (!verifyOnly) try { await dst.query(`SET session_replication_role = 'replica'`) } catch {
  fkOff = false
  console.log('  ..  could not suspend FK checks (not superuser) — copying in dependency-free order only')
}

const plans = []
let totalRows = 0
const skipped = []
const failed = []
for (const t of srcTables) {
  const [sc, tc] = await Promise.all([colsOf(src, t), colsOf(dst, t)])
  const plan = planTable({ table: t, sourceCols: sc, targetCols: tc })
  plans.push(plan)
  if (plan.skip) { skipped.push(`${t} (${plan.skip})`); continue }
  for (const c of plan.skippedColumns || []) skipped.push(`${c} (column not in the target)`)

  if (verifyOnly) continue
  const { rows } = await src.query(`SELECT ${selectList(plan.cols)} FROM ${ident(t)}`)
  if (!rows.length) continue
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      await dst.query(insertSql(t, plan.cols, chunk.length), insertParams(plan.cols, chunk))
    }
    totalRows += rows.length
  } catch (e) {
    // Named loudly, never swallowed: a silently empty table renders as 0 and looks healthy.
    failed.push(`${t}: ${String(e.message).slice(0, 100)}`)
  }
}
if (fkOff) { try { await dst.query(`SET session_replication_role = 'origin'`) } catch { /* fine */ } }
if (!verifyOnly) console.log(`  ok  ${totalRows.toLocaleString()} rows copied`)

// 5. Sequences past the copied ids. ⚠️ Without this the target is read-only in
//    practice — every sequence sits at 1 and the first insert collides on the primary
//    key. db-mirror learned this on `quest_task_activity_pkey` Key (id)=(1).
const { rows: seqs } = verifyOnly ? { rows: [] } : await dst.query(
  `SELECT c.relname AS tbl, a.attname AS col,
          pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL`)
for (const { tbl, col, seq } of seqs) {
  await dst.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${ident(col)}) FROM ${ident(tbl)}), 0) + 1, false)`, [seq])
}
if (!verifyOnly) console.log(`  ok  ${seqs.length} column-owned sequence(s) advanced past the copied ids`)

// 5b. ⚠️ STANDALONE SEQUENCES, WHICH STEP 5 CANNOT SEE. pg_get_serial_sequence only
//     ever returns a sequence OWNED BY A COLUMN (SERIAL / IDENTITY). A sequence made
//     with a bare CREATE SEQUENCE has no owning column, so it is invisible above —
//     and step 5 then prints a reassuring "N sequence(s) advanced" that excluded it.
//
//     ⚠️ THIS COST A REAL OUTAGE. `bol_number_seq` is the only standalone sequence in
//     this database (1 of 16), and it governs the one number in the whole app that
//     MUST NEVER BE REUSED. The DigitalOcean cutover left it at 1731240 while
//     bol_registry already held NB1731267, so BOL generation failed on
//     bol_registry_pkey — 27 collisions deep — until it was repaired by hand
//     (scripts/fix-bol-sequence.js). Nima hit it 2026-08-21.
//
//     There is no MAX(column) to chase for one of these, because nothing declares
//     which column consumes it. So the value is CARRIED FROM THE SOURCE, which is the
//     honest answer for a copy anyway: the target should continue where the source
//     left off.
const { rows: loose } = verifyOnly ? { rows: [] } : await dst.query(
  `SELECT c.relname AS seq
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
    WHERE c.relkind = 'S' AND d.objid IS NULL`)
let carried = 0
for (const { seq } of loose) {
  try {
    const { rows } = await src.query(
      `SELECT last_value, is_called FROM ${ident(seq)}`)
    if (!rows.length) continue
    await dst.query('SELECT setval($1, $2, $3)',
      [seq, String(rows[0].last_value), rows[0].is_called])
    carried++
  } catch (e) {
    // ⚠️ LOUD. A standalone sequence left at 1 makes its table read-only in practice,
    // and the whole point of this block is that silence here already cost us once.
    console.log(`  ⚠️  could not carry sequence ${seq} from the source: ${e.message}`)
    console.log(`      Fix it before generating anything that draws on it.`)
  }
}
if (!verifyOnly) {
  console.log(`  ok  ${carried} of ${loose.length} standalone sequence(s) carried from the source`)
  if (carried < loose.length) console.log(`  ⚠️  ${loose.length - carried} NOT carried — see above`)
}

// 6. VERIFY. Row counts on every table, plus an md5 over every shared column on both
//    sides. ⚠️ A count is not a comparison — two tables can hold the same number of
//    different rows, and this target is about to be believed.
console.log(`  ..  verifying ${plans.filter((p) => !p.skip).length} tables${countsOnly ? ' (counts only)' : ' (counts + content)'}`)
const results = []
for (const plan of plans) {
  if (plan.skip) { results.push({ table: plan.table, skip: plan.skip }); continue }
  const [sn, tn] = await Promise.all([
    src.query(`SELECT COUNT(*)::bigint AS n FROM ${ident(plan.table)}`),
    dst.query(`SELECT COUNT(*)::bigint AS n FROM ${ident(plan.table)}`),
  ])
  const row = { table: plan.table, source: Number(sn.rows[0].n), target: Number(tn.rows[0].n) }
  if (!countsOnly && row.source === row.target && row.source > 0) {
    const sql = tableHashSql(plan.table, plan.cols)
    const [sh, th] = await Promise.all([src.query(sql), dst.query(sql)])
    row.sourceHash = sh.rows[0].hash
    row.targetHash = th.rows[0].hash
    if (row.sourceHash !== row.targetHash) {
      // Only now, and only here: name the column instead of reporting a blob.
      const csql = columnHashSql(plan.table, plan.cols)
      const [sc2, tc2] = await Promise.all([src.query(csql), dst.query(csql)])
      row.columns = plan.cols.map((c) => ({
        name: c.name, sourceHash: sc2.rows[0][c.name], targetHash: tc2.rows[0][c.name],
      }))
    }
  }
  results.push(row)
}
const verdict = verifyVerdict(results)

await src.end()
await dst.end()

console.log(`  ${'-'.repeat(74)}`)
if (skipped.length) {
  console.log(`  ..  ${skipped.length} skipped — db/schema.sql is behind the source:`)
  for (const x of skipped.slice(0, 10)) console.log(`        ${x}`)
}
if (failed.length) {
  console.log(`  ERR ${failed.length} table(s) DID NOT COPY — treat these as empty on the target:`)
  for (const x of failed) console.log(`        ${x}`)
}
for (const f of verdict.findings.filter((x) => x.kind !== 'skipped')) {
  console.log(`  ERR ${f.table}: ${f.kind} — ${f.detail}`)
}
// ⚠️ The label must name what was ACTUALLY checked. --counts-only reported
// "verified identical (rows + content)" while never hashing a row — a counter
// claiming more than it did, which is CLAUDE.md's second counter-bug shape.
const basis = verifyBasisLabel(countsOnly)
console.log(`  ${verdict.ok && !failed.length ? 'ok ' : 'ERR'} ${verdict.matched}/${verdict.checked} tables verified identical (${basis})`)
if (countsOnly && verdict.ok) console.log('  ..  --counts-only cannot see a changed VALUE. Re-run without it before trusting this target.')
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
if (!verdict.ok || failed.length) {
  console.log('  ⚠️ DO NOT point the app at this target — the copy is not proven.\n')
  process.exit(1)
}
if (verifyOnly) { console.log('') ; process.exit(0) }
console.log(`  To use it, set in .env.local:   DATABASE_URL=${to.envVar ? '${' + to.envVar + '}' : '(the target url)'}`)
console.log('  ⚠️ This is a SNAPSHOT, not a sync. Anything written to the source after now')
console.log('     is not here. Neon stays as it is — it is the record of the departure gap.\n')
process.exit(0)
