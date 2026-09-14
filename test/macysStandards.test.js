// test/macysStandards.test.js — Appendix H of the Macy's 2023 Vendor Standards.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OFFSETS, offsetFor, SOURCE, RATE_CHANGES, VS_EXEMPLAR } from '../src/model/macysStandards.js'

test('⚠️ A SHORTAGE IS PRICED ON THE GOODS, NOT AS A FLAT FEE', () => {
  // The answer to "what does a short ship cost with Bloomingdale's". Exemplar is
  // $500 per incident; Macy's is "$50.00 per receipt and 50% cost of merchandise".
  // Assuming Exemplar's shape here understates it by an order of magnitude.
  const o = OFFSETS.poNoncompliance
  assert.equal(o.perReceipt, 50)
  assert.equal(o.pctOfMerchandise, 0.5)
  assert.equal(o.perUnitCollateral, 1)
  // ⚠️ ONE offset covers all three failures, so a substitution prices the same way.
  assert.deepEqual(o.covers, ['shortage', 'substitution', 'overage'])
})

test('⚠️ A PERCENTAGE LINE WITH NO MERCHANDISE VALUE RETURNS null, NEVER $50', () => {
  // "50% cost of merchandise" with the merchandise unknown is an UNKNOWN cost.
  // Returning the flat part alone would report today's four short shipments as a
  // $50 problem when the percentage is most of the number.
  const blind = offsetFor('poNoncompliance', { receipts: 4 })
  assert.equal(blind.estimate, null)
  assert.equal(blind.known, 200)
  assert.match(blind.unknown, /50% of the merchandise cost/)
  assert.match(blind.note, /not the exposure/)

  // Given the value it computes.
  const known = offsetFor('poNoncompliance', { receipts: 4, merchandiseUsd: 1000 })
  assert.equal(known.estimate, 700)   // 4 x $50 + 50% of $1,000
})

test('⚠️ MOST LINES ARE A RECEIPT FEE **AND** A PER-UNIT AMOUNT', () => {
  // Reading the left-hand number alone understates nearly every line in Appendix H —
  // the same shape as Exemplar's minimum-charge column.
  const t = offsetFor('ticketing', { receipts: 1, units: 100 })
  assert.equal(t.estimate, 125)  // $50 + 100 x $0.75, not $50
  const g = offsetFor('gs1FobDept', { receipts: 1, cartons: 22 })
  assert.equal(g.estimate, 66.5) // $50 + 22 x $0.75
})

test('the per-receipt minimum floors a per-carton line', () => {
  // $5.00 per carton, minimum $50.00 per receipt: one bad carton is still $50.
  assert.equal(offsetFor('gs1Placement', { receipts: 1, cartons: 1 }).estimate, 50)
  assert.equal(offsetFor('gs1Placement', { receipts: 1, cartons: 30 }).estimate, 150)
})

test('⚠️ CROSS-DOCK REMOVAL IS PER UNIT AND ONGOING', () => {
  // PO 1236143 is XDOCK. Losing the programme is not a one-off — it is $50 per
  // receipt and $1 per unit on everything after it.
  const o = OFFSETS.integrityAudit
  assert.equal(o.perUnit, 1)
  assert.match(o.note, /on every shipment thereafter/)
  assert.equal(offsetFor('integrityAudit', { receipts: 1, units: 426 }).estimate, 476)
})

test('⚠️ THE EDITION IS 2023 AND MUST BE VERIFIED BEFORE QUOTING', () => {
  // A three-year-old standards document sits beside a routing guide this repo cites
  // as "rev 4/14/26". Quoting a stale figure back to a partner is worse than saying
  // you do not know.
  assert.equal(SOURCE.edition, '2023')
  assert.equal(SOURCE.verifyBeforeQuoting, true)
  assert.equal(SOURCE.documentKey, 'bloomingdales-vendor-standards')
  // And a rate inside it already changed once mid-edition.
  assert.equal(RATE_CHANGES[0].from, 0.60)
  assert.equal(RATE_CHANGES[0].to, 0.75)
})

test("⚠️ EXEMPLAR'S NUMBERS DO NOT TRANSFER", () => {
  assert.equal(VS_EXEMPLAR.shortShip.exemplar.amount, 500)
  assert.equal(VS_EXEMPLAR.shortShip.macys.pctOfMerchandise, 0.5)
  assert.match(VS_EXEMPLAR.shortShip.why, /almost the whole exposure/)
})

test('an unknown offset key is null, not a guess', () => {
  assert.equal(offsetFor('nonsense', { receipts: 1 }), null)
})
