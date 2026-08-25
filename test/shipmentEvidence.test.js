import test from 'node:test'
import assert from 'node:assert/strict'
import { shipmentEvidence, evidenceHeadline, TIER } from '../src/model/shipmentEvidence.js'

// The real case: PO 7242978. 4 ASNs accepted, 23 invoices accepted, 5 signed PDFs in
// Drive — and a close panel that showed a hand-typed note and no document numbers.

const REAL = {
  asns: [
    { id: '1000270292', bolNumber: 'NB1731242', deliveryStatus: 'DELIVERED', ackStatus: 'ACCEPTED' },
    { id: '1000270318', bolNumber: 'NB1731243', deliveryStatus: 'DELIVERED', ackStatus: 'ACCEPTED' },
    { id: '1000270297', bolNumber: 'NB1731244', deliveryStatus: 'DELIVERED', ackStatus: 'ACCEPTED' },
    { id: '1000270295', bolNumber: 'NB1731245', deliveryStatus: 'DELIVERED', ackStatus: 'ACCEPTED' },
  ],
  invoices: Array.from({ length: 23 }, (_, i) => ({
    id: String(1000551321 + i), invoiceNumber: String(11419 + i),
    deliveryStatus: 'DELIVERED', ackStatus: 'ACCEPTED',
  })),
  scans: [
    { name: '7242978-SC.pdf', url: 'https://drive.google.com/file/d/a/view', dc: 'SC' },
    { name: '7242978-ST.pdf', url: 'https://drive.google.com/file/d/b/view', dc: 'ST' },
  ],
  shipDates: ['2026-08-03'],
}

test('the real PO: proven, and the signed scan is the strongest basis', () => {
  const e = shipmentEvidence(REAL)
  assert.equal(e.proven, true)
  assert.equal(e.strongest, TIER.SIGNED_SCAN)
  assert.match(evidenceHeadline(e), /^Shipped —/)
  assert.match(evidenceHeadline(e), /2 signed documents/)
  assert.match(evidenceHeadline(e), /4 ASNs accepted/)
})

test('the back-trace carries every document NUMBER, not just a count', () => {
  const e = shipmentEvidence(REAL)
  assert.equal(e.backTrace.asns.length, 4)
  assert.deepEqual(e.backTrace.asns.map((a) => a.number), ['NB1731242', 'NB1731243', 'NB1731244', 'NB1731245'])
  assert.equal(e.backTrace.invoices[0].number, '11419')
  assert.equal(e.backTrace.invoices.at(-1).number, '11441')
  assert.equal(e.backTrace.scans.length, 2, 'with their Drive links')
})

test('⚠️ OUR OWN SHIP DATE ALONE IS NOT PROOF', () => {
  // A date we typed is a claim. For Bloomingdale's, "marked shipped" even GENERATES the
  // ASN before pickup — so our record can precede the freight leaving.
  const e = shipmentEvidence({ shipDates: ['2026-08-03'] })
  assert.equal(e.proven, false)
  assert.equal(e.strongest, TIER.OUR_RECORD)
  assert.match(evidenceHeadline(e), /Only our own ship date/)
})

test('⚠️ an ASN that is DELIVERED but not ACCEPTED does not count, and is named', () => {
  // Delivered means the mailbox took it; accepted means the partner's system did. 62
  // ASNs once sat in exactly this state with real chargeback exposure.
  const e = shipmentEvidence({
    asns: [{ id: '1', bolNumber: 'NB1', deliveryStatus: 'DELIVERED', ackStatus: 'NOT_ACKNOWLEDGED' }],
  })
  assert.equal(e.proven, false)
  assert.equal(e.counts.asnsAccepted, 0)
  assert.equal(e.counts.asnsDeliveredNotAccepted, 1)
  assert.equal(e.asnDeliveredOnly[0].bolNumber, 'NB1')
})

test('ACCEPTED_WITH_ERRORS still counts as accepted', () => {
  const e = shipmentEvidence({ asns: [{ id: '1', bolNumber: 'NB1', ackStatus: 'ACCEPTED_WITH_ERRORS' }] })
  assert.equal(e.proven, true)
  assert.equal(e.strongest, TIER.ASN_ACCEPTED)
})

test('an accepted invoice alone proves it, but ranks below an ASN', () => {
  const e = shipmentEvidence({ invoices: [{ id: '1', invoiceNumber: '11419', ackStatus: 'ACCEPTED' }] })
  assert.equal(e.proven, true)
  assert.equal(e.strongest, TIER.INVOICE_ACCEPTED)
})

test('nothing at all says so plainly, and lists what is missing', () => {
  const e = shipmentEvidence({})
  assert.equal(e.proven, false)
  assert.equal(e.strongest, null)
  assert.equal(evidenceHeadline(e), 'No shipment evidence on file')
  assert.equal(e.missing.length, 4, 'every tier reported absent')
})

test('missing tiers are reported even when it IS proven', () => {
  // An absent tier is a fact about the record, not a defect — a reader deciding whether
  // to chase a scan needs to see that there is not one.
  const e = shipmentEvidence({ asns: [{ id: '1', bolNumber: 'NB1', ackStatus: 'ACCEPTED' }] })
  assert.equal(e.proven, true)
  assert.ok(e.missing.some((m) => m.tier === TIER.SIGNED_SCAN), 'no signed paper, and it says so')
})
