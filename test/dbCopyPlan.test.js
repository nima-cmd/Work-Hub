import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDPOINTS, SESSION_SETUP, columnHashSql, describeEndpoint, guardCopy, hostKind, ident,
  identityOf, insertParams, insertSql, planTable, resolveEndpoint, selectList, tableHashSql,
  verifyBasisLabel, verifyVerdict,
} from '../src/model/dbCopyPlan.js'

// ⚠️ WHAT THIS FILE IS FOR. `db-mirror.js` DROPS its target, and that was safe only
// because the target was a disposable clone. db-copy points at a database we intend to
// KEEP, so the guards are the part that must not be discovered wrong afterwards.

const NEON = 'postgres://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/workhub?sslmode=require'
const LOCAL = 'postgres://localhost:5432/workhub'
const DO = 'postgresql://doadmin:secret@db-postgresql-nyc3-1234-do-user-9-0.k.db.ondigitalocean.com:25060/defaultdb'

// ── endpoints ───────────────────────────────────────────────────────────────

test('hosts are classified by host alone', () => {
  assert.equal(hostKind(NEON), 'neon')
  assert.equal(hostKind(LOCAL), 'local')
  assert.equal(hostKind('postgres://127.0.0.1:5432/workhub'), 'local')
  assert.equal(hostKind(DO), 'digitalocean')
  assert.equal(hostKind('postgres://db.example.com/x'), 'other')
  assert.equal(hostKind('not a url'), 'other')
})

// ⚠️ This string is printed to stdout and pasted into PRs. A leaked password would be
// this feature's worst possible side effect.
test('a described endpoint never contains the password', () => {
  for (const url of [NEON, DO]) {
    const d = describeEndpoint(url)
    assert.ok(!d.includes('secret'), d)
    assert.ok(!d.includes('p@'), d)
    assert.ok(!d.includes('doadmin'), d)
  }
  assert.equal(describeEndpoint(DO), 'db-postgresql-nyc3-1234-do-user-9-0.k.db.ondigitalocean.com/defaultdb')
  assert.equal(describeEndpoint(LOCAL), 'localhost/workhub')
})

test('named endpoints resolve out of the environment', () => {
  const env = { DATABASE_URL: NEON, DATABASE_URL_LOCAL: LOCAL, DATABASE_URL_DO: DO }
  assert.equal(resolveEndpoint('neon', env).url, NEON)
  assert.equal(resolveEndpoint('mirror', env).url, LOCAL)
  assert.equal(resolveEndpoint('local', env).url, LOCAL)
  assert.equal(resolveEndpoint('DO', env).kind, 'digitalocean')
  assert.match(resolveEndpoint('staging', env).error, /unknown endpoint/)
  assert.match(resolveEndpoint('do', {}).error, /DATABASE_URL_DO is not set/)
  assert.match(resolveEndpoint(null, env).error, /no endpoint/)
})

test('a raw url is accepted without an env var', () => {
  const r = resolveEndpoint(DO, {})
  assert.equal(r.url, DO)
  assert.equal(r.envVar, null)
  assert.equal(r.kind, 'digitalocean')
})

test('mirror and local are the same endpoint on purpose', () => {
  assert.equal(ENDPOINTS.mirror, ENDPOINTS.local)
})

// ── the guards ──────────────────────────────────────────────────────────────

test('a legitimate copy is allowed', () => {
  const env = { DATABASE_URL_LOCAL: LOCAL, DATABASE_URL_DO: DO }
  assert.deepEqual(guardCopy({ from: resolveEndpoint('mirror', env), to: resolveEndpoint('do', env) }), [])
})

// ⚠️ THE RULE WITH NO OVERRIDE. Neon holds the only copy of the app-owned rows written
// after the mirror was cloned (2026-08-17 16:52) — five orders' departure confirmations
// among them. This script empties its target.
test('Neon can never be the TARGET, and there is no flag for it', () => {
  const env = { DATABASE_URL: NEON, DATABASE_URL_LOCAL: LOCAL }
  const r = guardCopy({ from: resolveEndpoint('mirror', env), to: resolveEndpoint('neon', env) })
  assert.equal(r.length, 1)
  assert.match(r[0], /TARGET is Neon/)
  // No argument shape lifts it.
  for (const extra of [{ force: true }, { allowNeon: true }, { truncate: true }]) {
    const again = guardCopy({ from: resolveEndpoint('mirror', env), to: resolveEndpoint('neon', env), ...extra })
    assert.match(again[0], /TARGET is Neon/)
  }
})

test('Neon is fine as the SOURCE', () => {
  const env = { DATABASE_URL: NEON, DATABASE_URL_DO: DO }
  assert.deepEqual(guardCopy({ from: resolveEndpoint('neon', env), to: resolveEndpoint('do', env) }), [])
})

test('copying a database onto itself is refused', () => {
  const env = { DATABASE_URL_LOCAL: LOCAL }
  const r = guardCopy({ from: resolveEndpoint('mirror', env), to: resolveEndpoint('local', env) })
  assert.match(r[0], /same database/)
})

// The same server, a DIFFERENT database, is a legitimate copy — and it is how this
// script gets tested without a cloud credential.
test('same host, different database, is allowed', () => {
  const r = guardCopy({
    from: resolveEndpoint('postgres://localhost:5432/workhub', {}),
    to: resolveEndpoint('postgres://localhost:5432/workhub_copytest', {}),
  })
  assert.deepEqual(r, [])
})

test('identity ignores credentials and query strings but not the database name', () => {
  assert.equal(identityOf('postgres://a:b@h.com:5432/db?sslmode=require'), identityOf('postgres://c:d@h.com/db'))
  assert.notEqual(identityOf('postgres://h.com/db'), identityOf('postgres://h.com/db2'))
})

test('an unresolved endpoint refuses before any connection is attempted', () => {
  const r = guardCopy({ from: resolveEndpoint('do', {}), to: resolveEndpoint('mirror', {}) })
  assert.equal(r.length, 2)
  assert.match(r[0], /^source: /)
  assert.match(r[1], /^target: /)
})

// ── the plan ────────────────────────────────────────────────────────────────

const cols = (...names) => names.map((n) => ({ name: n, type: 'text' }))

test('only shared columns cross, typed by the TARGET', () => {
  const plan = planTable({
    table: 'orders',
    sourceCols: [{ name: 'so', type: 'character varying(50)' }, { name: 'extra', type: 'text' }],
    targetCols: [{ name: 'so', type: 'text' }, { name: 'unused', type: 'integer' }],
  })
  assert.equal(plan.skip, null)
  assert.deepEqual(plan.cols, [{ name: 'so', type: 'text' }])
  assert.deepEqual(plan.skippedColumns, ['orders.extra'])
})

test('a table absent from the target is skipped by name, not silently', () => {
  const plan = planTable({ table: 'ghost', sourceCols: cols('a'), targetCols: [] })
  assert.match(plan.skip, /not in the target schema/)
  assert.deepEqual(plan.cols, [])
})

test('a table with no overlapping columns is skipped', () => {
  const plan = planTable({ table: 't', sourceCols: cols('a'), targetCols: cols('b') })
  assert.match(plan.skip, /no shared columns/)
})

// ⚠️ THE MIRROR'S HARDEST-WON LESSON. node-pg parses jsonb into a JS object and passing
// it back re-serialises an array type as a Postgres ARRAY literal. TEXT is the one
// representation every type round-trips through.
test('values are selected as text and cast back to the target type', () => {
  const c = [{ name: 'payload', type: 'jsonb' }, { name: 'tags', type: 'text[]' }]
  assert.equal(selectList(c), '"payload"::text, "tags"::text')
  assert.equal(
    insertSql('t', c, 2),
    'INSERT INTO "t" ("payload","tags") VALUES ($1::jsonb,$2::text[]),($3::jsonb,$4::text[]) ON CONFLICT DO NOTHING',
  )
})

test('params are flattened row-major to match the placeholders', () => {
  const c = cols('a', 'b')
  assert.deepEqual(insertParams(c, [{ a: '1', b: '2' }, { a: '3', b: '4' }]), ['1', '2', '3', '4'])
})

test('an identifier with a quote in it cannot break out', () => {
  assert.equal(ident('we"ird'), '"we""ird"')
})

// ── verification ────────────────────────────────────────────────────────────

test('matching counts and hashes pass', () => {
  const v = verifyVerdict([
    { table: 'a', source: 10, target: 10, sourceHash: 'x', targetHash: 'x' },
    { table: 'b', source: 0, target: 0 },
  ])
  assert.equal(v.ok, true)
  assert.equal(v.checked, 2)
  assert.equal(v.matched, 2)
})

test('a row-count gap is the finding, and the hash is not consulted', () => {
  const v = verifyVerdict([{ table: 'a', source: 10, target: 9, sourceHash: 'x', targetHash: 'y' }])
  assert.equal(v.ok, false)
  assert.equal(v.findings[0].kind, 'row-count')
  assert.match(v.findings[0].detail, /source 10 rows, target 9/)
})

// ⚠️ THE REASON THE HASH EXISTS AT ALL. Two tables can hold the same NUMBER of
// different rows, and a count-only check would call that a successful migration.
test('same count, different content, is caught and the column is NAMED', () => {
  const v = verifyVerdict([{
    table: 'orders',
    source: 294,
    target: 294,
    sourceHash: 'aaa',
    targetHash: 'bbb',
    columns: [
      { name: 'so_number', sourceHash: 'k', targetHash: 'k' },
      { name: 'ship_date', sourceHash: 'p', targetHash: 'q' },
    ],
  }])
  assert.equal(v.ok, false)
  assert.equal(v.findings[0].kind, 'content')
  assert.deepEqual(v.findings[0].columns, ['ship_date'])
  assert.match(v.findings[0].detail, /differing values in: ship_date/)
})

test('content differing with no per-column detail still fails loudly', () => {
  const v = verifyVerdict([{ table: 't', source: 1, target: 1, sourceHash: 'a', targetHash: 'b' }])
  assert.equal(v.ok, false)
  assert.match(v.findings[0].detail, /different content/)
})

// ⚠️ A SKIPPED TABLE IS NOT AN AGREEING TABLE. It must not be counted as verified, and
// it must not fail the run either — schema.sql being behind the source is a known,
// reported condition, not a broken copy.
test('a skipped table is reported as skipped and excluded from the tally', () => {
  const v = verifyVerdict([
    { table: 'a', source: 5, target: 5, sourceHash: 'x', targetHash: 'x' },
    { table: 'ghost', skip: 'table not in the target schema' },
  ])
  assert.equal(v.ok, true)
  assert.equal(v.checked, 1)
  assert.equal(v.findings.filter((f) => f.kind === 'skipped').length, 1)
})

test('nothing to verify is not a pass by accident', () => {
  const v = verifyVerdict([])
  assert.equal(v.checked, 0)
  assert.equal(v.matched, 0)
})

// ── the hash SQL itself ─────────────────────────────────────────────────────

// ⚠️ chr(0) is ILLEGAL in Postgres ("null character not permitted") — using it would
// have made every hash query an error rather than a comparison. Caught by running it.
test('the NULL marker is not chr(0)', () => {
  const sql = tableHashSql('t', cols('a', 'b'))
  assert.ok(!sql.includes('chr(0)'), sql)
  assert.ok(sql.includes('chr(1)'))
})

test('the table hash is order-independent and covers every shared column', () => {
  const sql = tableHashSql('orders', cols('so', 'dc'))
  assert.match(sql, /ORDER BY h/)
  assert.ok(sql.includes('"so"::text'))
  assert.ok(sql.includes('"dc"::text'))
  assert.ok(sql.includes('chr(31)'))     // a separator, so 'ab'+'c' cannot equal 'a'+'bc'
})

test('the per-column hash aliases each column by name', () => {
  const sql = columnHashSql('orders', cols('so', 'dc'))
  assert.ok(sql.includes('AS "so"'))
  assert.ok(sql.includes('AS "dc"'))
})

// ⚠️ Without this both sides render timestamptz in their own session zone and identical
// rows hash differently — a false alarm on a check whose only value is that a mismatch
// means something.
test('both sides are pinned to the same rendering', () => {
  assert.ok(SESSION_SETUP.some((s) => /TimeZone = 'UTC'/.test(s)))
  assert.ok(SESSION_SETUP.some((s) => /DateStyle/.test(s)))
  assert.ok(SESSION_SETUP.some((s) => /extra_float_digits/.test(s)))
})

// ⚠️ THE DEFECT THIS ENFORCES. The summary line hardcoded "(rows + content)" and
// printed it under --counts-only as well, so a run that never hashed a single row
// reported "50/50 tables verified identical (rows + content)". A counter that claims
// more than it counted is exactly what check:counters exists to catch.
test('the summary never claims content was compared when it was not', () => {
  assert.match(verifyBasisLabel(true), /content NOT compared/)
  assert.ok(!/rows \+ content/.test(verifyBasisLabel(true)))
  assert.equal(verifyBasisLabel(false), 'rows + content')
})
