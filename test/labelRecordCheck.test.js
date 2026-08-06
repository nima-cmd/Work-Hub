// A ShipStation label was bought — did the tracking number and freight figure get
// recorded in NetSuite? Every case here is a live row from 2026-08-06.

import test from 'node:test'
import assert from 'node:assert/strict'
import { labelRecordGap, summarizeLabelRecords, sameTracking, RECORD_GAP } from '../src/model/labelRecordCheck.js'

test('the live IF7451 case — tracking entered, figure left at zero', () => {
  // Nima entered 1ZC6J6100316963945 and ShipStation had charged $31.44. No invoice yet.
  const v = labelRecordGap({
    ssTracking: '1ZC6J6100316963945', ssCost: 31.44,
    nsTracking: ['1ZC6J6100316963945'], invoiceNumber: null,
  })
  assert.equal(v.kind, RECORD_GAP.AWAITING_INVOICE)
  assert.equal(v.enter, 31.44)
  assert.match(v.reason, /\$31\.44 to record once the invoice is raised/)
})

test('once the invoice exists with no figure, it becomes actionable', () => {
  const v = labelRecordGap({
    ssTracking: '1ZC6J6100316963945', ssCost: 31.44,
    nsTracking: ['1ZC6J6100316963945'], invoiceNumber: 'INV11499', invoiceShippingCost: 0,
  })
  assert.equal(v.kind, RECORD_GAP.COST_MISSING)
  assert.match(v.reason, /INV11499 carries no freight figure — ShipStation charged \$31\.44/)
})

test('⚠️ a $0 shipment is a COMPLETE answer, not a missing figure', () => {
  // 19 of 20 live labels cost Naghedi nothing — the EDI cartons bill third-party to
  // Macy's. Demanding a figure would invent 19 tasks that must never be done, the same
  // mistake FOB_PICKUP was created to undo.
  for (const cost of [0, null, undefined]) {
    const v = labelRecordGap({ ssTracking: '1Z18GE010328462563', ssCost: cost, nsTracking: ['1Z18GE010328462563'] })
    assert.equal(v.ok, true, String(cost))
    assert.equal(v.kind, RECORD_GAP.OK, String(cost))
    assert.match(v.reason, /billed to a third party/)
  }
})

test('no tracking in NetSuite names the number to enter', () => {
  const v = labelRecordGap({ ssTracking: '1ZC6J6100316963945', ssCost: 31.44, nsTracking: [] })
  assert.equal(v.kind, RECORD_GAP.TRACKING_MISSING)
  assert.equal(v.enter, '1ZC6J6100316963945')   // ready to copy — the point of the check
})

test('tracking present but for a different shipment is its own kind', () => {
  // Not the same action as "none at all": one is data entry, the other is a discrepancy.
  const v = labelRecordGap({
    ssTracking: '1ZC6J6100316963945', ssCost: 31.44, nsTracking: ['1ZC6J6100306968736'],
  })
  assert.equal(v.kind, RECORD_GAP.TRACKING_MISMATCH)
  assert.match(v.reason, /has 1ZC6J6100306968736 but this label is 1ZC6J6100316963945/)
})

test('multi-box: matching ANY of the fulfilment numbers is a match', () => {
  // IF7443 genuinely carries two tracking numbers.
  const v = labelRecordGap({
    ssTracking: '1ZC6J6100333248712', ssCost: 0,
    nsTracking: ['1ZC6J6100331004729', '1ZC6J6100333248712'],
  })
  assert.equal(v.ok, true)
})

test('a pasted number still matches when spacing or case differs', () => {
  assert.equal(sameTracking('1ZC6J6100316963945', '1z c6j610 0316963945'), true)
  assert.equal(sameTracking('1ZC6J6100316963945', '1ZC6J6100316963946'), false)
  assert.equal(sameTracking('', '1ZC6J6100316963945'), false)
  assert.equal(sameTracking(null, null), false)
})

test('a voided label records nothing and is not work', () => {
  // A voided label KEEPS its tracking number and its row (PO 8040313 DC CL had three
  // shipments for one carton, two of them voided reprints).
  const v = labelRecordGap({ ssTracking: '1Z18GE010335907131', ssCost: 12, voided: true, nsTracking: [] })
  assert.equal(v.ok, true)
  assert.equal(v.kind, RECORD_GAP.VOIDED)
})

test('the summary keeps the kinds apart and excludes the wait', () => {
  const counts = summarizeLabelRecords([
    { kind: RECORD_GAP.OK }, { kind: RECORD_GAP.OK },
    { kind: RECORD_GAP.TRACKING_MISSING },
    { kind: RECORD_GAP.TRACKING_MISMATCH },
    { kind: RECORD_GAP.COST_MISSING },
    { kind: RECORD_GAP.AWAITING_INVOICE }, { kind: RECORD_GAP.AWAITING_INVOICE },
    { kind: RECORD_GAP.VOIDED },
  ])
  assert.equal(counts.ok, 2)
  assert.equal(counts.awaitingInvoice, 2)
  // ⚠️ actionable is what needs a keystroke NOW — an unraised invoice is a wait, and
  // rolling it in would nag about a document that does not exist.
  assert.equal(counts.actionable, 3)
})

test('garbage input is never reported as a gap', () => {
  for (const a of [undefined, {}, { ssTracking: null }]) {
    assert.equal(labelRecordGap(a).ok, true)
  }
})
