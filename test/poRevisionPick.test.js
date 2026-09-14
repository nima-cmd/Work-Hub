// test/poRevisionPick.test.js — built from the real PO 1236143 pair.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revisionPick, actionLine } from '../src/model/poRevisionPick.js'

// Orderful 1026743587, 2026-08-29, BEG01 = 00 Original. 320 units / 10 SKUs.
const v1 = {
  poNumber: '1236143', transactionId: '1026743587', receivedAt: '2026-08-29', purposeCode: '00',
  lines: [
    { sku: 'SN03012LD-CASHMERE', units: 87, byStore: [{ store: '0002', qty: 10 }, { store: '0058', qty: 6 }] },
    { sku: 'SN03013LD-ONYX', units: 8, byStore: [{ store: '0005', qty: 2 }, { store: '0058', qty: 2 }] },
    { sku: 'SN03012LD-ONYX', units: 4, byStore: [{ store: '0004', qty: 2 }, { store: '0002', qty: 2 }] },
    { sku: 'SN03014LD-CASHMERE', units: 3, byStore: [{ store: '0005', qty: 2 }, { store: '0058', qty: 1 }] },
    { sku: 'SN04023LD-ONYX', units: 6, byStore: [{ store: '0011', qty: 4 }, { store: '0053', qty: 2 }] },
  ],
}
// Orderful 1037367444, 2026-09-08, BEG01 = 07 Duplicate. 311 units / 7 SKUs.
const v2 = {
  poNumber: '1236143', transactionId: '1037367444', receivedAt: '2026-09-08', purposeCode: '07',
  lines: [
    { sku: 'SN03012LD-CASHMERE', units: 87, byStore: [{ store: '0002', qty: 10 }, { store: '0058', qty: 6 }] },
    { sku: 'SN03013LD-ONYX', units: 12, byStore: [{ store: '0005', qty: 2 }, { store: '0058', qty: 6 }] },
  ],
}

test('⚠️ THE HEADLINE IS THE WORK, NOT THE DIFFERENCE', () => {
  // Net is -9 units. The job is put 13 back and fetch 4 — and neither of those is 9,
  // because units moved in both directions.
  const r = revisionPick(v1, v2)
  assert.equal(r.putBack, 13)
  assert.equal(r.fetch, 4)
  assert.equal(r.netDelta, -9)
})

test('four verdicts, because they are four different jobs on the floor', () => {
  const r = revisionPick(v1, v2)
  const by = Object.fromEntries(r.rows.map((x) => [x.sku, x.verdict]))
  assert.equal(by['SN03012LD-ONYX'], 'removed')
  assert.equal(by['SN03014LD-CASHMERE'], 'removed')
  assert.equal(by['SN04023LD-ONYX'], 'removed')
  assert.equal(by['SN03013LD-ONYX'], 'increased')
  assert.equal(by['SN03012LD-CASHMERE'], 'unchanged')
  assert.equal(r.changed.length, 4)
})

test('⚠️ AN UNCHANGED TOTAL WITH A CHANGED SPLIT IS STILL WORK', () => {
  // The case a totals-only sheet loses entirely: same 87 units, different stores.
  // For a store-allocated PO the units are bagged per store, so this is real picking.
  const moved = {
    ...v2,
    lines: [{ sku: 'SN03012LD-CASHMERE', units: 87, byStore: [{ store: '0002', qty: 4 }, { store: '0058', qty: 12 }] }],
  }
  const r = revisionPick({ ...v1, lines: [v1.lines[0]] }, moved)
  const row = r.rows[0]
  assert.equal(row.verdict, 'reallocated')
  assert.equal(row.delta, 0)
  assert.deepEqual(row.byStore, [{ store: '0002', was: 10, now: 4 }, { store: '0058', was: 6, now: 12 }])
  assert.equal(r.changed.length, 1, 'and it counts as a change')
})

test('⚠️ A PURPOSE CODE THAT CONTRADICTS THE CONTENT IS PRINTED', () => {
  // Bloomingdale's sent this as 07 = Duplicate while removing three SKUs — three for
  // three on their repeat POs. Anyone told "duplicate" will reasonably not look.
  const r = revisionPick(v1, v2)
  assert.equal(r.miscoded, true)
  assert.equal(r.v2.purposeLabel, 'Duplicate')
  assert.equal(r.v1.purposeLabel, 'Original')

  // A genuine duplicate is not flagged.
  assert.equal(revisionPick(v1, { ...v1, purposeCode: '07' }).miscoded, false)
})

test('a real duplicate reads as identical, with nothing to do', () => {
  const r = revisionPick(v1, { ...v1, transactionId: 'x', purposeCode: '07' })
  assert.equal(r.identical, true)
  assert.equal(r.changed.length, 0)
  assert.equal(r.putBack, 0)
  assert.equal(r.fetch, 0)
})

test('the store grid names every store whose total moved', () => {
  const r = revisionPick(v1, v2)
  const moved = Object.fromEntries(r.storesMoved.map((s) => [s.store, [s.was, s.now]]))
  // 0011 loses 4 (SN04023LD-ONYX removed); 0058 gains 4 net.
  assert.deepEqual(moved['0011'], [4, 0])
  assert.deepEqual(moved['0053'], [2, 0])
  assert.deepEqual(moved['0004'], [2, 0])
  assert.equal(r.storeRows.find((s) => s.store === '0002').delta, -2)
})

test('⚠️ THE ACTION LINE IS WRITTEN IN THE DIRECTION THE FLOOR WORKS', () => {
  // "reduced 8 -> 12" is a fact someone has to invert while holding a box.
  const r = revisionPick(v1, v2)
  const line = (sku) => actionLine(r.rows.find((x) => x.sku === sku))
  assert.match(line('SN04023LD-ONYX'), /^PUT BACK all 6 — no longer on the PO/)
  assert.match(line('SN03013LD-ONYX'), /^FETCH 4 more — 8 up to 12/)
  assert.match(line('SN03013LD-ONYX'), /0058 2->6/)
})

test('summaries carry both transaction ids, so the sheet is traceable to the EDI', () => {
  const r = revisionPick(v1, v2)
  assert.equal(r.v1.transactionId, '1026743587')
  assert.equal(r.v2.transactionId, '1037367444')
  assert.equal(r.v1.units, 108)
  assert.equal(r.v2.units, 99)
  assert.equal(r.poNumber, '1236143')
})

test('an added SKU is not mistaken for an increase', () => {
  const r = revisionPick(
    { lines: [{ sku: 'A', units: 5, byStore: [{ store: '1', qty: 5 }] }] },
    { lines: [{ sku: 'A', units: 5, byStore: [{ store: '1', qty: 5 }] }, { sku: 'B', units: 7, byStore: [{ store: '1', qty: 7 }] }] },
  )
  const b = r.rows.find((x) => x.sku === 'B')
  assert.equal(b.verdict, 'added')
  assert.match(actionLine(b), /^FETCH 7 — newly added/)
  assert.equal(r.fetch, 7)
  assert.equal(r.putBack, 0)
})

test('⚠️ THE GRID CARRIES EVERY CELL, not just the changed ones', () => {
  // rows[].byStore holds only what moved — right for the action list, wrong for a
  // pick sheet. Someone bagging store 0058 needs all its numbers.
  const r = revisionPick(v1, v2)
  const c = r.grid.cell
  // Unchanged cell is present with equal was/now.
  assert.deepEqual(c['SN03012LD-CASHMERE']['0002'], { was: 10, now: 10 })
  // A removed SKU still has a row, with zeros.
  assert.deepEqual(c['SN04023LD-ONYX']['0011'], { was: 4, now: 0 })
  // A store that never carried a SKU is 0/0, not missing.
  assert.deepEqual(c['SN03012LD-ONYX']['0011'], { was: 0, now: 0 })
  assert.equal(r.grid.skus.length, 5)
  assert.equal(r.grid.stores.length, 6)
})

test('⚠️ THE TOTAL IS WHAT THEY WANT NOW — was is only there to check against', () => {
  const r = revisionPick(v1, v2)
  // The DECLARED line quantity — what the PO says it wants.
  assert.deepEqual(r.grid.declared['SN03013LD-ONYX'], { was: 8, now: 12 })
  assert.deepEqual(r.grid.declared['SN04023LD-ONYX'], { was: 6, now: 0 })

  // ⚠️ BOTH MARGINS SUM FROM THE CELLS, so they always reconcile. This assertion is
  // what found the bug: skuTotals used the PO1 line quantity and storeTotals summed
  // the SDQ split, so the grid's edges disagreed by construction.
  const sumSkus = Object.values(r.grid.skuTotals).reduce((a, x) => a + x.now, 0)
  const sumStores = Object.values(r.grid.storeTotals).reduce((a, x) => a + x.now, 0)
  assert.equal(sumSkus, sumStores, 'row and column totals must agree')

  // ⚠️ AND A DECLARED TOTAL THAT DOES NOT MATCH ITS STORE SPLIT IS REPORTED. This
  // fixture is abridged, so it mismatches on purpose — on a well-formed 850 the SDQ
  // sums to PO1, and when it does not, a store is short and nobody would see it.
  assert.ok(r.grid.sdqMismatch.length > 0)
  const m = r.grid.sdqMismatch.find((x) => x.sku === 'SN03012LD-CASHMERE')
  assert.equal(m.declared, 87)
  assert.equal(m.fromStores, 16)
})
