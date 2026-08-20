import test from 'node:test'
import assert from 'node:assert/strict'
import { LANES, laneFor, laneKey, anchorFor, roleFor, groupByRole } from '../src/model/orderLane.js'

// ── The four lanes, as measured on all 322 tracked orders (2026-08-20) ───────

test('an EDI order is the EDI lane, anchored on THEIR PO', () => {
  const o = { source: 'edi', isAts: false, poNumber: '50073677' }
  assert.equal(laneKey(o), 'edi')
  assert.deepEqual(anchorFor(o), { docType: 'THEIR_PO', docNumber: '50073677', label: 'their PO' })
})

test('a boutique order with an OC is OC-anchored', () => {
  const o = { source: 'boutique', isAts: false, ocNumber: 'OC1531' }
  assert.equal(laneKey(o), 'oc_anchored')
  assert.deepEqual(anchorFor(o), { docType: 'OC', docNumber: 'OC1531', label: 'OC' })
})

test('an ATS order with no OC came from stock, and has NO anchor', () => {
  const o = { source: 'boutique', isAts: true }
  assert.equal(laneKey(o), 'stock')
  assert.equal(anchorFor(o), null, 'no purchase order is linked to a stock order, and none should be')
})

test('presold with no OC is named honestly, not forced into a lane', () => {
  // 29 real orders — including the FOB-China flow and in-house NAGHEDI orders.
  const o = { source: 'boutique', isAts: false }
  assert.equal(laneKey(o), 'unconfirmed')
})

// ── The lane is read from observed fields, never inferred from another ───────

test('a null ATS flag is UNKNOWN, never treated as presold', () => {
  // is_ats was dead on all 282 orders once (fieldAssumptions.js). If null collapsed
  // to false, every order on a sync that lost the flag would report as
  // "presold, no confirmation" — the lane that reads like a problem.
  assert.equal(laneFor({ source: 'boutique', isAts: null }), null)
  assert.equal(laneFor({ source: 'boutique' }), null)
  assert.equal(laneKey({ source: 'boutique' }), null)
})

test('an OC settles the lane even when the ATS flag disagrees', () => {
  // An OC is a fact — the Estimate exists. A flag is a field.
  assert.equal(laneKey({ source: 'boutique', isAts: true, ocNumber: 'OC1' }), 'oc_anchored')
  assert.equal(laneKey({ source: 'boutique', isAts: null, ocNumber: 'OC1' }), 'oc_anchored')
})

test('EDI is decided by SOURCE, not by having a customer PO', () => {
  // 30 of 89 boutique orders also carry a customer PO, so "has a po_number" would
  // have swept them into the EDI lane.
  assert.equal(laneKey({ source: 'boutique', isAts: true, poNumber: 'TBRSN826' }), 'stock')
  assert.equal(laneKey({ source: 'edi', isAts: false, poNumber: '50073677' }), 'edi')
})

test('laneFor accepts snake_case rows straight from the database', () => {
  assert.equal(laneKey({ source: 'boutique', is_ats: false, oc_number: 'OC1531' }), 'oc_anchored')
  assert.equal(laneKey({ source: 'boutique', is_ats: true }), 'stock')
})

// ── The two things called PO must never merge ────────────────────────────────

test("the customer's PO gets its own docType, never plain PO", () => {
  // orders.po_number and purchase_orders.po_number share ZERO values. One 'PO' type
  // would let a trace hop from a customer's PO into our factory PO table.
  const a = anchorFor({ source: 'edi', poNumber: '50073677' })
  assert.equal(a.docType, 'THEIR_PO')
  assert.notEqual(a.docType, 'PO')
  assert.equal(a.label, 'their PO')
})

test('an EDI order with no PO number has no anchor rather than a blank one', () => {
  assert.equal(anchorFor({ source: 'edi', isAts: false }), null)
})

test('every lane declares its own shape and says which PO it means', () => {
  for (const lane of Object.values(LANES)) {
    assert.ok(lane.shape, `${lane.key} needs a shape`)
    assert.ok(lane.blurb, `${lane.key} needs an explanation`)
    if (lane.anchor === 'theirPo') assert.match(lane.anchorLabel, /their/)
  }
})

test('lanes 1 and 3 are deliberately ONE lane, and the label does not claim otherwise', () => {
  // Telling "ordered directly for this OC" from "several OCs under one PO" needs the
  // OC↔PO link: 0 of 1,436 purchase_orders rows carry linked_oc, and oc_po_links
  // holds 5. Claiming the distinction would put a shape on screen nobody entered.
  assert.equal(LANES.OC_ANCHORED.key, 'oc_anchored')
  assert.match(LANES.OC_ANCHORED.blurb, /not something we can currently tell/)
})

// ── Roles: the grouping that stops the same thing appearing twice ────────────

test('documents sort into where-it-came-from, the order, and what-came-out', () => {
  assert.equal(roleFor('OC'), 'upstream')
  assert.equal(roleFor('THEIR_PO'), 'upstream')
  assert.equal(roleFor('SO'), 'order')
  assert.equal(roleFor('IF'), 'downstream')
  assert.equal(roleFor('INV'), 'downstream')
  assert.equal(roleFor('TRACK'), 'downstream')
  assert.equal(roleFor('EMAIL'), 'work')
  assert.equal(roleFor('TASK'), 'work')
})

test('an unknown document type lands in work rather than vanishing', () => {
  assert.equal(roleFor('WAT'), 'work')
  assert.equal(roleFor(null), 'work')
})

test('groupByRole keeps a fixed reading order and drops empty groups', () => {
  const groups = groupByRole([
    { docType: 'INV', docNumber: 'INV1' },
    { docType: 'OC', docNumber: 'OC1' },
    { docType: 'IF', docNumber: 'IF1' },
  ])
  assert.deepEqual(groups.map((g) => g.key), ['upstream', 'downstream'])
  assert.equal(groups[0].cards.length, 1)
  assert.equal(groups[1].cards.length, 2, 'the IF and the invoice are both downstream')
})

test('groupByRole on nothing is an empty list, not a row of empty headings', () => {
  assert.deepEqual(groupByRole([]), [])
})

test('every card survives grouping exactly once', () => {
  const cards = [
    { docType: 'OC', docNumber: 'OC1' }, { docType: 'SO', docNumber: 'SO1' },
    { docType: 'IF', docNumber: 'IF1' }, { docType: 'INV', docNumber: 'INV1' },
    { docType: 'TRACK', docNumber: '1Z1' }, { docType: 'TASK', docNumber: '1' },
  ]
  const out = groupByRole(cards).flatMap((g) => g.cards)
  assert.equal(out.length, cards.length, 'grouping must not duplicate or drop a card')
  assert.deepEqual(new Set(out.map((c) => c.docNumber)).size, cards.length)
})
