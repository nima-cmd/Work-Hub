import test from 'node:test'
import assert from 'node:assert/strict'
import { cardCustody } from '../src/model/custody.js'
import { eventsFromFulfillments, SPINE_LABEL } from '../src/model/orderEvents.js'

// The live case, 2026-08-05. Bloomingdale's PO 8040313: five DC cargo tags went
// out Aug 2, four came back Aug 4, DC CL's return scan was never made. The card
// read "◫ With Nestor 1/5" while the cartons were on our own floor waiting for
// a UPS pickup — routed, marked shipped, invoiced on INV11455.
const ev = (docType, docNumber, eventType, day) =>
  ({ docType, docNumber, eventType, occurredAt: `2026-08-0${day}T12:00:00Z` })

const dcList = ['CI', 'CL', 'HA', 'SC', 'ST'].map((dc) => ({ dc }))
const card = (ifStatus) => ({
  poNumber: '8040313', isGroup: true, source: 'edi',
  fulfillments: [{ ifNumber: 'IF7459', status: ifStatus }],
})
const scans = [
  ...['CI', 'CL', 'HA', 'SC', 'ST'].map((dc) => ev('DC', `8040313:${dc}`, 'CUSTODY_OUT', 2)),
  ...['CI', 'HA', 'SC', 'ST'].map((dc) => ev('DC', `8040313:${dc}`, 'CUSTODY_IN', 4)),
]

test('an unreturned tag on a marked-shipped card reads as a scan gap, not a location', () => {
  const c = cardCustody(card('Shipped'), scans, dcList)
  assert.equal(c.state, 'conflict')
  assert.match(c.label, /Scan gap 1\/5/)
  // It must NOT claim the goods are at the warehouse…
  assert.doesNotMatch(c.label, /Nestor/)
  // …and must NOT claim they came back either. Both would be guesses.
  assert.doesNotMatch(c.label, /our court/)
})

test('without the paper contradiction it is still an honest "with Nestor"', () => {
  // Same scans, nothing marked shipped: one tag really is out at the warehouse.
  const c = cardCustody(card('Packed'), scans, dcList)
  assert.equal(c.state, 'warehouse')
  assert.match(c.label, /With Nestor 1\/5/)
})

test('all tags back is unaffected by the paper state', () => {
  const all = [...scans, ev('DC', '8040313:CL', 'CUSTODY_IN', 5)]
  assert.equal(cardCustody(card('Shipped'), all, dcList).state, 'returned')
  assert.equal(cardCustody(card('Packed'), all, dcList).state, 'returned')
})

// ⚠️ Marking shipped is how the Bloomingdale's ASN gets generated — deliberately
// BEFORE the truck arrives (Nima, 2026-08-05). The event is real; what it
// witnesses is a keystroke, not a departure, and the label has to say so.
test('the shipped-derived event does not claim the goods left', () => {
  const [e] = eventsFromFulfillments([
    { ifNumber: 'IF7459', soNumber: 'SO12384', status: 'Shipped', actualShipDate: '2026-08-05' },
  ]).filter((x) => x.eventType === 'DEPARTED')
  assert.ok(e, 'the event is still recorded — a human really did mark it')
  const label = SPINE_LABEL.get('DEPARTED')
  assert.doesNotMatch(label, /depart/i)
  assert.match(label, /marked shipped/i)
})

// ⚠️ A part-scanned card must not borrow its sibling's evidence (2026-08-06). Found via
// a wrongly grouped boutique PO: two fulfilments, one scanned back, and the card read
// "✓ Ball's in our court" — the whole card claiming to be home while the second had
// never been scanned at all. The warehouse branch always showed its fraction; the
// returned branch silently rounded up.
test('one of two scanned back reads as partial, not fully returned', () => {
  const card = {
    isGroup: true, source: 'boutique', poNumber: 'PO05658',
    fulfillments: [{ ifNumber: 'IF9001', status: 'Packed' }, { ifNumber: 'IF9002', status: 'Packed' }],
  }
  const ev = [
    { docType: 'IF', docNumber: 'IF9001', eventType: 'CUSTODY_OUT', occurredAt: '2026-08-06T10:00:00Z' },
    { docType: 'IF', docNumber: 'IF9001', eventType: 'CUSTODY_IN', occurredAt: '2026-08-06T11:00:00Z' },
  ]
  const partial = cardCustody(card, ev)
  assert.equal(partial.state, 'partial')
  assert.match(partial.label, /Back 1\/2 — 1 never scanned/)

  // Both scanned back → the plain terminology Nima set.
  const both = [...ev, { docType: 'IF', docNumber: 'IF9002', eventType: 'CUSTODY_IN', occurredAt: '2026-08-06T11:30:00Z' }]
  const done = cardCustody(card, both)
  assert.equal(done.state, 'returned')
  assert.equal(done.label, "✓ Ball's in our court")
})

test('a single-fulfilment card never reads as partial', () => {
  // docs.length === 1, so scanned === docs.length whenever there is any scan at all.
  const card = { fulfillments: [{ ifNumber: 'IF1', status: 'Packed' }] }
  const c = cardCustody(card, [{ docType: 'IF', docNumber: 'IF1', eventType: 'CUSTODY_IN', occurredAt: '2026-08-06T11:00:00Z' }])
  assert.equal(c.state, 'returned')
})
