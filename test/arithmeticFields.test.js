import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeOffsets, describeFinding, columnPairs, isExpected, isExpectedConstant,
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
