// test/ediPoPurpose.test.js — what an 850 says it is, and when that needs a person.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describePurpose, purposeAlert, purposeAlerts, PURPOSE_CODES, REVISION_CODES } from '../src/model/ediPoPurpose.js'
import { extractPoPurpose } from '../src/ingest/orderfulDates.js'

// The real body, as Orderful returned it for transaction 1036468265.
const CANCEL_850 = {
  transactionSets: [{
    beginningSegmentForPurchaseOrder: [{
      transactionSetPurposeCode: '01', purchaseOrderTypeCode: 'SA',
      purchaseOrderNumber: '50073678', date: '20260409',
    }],
    PO1_loop: [{ baselineItemData: [{ assignedIdentification: '1' }] }],
  }],
}
// And the duplicate re-send that arrived the day before (1035957273).
const DUPLICATE_850 = {
  transactionSets: [{
    beginningSegmentForPurchaseOrder: [{ transactionSetPurposeCode: '07', purchaseOrderNumber: '50073678' }],
  }],
}

test('⚠️ THE CANCELLATION OF PO 50073678 IS READ AS A CANCELLATION', () => {
  // It was stored as `0 units, 1 line` and read as an empty order for a month.
  // The code was in the payload the whole time.
  assert.equal(extractPoPurpose(CANCEL_850), '01')
  const p = describePurpose(extractPoPurpose(CANCEL_850))
  assert.equal(p.label, 'Cancellation')
  assert.equal(p.revision, true)
})

test('⚠️ AND THE "MYSTERY" RE-SENDS ARE READ AS DUPLICATES', () => {
  // Five of these arrived for one PO. We had blamed delivery_status = PENDING;
  // the document said 07 — sent deliberately — all along.
  assert.equal(extractPoPurpose(DUPLICATE_850), '07')
  assert.equal(describePurpose('07').revision, false)
})

test('⚠️ A MISSING CODE IS NOT "ORIGINAL"', () => {
  // Defaulting would assert a fact the document never carried, and manufacture
  // exactly the reassurance this module exists to remove.
  const p = describePurpose(null)
  assert.equal(p.code, null)
  assert.equal(p.label, 'not stated')
  assert.equal(p.known, false)
  assert.equal(extractPoPurpose({}), null)
  assert.equal(extractPoPurpose({ transactionSets: [{}] }), null)
  assert.equal(extractPoPurpose({ transactionSets: [{ beginningSegmentForPurchaseOrder: [{ transactionSetPurposeCode: '' }] }] }), null)
})

test('⚠️ AN UNRECOGNISED CODE IS FLAGGED, NOT DROPPED', () => {
  // The whole failure was a real code going unread. A partner inventing "ZZ" must
  // not read as "nothing to see" — being wrong towards a glance is the cheap way.
  const p = describePurpose('ZZ')
  assert.equal(p.known, false)
  assert.equal(p.revision, true)
  assert.match(p.label, /unrecognised/)
  assert.equal(p.code, 'ZZ', 'the raw value survives')
})

test('the raw code always survives, whitespace and all', () => {
  assert.equal(describePurpose(' 01 ').code, '01')
  assert.equal(describePurpose(1).code, '1')
})

test('⚠️ SEVERITY COMES FROM WHAT WE ALREADY DID, NOT THE CODE ALONE', () => {
  // A cancel on a Pending Fulfillment order is ordinary business. The same code
  // against shipped, invoiced freight is a money conversation. 50073678 was the
  // second kind and the app said nothing.
  const fresh = purposeAlert('01', { shipped: false, invoiced: false })
  assert.equal(fresh.severity, 'notice')

  const acted = purposeAlert('01', { shipped: true, invoiced: true })
  assert.equal(acted.severity, 'critical')
  assert.match(acted.message, /already shipped and invoiced/)
  assert.match(acted.message, /^WARNING: /)
})

test('shipped alone is enough to make it critical', () => {
  assert.equal(purposeAlert('04', { shipped: true }).severity, 'critical')
  assert.equal(purposeAlert('04', { invoiced: true }).severity, 'critical')
})

test('⚠️ NO CHARACTER OUTSIDE WinAnsi IN A MESSAGE', () => {
  // These strings reach the pick ticket's PDF renderer's world eventually, and
  // pdfkit's Helvetica printed "⚠" as "&". Keep the warning word-based.
  for (const c of ['01', '04', 'ZZ']) {
    const m = purposeAlert(c, { shipped: true }).message
    assert.doesNotMatch(m, /[←-⯿]/, m)
  }
})

test('originals, confirmations and duplicates raise nothing', () => {
  for (const c of ['00', '06', '07', '22']) {
    assert.equal(purposeAlert(c, { shipped: true, invoiced: true }), null, `code ${c} should be quiet`)
  }
})

test('every revision code is a revision, and the two lists agree', () => {
  assert.deepEqual(REVISION_CODES.sort(), ['01', '02', '03', '04', '05'])
  for (const c of REVISION_CODES) assert.equal(PURPOSE_CODES[c].revision, true)
})

test('⚠️ THE LIST DOES NOT INCLUDE THE NOISE THAT CAUSED THE CONFUSION', () => {
  // Live 2026-09-08: PO 50073678 had FIVE purpose-07 re-sends against ONE
  // cancellation. Listing the 07s buries the row that matters.
  const rows = [
    { id: '1', businessNumber: '50073678', createdAt: '2026-09-07T10:37:42Z', purposeCode: '07', shipped: true },
    { id: '2', businessNumber: '50073678', createdAt: '2026-09-08T01:22:41Z', purposeCode: '01', shipped: true, invoiced: true },
    { id: '3', businessNumber: '50073688', createdAt: '2026-09-03T19:28:16Z', purposeCode: '07', shipped: true },
  ]
  const out = purposeAlerts(rows)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '2')
  assert.equal(out[0].severity, 'critical')
})

test('critical sorts above notice, then newest first', () => {
  const out = purposeAlerts([
    { id: 'old-crit', createdAt: '2026-01-01T00:00:00Z', purposeCode: '01', shipped: true },
    { id: 'new-notice', createdAt: '2026-09-08T00:00:00Z', purposeCode: '01' },
    { id: 'newer-crit', createdAt: '2026-09-09T00:00:00Z', purposeCode: '04', invoiced: true },
  ])
  assert.deepEqual(out.map((o) => o.id), ['newer-crit', 'old-crit', 'new-notice'])
})

test('it reads snake_case rows straight from the database projection', () => {
  const out = purposeAlerts([
    { id: '9', business_number: '50073678', created_at: '2026-09-08T01:22:41Z', po_purpose_code: '01', shipped: true },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].businessNumber, '50073678')
})
