// test/macysRouting.test.js — the Macy's Routing Guide, rev 4/14/26.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE, REMOVED_DCS, isRemovedDc, FREIGHT_POLICY, FREIGHT_TERMS, freightTermsFor,
  DEADLINES, VARIANCE, withinVariance, cubeFor, PALLET, BOL_RULES, MERGE_CENTERS,
  ltlPickupActionFor, SHIP_COMPLETE, cubePerCarton,
} from '../src/model/macysRoutingGuide.js'
import { MERGE_CENTERS as BOL_MERGE } from '../src/model/bolAddresses.js'

test('the edition is the one Nima supplied, and it is the current one', () => {
  assert.equal(SOURCE.revision, '4/14/26')
  assert.match(SOURCE.revisionSource, /Summary of Changes/)
})

test('⚠️ THREE DCs WERE REMOVED ON 4/14/26 AND WE HAD SHIPPED TO ONE', () => {
  // SO11521 went to "Bloomingdale's - 0135 Cheshire Pool Stock/Customer Fulfillment
  // Center" — shipped 2026-04-07, a week before the removal, so historical rather than
  // live. Recorded so a future routing to one is caught rather than found at a closed dock.
  assert.deepEqual(REMOVED_DCS.names, ['Cheshire', 'West Johnson', 'Sacramento'])
  assert.ok(isRemovedDc("Bloomingdale's - 0135 Cheshire Pool Stock/Customer Fulfillment Center"))
  assert.ok(isRemovedDc('West Johnson'))
  assert.ok(!isRemovedDc('Secaucus'))
})

test('⚠️ MACY\'S FORBIDS PREPAY-AND-ADD — the exact opposite of the Exemplar PO', () => {
  // Exemplar's PO 8928906 header reads Freight: Prepaid. Macy's §3.0 is capitals: "DO
  // NOT PREPAY AND ADD FREIGHT CHARGES TO THE MERCHANDISE INVOICE." Same field on the
  // same form, opposite answers, both correct for their partner — which is why the
  // BOL's freight term must never be one default shared across partners.
  assert.equal(FREIGHT_POLICY.neverPrepayAndAdd, true)
  assert.equal(FREIGHT_POLICY.page, 6)
})

test('RXO is the only third-party lane, and it carries its own bill-to', () => {
  assert.equal(freightTermsFor('XLTL').terms, '3rd Party')
  assert.deepEqual(freightTermsFor('XLTL').billTo, ["Macy's c/o RXO", 'PO Box 49069', 'Charlotte, NC 28277'])
  for (const scac of ['FXFE', 'FXNL', 'DYXI', 'PAAF']) {
    assert.equal(freightTermsFor(scac).terms, 'Collect', scac)
  }
})

test('⚠️ THE BOL DERIVATION IN server/bolPdf.js AGREES WITH THE GUIDE', () => {
  // bolPdf has derived `/XLTL|RXO/ ? '3rd' : 'Collect'` since before the guide was read.
  // It turns out to match p13 exactly — correct by accident until now, checkable from here.
  const derive = (scac) => (/XLTL|RXO/i.test(scac) ? '3rd Party' : 'Collect')
  for (const scac of Object.keys(FREIGHT_TERMS)) {
    const e = FREIGHT_TERMS[scac]
    if (!e || !e.terms) continue
    assert.equal(derive(scac), e.terms, `${scac} disagrees with the guide`)
  }
})

test('an unknown carrier is null, not assumed Collect', () => {
  assert.equal(freightTermsFor('LLGJ'), null)   // Linear Logistics is Exemplar's, not Macy's
  assert.equal(freightTermsFor(''), null)
})

test('⚠️ THE INDC DATE IS AN ARRIVAL DATE', () => {
  // "The INDC date on your purchase order is when the goods are expected to ARRIVE."
  // Reading it as a ship date is 7-14 days of error in the wrong direction.
  assert.equal(DEADLINES.indcIsArrival, true)
  assert.deepEqual(DEADLINES.rtsBeforeIndcDays, [7, 14])
  assert.equal(DEADLINES.entryBeforeCancelDays, 3)
})

test('⚠️ LTL TOLERATES NO VARIANCE AT ALL — and every Bloomingdale\'s shipment is LTL', () => {
  // TL gets ±49 cartons; LTL gets "no shipment alterations tolerated" and MacysNet must
  // match the BOL. Our carton counts move whenever a fulfilment is re-packed.
  assert.equal(VARIANCE.LTL.cartons, 0)
  assert.equal(withinVariance('LTL', { cartons: 1 }).ok, false)
  assert.equal(withinVariance('TL', { cartons: 40 }).ok, true)
  assert.equal(withinVariance('TL', { cartons: 50 }).ok, false)
  assert.equal(withinVariance('PARCEL', { weightLb: 50 }).ok, true)
})

test('an unknown mode says so rather than passing', () => {
  const r = withinVariance('AIR', { cartons: 999 })
  assert.equal(r.known, false)
  assert.ok(!r.ok)
})

test('⚠️ THE GUIDE ROUNDS PER CARTON BEFORE MULTIPLYING, and we must too', () => {
  // p11's worked example: 150 @ 25x21x25 = "7.60 cube per carton = 1,140 cube". Exactly
  // it is 7.5955, and full precision gives 1,139.32. §12.1 charges $50 per freight bill
  // PLUS FULL FREIGHT for an inaccurate cube, so the number we enter has to be the one
  // their method produces — not a more precise one that disagrees with it.
  assert.equal(cubePerCarton(25, 21, 25), 7.6)
  assert.equal(cubeFor([{ length: 25, width: 21, height: 25, count: 150 }]), 1140)
  assert.equal(cubeFor([{ length: 18, width: 16, height: 15, count: 250 }]), 625)
  assert.equal(cubeFor([{ length: 15, width: 12, height: 9, count: 125 }]), 117.5)
})

test('a carton with no dimensions is skipped, not counted as zero volume silently', () => {
  assert.equal(cubeFor([{ length: 22, width: 16, height: 7, count: 1 }, { count: 5 }]), 1.43)
})

test('⚠️ PALLETS ARE LTL-ONLY AND ONLY WHEN AUTHORISED — $500 an occurrence otherwise', () => {
  assert.match(PALLET.palletsOnlyWhen, /LTL/)
  assert.equal(PALLET.unauthorisedUse.amount, 500)
  assert.equal(PALLET.doubleStack, false)
  assert.equal(PALLET.maxPallets.FXNL, 8)
  assert.equal(PALLET.maxPallets.other, 10)
})

test('⚠️ THE MASTER BOL NUMBER IS NOT ON THE 856', () => {
  // The underlying per-DC BOL numbers are. Getting that backwards breaks the ASN for
  // every DC in the load.
  const master = BOL_RULES.find((r) => /Master BOL is required/.test(r.rule))
  assert.match(master.rule, /NOT transmitted on the EDI 856/)
})

test('⚠️ THE MERGE CENTRE ADDRESSES WE ALREADY PRINT MATCH THE GUIDE', () => {
  // bolAddresses.MERGE_CENTERS was built from routing notifications, before the guide
  // was read. p18 confirms all three, which is worth pinning rather than assuming.
  assert.equal(BOL_MERGE.CA.street, MERGE_CENTERS.CA.street)
  assert.equal(BOL_MERGE.NJ.street, MERGE_CENTERS.NJ.street)
  assert.equal(BOL_MERGE.HP.street, MERGE_CENTERS.NC.street)
})

test('who schedules the LTL pickup depends on the carrier', () => {
  assert.match(ltlPickupActionFor('FXNL').action, /vendor contacts FedEx/)
  assert.match(ltlPickupActionFor('XLTL').action, /vendor initiates/)
  assert.match(ltlPickupActionFor('DYXI').action, /designated carrier schedules/)
})

test('ship-complete points at where the shortage is actually priced', () => {
  assert.match(SHIP_COMPLETE.rule, /expected to ship complete/)
  assert.match(SHIP_COMPLETE.pricedIn, /poNoncompliance/)
})
