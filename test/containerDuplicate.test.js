// test/containerDuplicate.test.js — the same container under two names.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slipFingerprint, findDuplicates, duplicateVerdict } from '../src/model/containerDuplicate.js'
import { importPreflight, explainOverReceives } from '../src/model/importPreflight.js'

// The real one, both times it was stored on 2026-09-09.
const air = {
  containerLabel: '11 Air 1820 1777 air list carton 2026.9.7',
  unitCount: 150, cartonCount: 11, poNumbers: ['1777', '1820'],
  skuTotals: [
    { poNumber: '1777', sku: 'SN25013FN-BLUFF', units: 50 },
    { poNumber: '1777', sku: 'SN25013FN-CANYON', units: 50 },
    { poNumber: '1820', sku: 'SN03012QJ-ONYX', units: 30 },
    { poNumber: '1820', sku: 'SN03012QJ-TEAK', units: 20 },
  ],
}
const dateless = { ...air, containerLabel: '11 Air 1820 1777 air list carton' }

const asStored = (c, hash = null) => ({
  containerLabel: c.containerLabel, contentHash: hash,
  ...slipFingerprint(c),
})

test('⚠️ THE SAME SHIPMENT UNDER TWO LABELS IS CAUGHT — this happened', () => {
  const m = findDuplicates(air, [asStored(dateless)])
  assert.equal(m.length, 1)
  assert.equal(m[0].kind, 'same-shipment')
  assert.equal(m[0].certainty, 'certain')
  assert.equal(m[0].containerLabel, '11 Air 1820 1777 air list carton')
  assert.match(m[0].reason, /150 units/)
})

test('byte-identical file under a different name is the strongest signal', () => {
  const m = findDuplicates({ ...air, contentHash: 'abc' }, [asStored(dateless, 'abc')])
  assert.equal(m[0].kind, 'same-file')
  assert.match(m[0].reason, /one of the two names is wrong/)
})

test('⚠️ OVERLAPPING POs ARE NOT A DUPLICATE — PO1820 really did ship on two vessels', () => {
  // 30 units of SN03012QJ-ONYX on `11 air`, another 20 on `55 container`. A PO split
  // across vessels is the ordinary case; flagging it would fire on half of all real
  // containers and the warning would be switched off within a week.
  const container55 = {
    containerLabel: '55 carton 2026.9.7',
    unitCount: 1439, cartonCount: 55, poNumbers: ['1747', '1761', '1785', '1820'],
    skuTotals: [{ poNumber: '1820', sku: 'SN03012QJ-ONYX', units: 20 }],
  }
  assert.deepEqual(findDuplicates(air, [asStored(container55)]), [])
})

test('re-importing under the SAME label is not a duplicate', () => {
  // That is a re-import, and packingSlipRevision decides whether it is news.
  assert.deepEqual(findDuplicates(air, [asStored(air)]), [])
})

test('same POs and same total but a different breakdown reads as a likely reissue', () => {
  const moved = {
    ...dateless,
    skuTotals: [
      { poNumber: '1777', sku: 'SN25013FN-BLUFF', units: 60 },
      { poNumber: '1777', sku: 'SN25013FN-CANYON', units: 40 },
      { poNumber: '1820', sku: 'SN03012QJ-ONYX', units: 30 },
      { poNumber: '1820', sku: 'SN03012QJ-TEAK', units: 20 },
    ],
  }
  const m = findDuplicates(air, [asStored(moved)])
  assert.equal(m[0].kind, 'possible-reissue')
  assert.equal(m[0].certainty, 'likely')
})

test('a genuinely different container is not flagged', () => {
  const other = {
    containerLabel: '16 carton 2026.7.9', unitCount: 900, cartonCount: 16,
    poNumbers: ['1705', '1720'], skuTotals: [{ poNumber: '1705', sku: 'X-Y', units: 900 }],
  }
  assert.deepEqual(findDuplicates(air, [asStored(other)]), [])
})

test('⚠️ A DUPLICATE WARNS AND ASKS — it never blocks or guesses which name is right', () => {
  const v = duplicateVerdict(findDuplicates(air, [asStored(dateless)]))
  assert.equal(v.duplicate, true)
  assert.equal(v.requiresConfirmation, true)
  assert.equal(v.certain, true)
  assert.match(v.headline, /already stored as "11 Air 1820 1777 air list carton"/)
  assert.deepEqual(duplicateVerdict([]), { duplicate: false, requiresConfirmation: false, matches: [] })
})

test('a master packing list has null cartons, not zero — so they do not all match', () => {
  const a = slipFingerprint({ unitCount: 10, cartonCount: null, skuTotals: [], poNumbers: [] })
  assert.equal(a.cartonCount, null)
})

// ── the import preflight ────────────────────────────────────────────────────
const L = '11 Air 1820 1777 air list carton 2026.9.7'
const receiptsIn = new Map([
  [`EXT-IR-${L}1777`, { tranid: 'IR1915' }],
  [`EXT-IR-${L}1820`, { tranid: 'IR1916' }],
])

test('⚠️ "ALREADY IMPORTED" IS ASKED DIRECTLY, not inferred from over-receives', () => {
  const p = importPreflight(air, ['1777', '1820'], receiptsIn)
  assert.equal(p.itemReceipt.status, 'already imported')
  assert.match(p.itemReceipt.message, /ALREADY IN NETSUITE/)
  assert.equal(p.transfer.status, 'not imported')
  assert.equal(p.receipts.length, 2)
})

test('partial is its own answer, and names how many remain', () => {
  const half = new Map([[`EXT-IR-${L}1777`, { tranid: 'IR1915' }]])
  const p = importPreflight(air, ['1777', '1820'], half)
  assert.equal(p.itemReceipt.status, 'partial')
  assert.match(p.itemReceipt.message, /1 of 2/)
  assert.match(p.itemReceipt.message, /remaining 1/)
})

test('⚠️ FOUR OVER-RECEIVES WITH ONE CAUSE ARE EXPLAINED AS ONE THING', () => {
  // Exactly tonight: re-running the container after its receipt was imported made
  // every SKU read as an over-receive of its full quantity. Four findings, one cause,
  // and the screen described them as four quantity problems.
  const over = [
    { poNumber: 'PO1777', sku: 'SN25013FN-BLUFF', shipped: 50, remaining: 0 },
    { poNumber: 'PO1777', sku: 'SN25013FN-CANYON', shipped: 50, remaining: 0 },
    { poNumber: 'PO1820', sku: 'SN03012QJ-ONYX', shipped: 30, remaining: 20 },
    { poNumber: 'PO1820', sku: 'SN03012QJ-TEAK', shipped: 20, remaining: 0 },
  ]
  const p = importPreflight(air, ['1777', '1820'], receiptsIn)
  const e = explainOverReceives(p, over)
  assert.equal(e.cause, 'already imported')
  assert.match(e.text, /IR1915, IR1916/)
  assert.match(e.text, /You do not need this file/)
})

test('with no receipt in NetSuite an over-receive is real, and says so', () => {
  const p = importPreflight(air, ['1777', '1820'], new Map())
  const e = explainOverReceives(p, [{ poNumber: 'PO1777', sku: 'X', shipped: 5, remaining: 0 }])
  assert.equal(e.cause, 'quantity')
  assert.match(e.text, /these are real/)
})

test('partially imported separates the explained from the genuinely wrong', () => {
  const half = new Map([[`EXT-IR-${L}1777`, { tranid: 'IR1915' }]])
  const p = importPreflight(air, ['1777', '1820'], half)
  const e = explainOverReceives(p, [
    { poNumber: 'PO1777', sku: 'A', shipped: 50, remaining: 0 },
    { poNumber: 'PO1820', sku: 'B', shipped: 99, remaining: 20 },
  ])
  assert.equal(e.cause, 'partially imported')
  assert.equal(e.unexplained.length, 1)
  assert.equal(e.unexplained[0].sku, 'B', 'the real one is named, not just counted')
})

test('no over-receives means nothing to explain', () => {
  assert.equal(explainOverReceives(importPreflight(air, ['1777'], new Map()), []), null)
})
