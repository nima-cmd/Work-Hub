import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeOffsets, analyzeTally, describeFinding, columnPairs, isExpected, isExpectedConstant,
  unrecorded, vanished, EXPECTED_DERIVED, MIN_ROWS,
} from '../src/model/arithmeticFields.js'

// ⚠️ THE BUG THIS EXISTS FOR. `transaction.shipdate` was `trandate + 28` on 1,234 of
// 1,254 sales orders (+30 on 18, +29 on 2) — a NetSuite default lead time nobody
// types. The app read it as a ship window and raised 51 flags off it, and
// `check:counters` was GREEN the whole time.
//
// The reason a distinctness sweep could never catch it is the first test below.

const realShipdate = () => [
  ...Array(1234).fill(28), ...Array(18).fill(30), ...Array(2).fill(29),
]

test('the real shipdate distribution is caught', () => {
  const r = analyzeOffsets(realShipdate())
  assert.equal(r.verdict, 'derived')
  assert.equal(r.rows, 1254)
  assert.equal(r.top[0].offset, 28)
  assert.equal(r.covered, 1254)
})

// ⚠️ THE POINT. A distinctness check asks "does this column have more than one
// value?" — and shipdate had 1,254 rows spread over more than a year of dates. It
// looked completely alive. The offsets are what collapse to three values.
test('the same column looks alive to a distinctness check', () => {
  const dates = realShipdate().map((off, i) => `2026-01-01+${i}+${off}`)
  assert.ok(new Set(dates).size > 1000)   // a distinctness sweep sees nothing wrong
  assert.equal(analyzeOffsets(realShipdate()).verdict, 'derived')
})

test('genuinely observed dates are not called derived', () => {
  // A real scatter: a few hundred rows spread over many offsets, none dominant.
  const scattered = Array.from({ length: 400 }, (_, i) => i % 37)
  assert.equal(analyzeOffsets(scattered).verdict, 'observed')
})

test('a formula hiding behind a long tail is still caught', () => {
  // 96% on one offset, the rest scattered — still a formula with exceptions.
  const offsets = [...Array(960).fill(28), ...Array.from({ length: 40 }, (_, i) => i)]
  assert.equal(analyzeOffsets(offsets).verdict, 'derived')
})

// ⚠️ A checker that fires on three rows is a checker nobody trusts. Three rows 28
// days apart is a coincidence, not a pattern.
test('too few rows is a non-answer, never a finding', () => {
  assert.equal(analyzeOffsets(Array(MIN_ROWS - 1).fill(28)).verdict, 'too_few')
  assert.equal(analyzeOffsets([]).verdict, 'too_few')
  assert.equal(analyzeOffsets(Array(MIN_ROWS).fill(28)).verdict, 'derived')
})

// ⚠️ Subtracting two CONSTANT columns yields a constant, which the rule would report
// as a formula. Live: ups_shipment_cost.store_id reads as insurance_cost + 123781 on
// all 33,253 rows — and the truth is insurance_cost is 0 on every row. That is the
// is_ats shape (false on all 282 orders), and calling it arithmetic buries it.
test('two dead columns are reported as constant, never as a formula', () => {
  const r = analyzeOffsets(Array(500).fill(123781), { distinctA: 2, distinctB: 1 })
  assert.equal(r.verdict, 'constant')
  assert.equal(r.deadB, true)
})

test('an exact copy is its own verdict — a duplicate can drift and be believed', () => {
  const r = analyzeOffsets(Array(190).fill(0), { distinctA: 90, distinctB: 90 })
  assert.equal(r.verdict, 'copy')
  assert.match(
    describeFinding({ table: 'fulfillments', column: 'if_date', basis: 'actual_ship_date', result: r }),
    /exact copy .* on all 190 rows/)
})

test('the sentence names the basis, because that is the field to go and read', () => {
  const r = analyzeOffsets(realShipdate())
  const s = describeFinding({ table: 'orders', column: 'ship_date', basis: 'start_date', result: r })
  assert.match(s, /DERIVED, not observed/)
  assert.match(s, /really reading start_date/)
  assert.match(s, /\+28 \(1234\)/)
})

test('pairs are unordered and never self-paired', () => {
  assert.deepEqual(columnPairs(['a', 'b', 'c']), [['a', 'b'], ['a', 'c'], ['b', 'c']])
  assert.deepEqual(columnPairs(['a']), [])
})

// ── the baseline is the actual assertion ────────────────────────────────────────
//
// ⚠️ The hope was "a finding here is a bug". That holds for dates and NOT for
// numbers — swept live, the rule also finds that most open PO lines have received
// nothing. Failing on those would make the check red forever, and a check that is
// always red is a check nobody reads. So what is asserted is CHANGE.

test('a recorded finding passes; an unrecorded one is the failure', () => {
  const known = { table: 'orders', column: 'ship_date', basis: 'start_date' }
  const novel = { table: 'invoices', column: 'due_date', basis: 'trandate' }
  const u = unrecorded({ findings: [known, novel], constantFindings: [] })
  assert.deepEqual(u.derived, [novel])
})

test('the baseline matches in either direction, so a flipped pair is not "new"', () => {
  assert.ok(isExpected('orders', 'start_date', 'ship_date'))
  assert.ok(isExpected('orders', 'ship_date', 'start_date'))
  assert.equal(isExpected('orders', 'ship_date', 'cancel_date'), null)
})

test('a recorded constant column is known by name', () => {
  assert.ok(isExpectedConstant('ups_shipment_cost', 'insurance_cost'))
  assert.equal(isExpectedConstant('orders', 'is_ats'), null)
})

// ⚠️ A stale allowlist is how a checker quietly stops checking. If ship_date ever
// STOPS being derived, that is the answer to a question still open with Nima —
// someone started typing real ship windows — and it must be said out loud.
test('a baseline entry the sweep no longer finds is reported, not ignored', () => {
  const v = vanished({ findings: [], constantFindings: [] })
  assert.equal(v.derived.length, EXPECTED_DERIVED.length)
  assert.ok(v.derived.some((e) => e.table === 'orders' && e.column === 'ship_date'))
})

test('every baseline entry carries a reason — an unexplained exemption is a hole', () => {
  for (const e of EXPECTED_DERIVED) {
    assert.ok(e.why && e.why.length > 20, `${e.table}.${e.column} needs a real reason`)
  }
})

// ── the tally entry point, and the trap it introduces ───────────────────────────
//
// ⚠️ WHY THIS EXISTS AT ALL: network cost. The sweep's first cut pulled one row per
// table row and tallied in JavaScript — 964,337 rows out of `ups_shipment_cost` alone
// (29 column pairs x 33,253 rows) on EVERY check:counters run, to compute a
// distribution that is three numbers. The whole database is 26 MB. Neon bills public
// network transfer, and that one script was moving a large multiple of the biggest
// table across the wire for nothing.

test('a full tally gives the same verdict as the raw offsets it came from', () => {
  const raw = [...Array(1234).fill(28), ...Array(18).fill(30), ...Array(2).fill(29)]
  const tallied = analyzeTally([
    { offset: 28, count: 1234 }, { offset: 30, count: 18 }, { offset: 29, count: 2 },
  ])
  const direct = analyzeOffsets(raw)
  assert.equal(tallied.verdict, direct.verdict)
  assert.equal(tallied.rows, direct.rows)
  assert.deepEqual(tallied.top, direct.top)
})

// ⚠️ THE TRAP. Asking Postgres for only the TOP 3 offsets means the tally no longer
// sums to the row count. Without explicit totals the rule divides 3 offsets by 3
// offsets, gets 100%, and calls EVERY high-cardinality pair derived — turning a cost
// optimisation into a false-positive generator.
test('a TRUNCATED tally without totals would read as 100% — totals prevent it', () => {
  const top3 = [{ offset: 1, count: 20 }, { offset: 2, count: 15 }, { offset: 3, count: 10 }]
  // What the bug would have looked like: 45 of 45 rows, three offsets, "derived".
  assert.equal(analyzeTally(top3).verdict, 'derived')
  // The truth: those 45 rows are 45 of 4,000, so the pair is plainly observed.
  const honest = analyzeTally(top3, { totalRows: 4000, distinctOffsets: 900 })
  assert.equal(honest.verdict, 'observed')
  assert.equal(honest.rows, 4000)
})

// ⚠️ With a truncated tally, `sorted.length` can never exceed the LIMIT, so the
// copy test ("exactly one distinct offset, and it is zero") needs the real distinct
// count from the database or every zero-dominant pair reads as an exact copy.
test('copy vs derived survives truncation, via the real distinct count', () => {
  const zeroDominant = [{ offset: 0, count: 32502 }, { offset: 1, count: 750 }]
  const notACopy = analyzeTally(zeroDominant, { totalRows: 33253, distinctOffsets: 3 })
  assert.equal(notACopy.verdict, 'derived')   // ups_shipment_cost.ship_date, live

  const trueCopy = analyzeTally([{ offset: 0, count: 191 }], { totalRows: 191, distinctOffsets: 1 })
  assert.equal(trueCopy.verdict, 'copy')      // fulfillments.if_date, live
})

test('an empty tally is too_few, never a finding', () => {
  assert.equal(analyzeTally([], { totalRows: 0, distinctOffsets: 0 }).verdict, 'too_few')
})
