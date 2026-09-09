// test/containerVerify.test.js — every case here happened on 2026-09-09, live.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyContainer, expectedKeys, transferState } from '../src/model/containerVerify.js'

// The real container: 11 air, imported under the filename stem and the wrong date.
const container = {
  containerNum: '11 Air 1820 1777 air list',
  containerDate: '2026.9.7',
  skuTotals: [
    { poNumber: '1777', sku: 'SN25013FN-BLUFF', units: 50 },
    { poNumber: '1777', sku: 'SN25013FN-CANYON', units: 50 },
    { poNumber: '1820', sku: 'SN03012QJ-ONYX', units: 30 },
    { poNumber: '1820', sku: 'SN03012QJ-TEAK', units: 20 },
  ],
}
const L = '11 Air 1820 1777 air list carton 2026.9.7'

const ns = (over = {}) => new Map(Object.entries({
  [`EXT-IR-${L}1777`]: { tranid: 'IR1915', lines: [{ sku: 'SN25013FN-BLUFF', qty: 50 }, { sku: 'SN25013FN-CANYON', qty: 50 }] },
  [`EXT-IR-${L}1820`]: { tranid: 'IR1916', lines: [{ sku: 'SN03012QJ-ONYX', qty: 30 }, { sku: 'SN03012QJ-TEAK', qty: 20 }] },
  [`EXT-${L}1777`]: { tranid: 'TO218', status: 'Transfer Order : Received' },
  [`EXT-${L}1820`]: { tranid: 'TO219', status: 'Transfer Order : Received' },
  ...over,
}))

test('the keys are recomputed, matching the four records live in NetSuite', () => {
  assert.deepEqual(expectedKeys(container, '1777'), {
    itemReceipt: `EXT-IR-${L}1777`,
    transfer: `EXT-${L}1777`,
  })
  // The PO arrives either way; NetSuite writes the prefix, the slip does not.
  assert.deepEqual(expectedKeys(container, 'PO1820'), expectedKeys(container, '1820'))
})

test('all four legs found and landed reads complete', () => {
  const r = verifyContainer(container, { byExternalId: ns() })
  assert.equal(r.complete, true)
  assert.equal(r.units, 150)
  assert.equal(r.poCount, 2)
  assert.deepEqual(r.problems, [])
})

test('⚠️ A TRANSFER ORDER THAT EXISTS HAS NOT MOVED ANYTHING', () => {
  // The real state after the 2026-09-09 import: both TOs present, both at Pending
  // Fulfillment, all 150 units still sitting in China. Every record exists and the
  // container is NOT done — this is the case a "does the record exist" check passes.
  const r = verifyContainer(container, {
    byExternalId: ns({
      [`EXT-${L}1777`]: { tranid: 'TO218', status: 'Transfer Order : Pending Fulfillment' },
      [`EXT-${L}1820`]: { tranid: 'TO219', status: 'Transfer Order : Pending Fulfillment' },
    }),
  })
  assert.equal(r.complete, false)
  assert.equal(r.problems.length, 2)
  assert.match(r.problems[0].problem, /never fulfilled\/received/)
  assert.equal(r.legs[0].transfer.tranid, 'TO218')
  assert.equal(r.legs[0].transfer.inFlight, true)
})

test('received but never transferred is called out as stranded in China', () => {
  const m = ns(); m.delete(`EXT-${L}1777`)
  const r = verifyContainer(container, { byExternalId: m })
  assert.match(r.problems[0].problem, /still in China/)
  assert.equal(r.legs[0].itemReceipt.tranid, 'IR1915')
  assert.equal(r.legs[0].transfer, null)
})

test('no item receipt is a different problem from no transfer', () => {
  const m = ns(); m.delete(`EXT-IR-${L}1777`)
  const r = verifyContainer(container, { byExternalId: m })
  assert.equal(r.legs[0].problem, 'no item receipt')
})

test('a wrong container label orphans every leg — the 2026-09-09 near-miss', () => {
  // Same slip, tidied to what the label "should" have been. NetSuite still holds the
  // ugly one, so nothing pairs. This is what makes a mislabelled import visible at
  // all, and why the stored label must never be prettified after the fact.
  const tidied = { ...container, containerNum: '11 air', containerDate: '2026.9.9' }
  const r = verifyContainer(tidied, { byExternalId: ns() })
  assert.equal(r.complete, false)
  assert.equal(r.problems.length, 2)
  assert.ok(r.problems.every((p) => p.problem === 'no item receipt'))
})

test('quantities are compared against the slip, and both directions are reported', () => {
  const r = verifyContainer(container, {
    byExternalId: ns({
      [`EXT-IR-${L}1820`]: {
        tranid: 'IR1916',
        lines: [{ sku: 'SN03012QJ-ONYX', qty: 40 }, { sku: 'SN99999-GHOST', qty: 5 }],
      },
    }),
  })
  const leg = r.legs.find((l) => l.poNumber === 'PO1820')
  const kinds = Object.fromEntries(leg.discrepancies.map((d) => [d.sku, d.kind]))
  assert.equal(kinds['SN03012QJ-ONYX'], 'over-received')
  assert.equal(kinds['SN03012QJ-TEAK'], 'not on the receipt')
  assert.equal(kinds['SN99999-GHOST'], 'received but not on the slip')
})

test('⚠️ the transfer is NOT quantity-checked, because its lines triple', () => {
  // TO218 really holds: BLUFF -50 China, BLUFF -50 China, BLUFF +50 Warehouse.
  // Summing that is -50; summing ABS is 150. Neither is the answer, so the check
  // does not ask — the receipt is where quantity lives. Same trap as the EDI carton
  // check's 3-line quantity bug.
  const r = verifyContainer(container, {
    byExternalId: ns({
      [`EXT-${L}1777`]: {
        tranid: 'TO218', status: 'Transfer Order : Received',
        lines: [{ sku: 'SN25013FN-BLUFF', qty: -50 }, { sku: 'SN25013FN-BLUFF', qty: -50 }, { sku: 'SN25013FN-BLUFF', qty: 50 }],
      },
    }),
  })
  assert.equal(r.complete, true, 'transfer lines must not produce discrepancies')
})

test('a closed transfer never received is not treated as landed', () => {
  const r = verifyContainer(container, {
    byExternalId: ns({ [`EXT-${L}1777`]: { tranid: 'TO218', status: 'Transfer Order : Closed' } }),
  })
  assert.match(r.problems[0].problem, /closed without receiving/)
})

test('transferState: an unknown status is flagged, never assumed fine', () => {
  // ⚠️ Defaulting an unrecognised status to "landed" would turn a new NetSuite
  // status into a silently-passing container.
  assert.equal(transferState('Transfer Order : Something New').landed, false)
  assert.match(transferState('Transfer Order : Something New').note, /unrecognised/)
  assert.equal(transferState('').note, 'status unknown')
  assert.equal(transferState('Transfer Order : Pending Receipt/Partially Fulfilled').inFlight, true)
})
