import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSUMPTIONS, SHAPES, MECHANICAL, byShape, summarize, repeatFields,
} from '../src/model/fieldAssumptions.js'

// This register is history, and history is only useful if it is accurate. These
// tests protect the SHAPE of an entry, not its prose — an entry missing its measured
// cost or its "how it was caught" is the part that would have prevented the next one.

test('every entry answers all four questions', () => {
  for (const e of ASSUMPTIONS) {
    assert.ok(e.field, 'needs a field')
    assert.ok(e.assumed?.length > 10, `${e.field}: needs what we assumed`)
    assert.ok(e.actually?.length > 10, `${e.field}: needs what it actually is`)
    // ⚠️ A MEASURED consequence, never "could have been bad". Every entry here was
    // found on live data and the number is what makes it credible next time.
    assert.ok(e.cost?.length > 10, `${e.field}: needs a measured cost`)
    // The most transferable field in the register: the same method finds the next one.
    assert.ok(e.caught?.length > 10, `${e.field}: needs how it was caught`)
  }
})

test('every entry carries a known shape and a settled status', () => {
  const keys = new Set(Object.values(SHAPES).map((s) => s.key))
  for (const e of ASSUMPTIONS) {
    assert.ok(keys.has(e.shape), `${e.field}: unknown shape ${e.shape}`)
    assert.ok(['open', 'fixed', 'accepted'].includes(e.status), `${e.field}: ${e.status}`)
  }
})

// ⚠️ CLAUDE.md is where anyone starts. If the register grows a shape that file does
// not name, the two disagree and the file is the one people read.
test('the shape list is the one CLAUDE.md names — five mechanical-or-not categories plus the two from 2026-08-13', () => {
  assert.equal(Object.keys(SHAPES).length, 7)
  assert.ok(SHAPES.EXISTENCE && SHAPES.DEFAULT_AS_ANSWER)
})

test('only shapes a script can actually catch are marked mechanical', () => {
  for (const s of Object.values(SHAPES)) {
    assert.equal(!!s.mechanical, !!MECHANICAL[s.key], `${s.key}: mechanical flag and guard disagree`)
  }
})

// ⚠️ THE NUMBER THAT MATTERS. Most of these shapes have NO mechanical guard — they
// need a human to ask what a field is keyed on. A register that implied the checks
// covered everything would be worse than none.
test('the summary is honest about how much no script can catch', () => {
  const s = summarize()
  assert.equal(s.total, ASSUMPTIONS.length)
  assert.equal(s.guarded + s.unguarded, s.total)
  assert.ok(s.unguarded > 0, 'if this ever hits zero, a shape was mislabelled as mechanical')
})

// ⚠️ The strongest signal in the register. `packed_status` produced TWO unrelated
// bugs six weeks apart in two different surfaces, and the second was diagnosed from
// scratch because nobody had written the first one down. A field appearing twice
// means the first fix did not generalise.
test('a field that has bitten twice is surfaced as a repeat', () => {
  const repeats = repeatFields([
    { field: 'a.b', shape: 'x' }, { field: 'a.b (via c)', shape: 'y' }, { field: 'q.r', shape: 'z' },
  ])
  assert.deepEqual(repeats, [{ field: 'a.b', n: 2 }])
})

test('byShape covers every shape, including the empty ones', () => {
  const all = byShape()
  assert.equal(all.length, Object.keys(SHAPES).length)
  assert.equal(all.reduce((n, s) => n + s.count, 0), ASSUMPTIONS.length)
})

test('the arithmetic shape points at the check that catches it', () => {
  assert.equal(MECHANICAL.arithmetic, 'npm run check:fields')
  const arith = byShape().find((s) => s.key === 'arithmetic')
  assert.ok(arith.count >= 2)   // transaction.shipdate and fulfillments.actual_ship_date
})
