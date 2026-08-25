import test from 'node:test'
import assert from 'node:assert/strict'
import { shipmentEvent, eventDate, isoShipDay } from '../src/model/shipmentCalendar.js'
import { shipmentEvidence } from '../src/model/shipmentEvidence.js'

// ⚠️ This text LEAVES THE BUILDING. A shared calendar is read by people who will never
// open the app, so every claim in the body has to survive being quoted back.

const proven = shipmentEvidence({
  asns: [
    { id: '1', bolNumber: 'NB1731242', ackStatus: 'ACCEPTED', at: '2026-08-03T10:00:00Z' },
    { id: '2', bolNumber: 'NB1731243', ackStatus: 'ACCEPTED', at: '2026-08-03T10:01:00Z' },
  ],
  invoices: Array.from({ length: 23 }, (_, i) => ({
    id: String(i), invoiceNumber: String(11419 + i), ackStatus: 'ACCEPTED', at: '2026-08-04T09:00:00Z',
  })),
  scans: [{ name: '7242978-SC.pdf', url: 'https://drive.google.com/file/d/x/view', dc: 'SC' }],
  shipDates: ['2026-08-03'],
})

test('a proven shipment says "shipped" and carries the BOL numbers', () => {
  const e = shipmentEvent({ po: '7242978', partner: "Bloomingdale's", evidence: proven })
  assert.match(e.summary, /Bloomingdale's 7242978 — shipped \(2 BOLs\)/)
  assert.match(e.description, /NB1731242/)
  assert.match(e.description, /NB1731243/)
  assert.match(e.description, /Basis: signed BOL on file/)
})

test('⚠️ an UNPROVEN shipment never says "shipped"', () => {
  // A calendar entry asserting a shipment on our own word is exactly the artefact
  // someone forwards to a partner.
  const own = shipmentEvidence({ shipDates: ['2026-08-03'] })
  const e = shipmentEvent({ po: 'P1', partner: 'X', evidence: own, shipDates: ['2026-08-03'] })
  assert.match(e.summary, /ship date recorded/)
  assert.doesNotMatch(e.summary, /shipped/)
  assert.match(e.description, /⚠ Not confirmed by the partner or the carrier/)
})

test('the Drive links are in the body, each one on its own line', () => {
  const e = shipmentEvent({ po: '7242978', partner: "Bloomingdale's", evidence: proven })
  assert.match(e.description, /Signed paperwork:/)
  assert.match(e.description, /SC — 7242978-SC\.pdf/)
  assert.match(e.description, /https:\/\/drive\.google\.com\/file\/d\/x\/view/)
})

test('no paperwork says so rather than omitting the section', () => {
  const noScans = shipmentEvidence({ asns: [{ id: '1', bolNumber: 'NB1', ackStatus: 'ACCEPTED', at: '2026-08-03T00:00:00Z' }] })
  const e = shipmentEvent({ po: 'P2', partner: 'X', evidence: noScans })
  assert.match(e.description, /No signed paperwork filed/)
})

test('23 invoices become a range; a handful are listed individually', () => {
  const many = shipmentEvent({ po: '7242978', partner: 'X', evidence: proven })
  assert.match(many.description, /11419–11441/)
  const few = shipmentEvidence({
    asns: [{ id: '1', bolNumber: 'NB1', ackStatus: 'ACCEPTED', at: '2026-08-03T00:00:00Z' }],
    invoices: [{ id: '1', invoiceNumber: '11419', ackStatus: 'ACCEPTED' }, { id: '2', invoiceNumber: '11420', ackStatus: 'ACCEPTED' }],
  })
  const e = shipmentEvent({ po: 'P3', partner: 'X', evidence: few })
  assert.match(e.description, /11419/)
  assert.match(e.description, /11420/)
  assert.doesNotMatch(e.description, /11419–11420/, 'two is not a range')
})

test('⚠️ the date is the EVIDENCE\'s date, not the sync\'s run date', () => {
  const e = shipmentEvent({ po: 'P4', partner: 'X', evidence: proven, shipDates: ['2026-01-01'] })
  assert.equal(e.date, '2026-08-03', 'the accepted ASN, not our January date and not today')
})

test('an accepted ASN outranks our own ship date for the day', () => {
  assert.equal(eventDate(proven, ['2026-01-01']), '2026-08-03')
})

test('⚠️ NO DATE, NO EVENT — nothing is invented', () => {
  const dateless = shipmentEvidence({ asns: [{ id: '1', bolNumber: 'NB1', ackStatus: 'ACCEPTED' }] })
  assert.equal(shipmentEvent({ po: 'P5', partner: 'X', evidence: dateless, shipDates: [] }), null)
})

test('a delivered-but-unacknowledged ASN is warned about in the body', () => {
  const risky = shipmentEvidence({
    asns: [{ id: '1', bolNumber: 'NB9', deliveryStatus: 'DELIVERED', ackStatus: 'NOT_ACKNOWLEDGED', at: '2026-08-03T00:00:00Z' }],
    shipDates: ['2026-08-03'],
  })
  const e = shipmentEvent({ po: 'P6', partner: 'X', evidence: risky, shipDates: ['2026-08-03'] })
  assert.match(e.description, /delivered but NOT acknowledged/)
  assert.match(e.description, /chargeback exposure/)
})

test('the event key is stable and Google-legal', () => {
  const a = shipmentEvent({ po: '7242978', partner: 'X', evidence: proven })
  const b = shipmentEvent({ po: '7242978', partner: 'X', evidence: proven })
  assert.equal(a.key, b.key, 'a re-sync updates rather than duplicates')
  assert.match(a.key, /^[a-v0-9]{5,}$/, 'Google only accepts [a-v0-9]{5,1024}')
  const odd = shipmentEvent({ po: 'PO/123-XZ', partner: 'X', evidence: proven })
  assert.match(odd.key, /^[a-v0-9]+$/, 'characters outside the set are stripped, not trusted')
})

test('⚠️ a pg Date object becomes a real ISO day, not "Mon Aug 03"', () => {
  // String(date).slice(0,10) on a Date gives the WEEKDAY. It rendered exactly that.
  assert.equal(isoShipDay(new Date('2026-08-03T17:00:00Z')), '2026-08-03')
})

test('⚠️ the day is the WAREHOUSE\'s, not UTC\'s', () => {
  // 02:00Z on the 4th is 19:00 on the 3rd in Glendale. UTC would file the freight a
  // day late; these are timestamptz — real moments, not dateless DATEs.
  assert.equal(isoShipDay('2026-08-04T02:00:00Z'), '2026-08-03')
  assert.equal(isoShipDay('2026-08-03T18:00:00Z'), '2026-08-03')
})

test('our own DATE is not re-zoned — a dateless day must not move backwards', () => {
  const own = shipmentEvidence({ shipDates: ['2026-08-03'] })
  const e = shipmentEvent({ po: 'P9', partner: 'X', evidence: own, shipDates: ['2026-08-03'] })
  assert.equal(e.date, '2026-08-03')
})

test('isoShipDay is safe on junk', () => {
  assert.equal(isoShipDay(null), null)
  assert.equal(isoShipDay('not a date'), null)
})
