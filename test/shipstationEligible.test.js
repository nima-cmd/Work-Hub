// May a fulfilment be pushed to ShipStation, and at what service level. Every case
// below is a live row from 2026-08-06, the day Nima corrected the scope: the push had
// been taking `Packed` (labels already made) instead of `Picked` (labels still owed).

import test from 'node:test'
import assert from 'node:assert/strict'
import { shipstationEligibility, partitionForShipstation, HOLD, UPS_SERVICE_BY_METHOD } from '../src/model/shipstationEligible.js'

test('a UPS Picked fulfilment with no label is what we push', () => {
  // IF7451 Fresh Ink — absent from ShipStation under the old Packed-only scope.
  const v = shipstationEligibility({ status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: '4' })
  assert.equal(v.push, true)
  assert.equal(v.serviceCode, 'ups_ground')
  assert.equal(v.hold, null)
})

test('Packed is the DONE pile, not the queue', () => {
  // All 9 orders live in ShipStation were Packed. This is the inversion.
  const labelled = shipstationEligibility({ status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' })
  assert.equal(labelled.push, false)
  assert.equal(labelled.hold, HOLD.ALREADY_LABELLED)
  // Packed with NO label is the premise breaking down, so it gets its own hold.
  const bare = shipstationEligibility({ status: 'Packed', labelCount: 0, carrier: 'UPS', shipMethod: '4' })
  assert.equal(bare.push, false)
  assert.equal(bare.hold, HOLD.PACKED_NO_LABEL)
  // Anything else that isn't Picked is the plain filter.
  assert.equal(shipstationEligibility({ status: 'Shipped', carrier: 'UPS', shipMethod: '4' }).hold, HOLD.NOT_PICKED)
})

test('an existing label ends it regardless of status', () => {
  // IF7442: a NetSuite label (1ZC6J610…) AND pushed to ShipStation — the double-label
  // risk. Checked before status because the two disagree in the wild.
  for (const status of ['Picked', 'Packed', 'Shipped']) {
    const v = shipstationEligibility({ status, labelCount: 1, carrier: 'UPS', shipMethod: '4' })
    assert.equal(v.push, false, status)
    assert.equal(v.hold, HOLD.ALREADY_LABELLED, status)
    assert.match(v.reason, /already has 1 label/)
  }
})

test('a non-UPS carrier is held with the carrier named', () => {
  // IF7450 Trade, and IF7412 — which is the board's ENTIRE label nag today.
  const v = shipstationEligibility({ status: 'Picked', carrier: 'FedEx/USPS/More', shipMethod: '10272' })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.CARRIER_NOT_SET_UP)
  assert.match(v.reason, /FedEx\/USPS\/More is not set up/)
})

test('an international UPS order is held even though the carrier is right', () => {
  // IF7452 — Gee Beauty CANADA. Held on carrier too, but must not pass on country.
  const v = shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4', country: 'CA' })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.NOT_DOMESTIC)
})

test('an absent country is treated as domestic', () => {
  // US is the unstated default in this data; holding on a missing field empties
  // the queue, which is a worse failure than the one it prevents.
  assert.equal(shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4' }).push, true)
  assert.equal(shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4', country: 'US' }).push, true)
  assert.equal(shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4', country: 'United States' }).push, true)
})

test('an unmapped UPS service level is HELD, never shipped as Ground', () => {
  // The whole point: shipmethod is an opaque id (shipitem is NOT_EXPOSED), so an
  // unrecognised method must not silently become Ground. Buying Ground for someone
  // who asked for 2nd Day is a mis-ship we would hear about from the customer.
  for (const m of ['7631', '10272', '99', null, undefined]) {
    const v = shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: m })
    assert.equal(v.push, false, String(m))
    assert.equal(v.hold, HOLD.UNKNOWN_SERVICE, String(m))
  }
  // …and the one method we CAN name still works, so this isn't a blanket refusal.
  assert.equal(shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4' }).serviceCode, 'ups_ground')
})

test('third-party freight terms are HELD, not guessed', () => {
  // NetSuite will not expose thirdpartyacct to this role (parses, returns nothing).
  // Guessing is what upsRates.js exists to prevent: unset billing defaults to the
  // ECOM account 18GE01, so "we could not tell" must never become "push it anyway".
  const v = shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4', freightTerms: 'Third Party Bill' })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.THIRD_PARTY_UNREADABLE)
  assert.match(v.reason, /set the billing manually/)
})

test('no address is held — a label to nowhere is worse than a missing one', () => {
  const v = shipstationEligibility({ status: 'Picked', carrier: 'UPS', shipMethod: '4', hasAddress: false })
  assert.equal(v.hold, HOLD.NO_ADDRESS)
})

test('garbage input never pushes', () => {
  for (const a of [undefined, {}, { status: 'Picked' }, { status: null, carrier: 'UPS' }]) {
    assert.equal(shipstationEligibility(a).push, false)
  }
})

// The live boutique lane, exactly as measured on 2026-08-06. This is the regression
// test for the inversion: 4 push, 11 held, and NONE of the 9 previously-pushed
// Packed orders qualifies.
test('the live boutique lane partitions 4 push / 11 held', () => {
  const LIVE = [
    { if: 'IF7405', status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7412', status: 'Packed', labelCount: 0, carrier: 'FedEx/USPS/More', shipMethod: '7631' },
    { if: 'IF7413', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7443', status: 'Packed', labelCount: 2, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7444', status: 'Packed', labelCount: 2, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7445', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7446', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7448', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7449', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7450', status: 'Picked', labelCount: 0, carrier: 'FedEx/USPS/More', shipMethod: '10272' },
    { if: 'IF7451', status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7452', status: 'Picked', labelCount: 0, carrier: 'FedEx/USPS/More', shipMethod: '7631', country: 'CA' },
    { if: 'IF7453', status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7454', status: 'Packed', labelCount: 1, carrier: 'UPS', shipMethod: '4' },
    { if: 'IF7455', status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: '4' },
  ]
  const { push, held } = partitionForShipstation(LIVE)
  assert.deepEqual(push.map((p) => p.row.if), ['IF7405', 'IF7451', 'IF7453', 'IF7455'])
  assert.equal(held.length, 11)
  // Every hold names a reason — a warning without the fix in it is a count.
  assert.ok(held.every((h) => h.reason && h.hold))
  // The two non-UPS Picked ones are the manual-label warnings.
  const manual = held.filter((h) => h.hold === HOLD.CARRIER_NOT_SET_UP).map((h) => h.row.if)
  assert.deepEqual(manual, ['IF7450', 'IF7452'])
  // ⚠️ IF7412 gets its OWN hold, not the generic one: it is Packed with no label
  // anywhere, which is where "Packed means the label exists" breaks down. It is also
  // the board's entire label nag today, so it must not read as a routine filter.
  assert.deepEqual(held.filter((h) => h.hold === HOLD.PACKED_NO_LABEL).map((h) => h.row.if), ['IF7412'])
  // The 8 genuinely-done ones are held on their label, which is the honest reason.
  assert.equal(held.filter((h) => h.hold === HOLD.ALREADY_LABELLED).length, 8)
})

test('the service map is an allow-list, not a default', () => {
  // If this ever grows a fallback, the mis-ship guard is gone.
  assert.deepEqual(Object.keys(UPS_SERVICE_BY_METHOD), ['4'])
})

// ── Who pays (added 2026-08-06, after a real mis-billing) ───────────────────
//
// IF7405 (Saint Bernard) was pushed billed to Naghedi's Big Box account while the
// customer holds UPS 782847. Nothing was purchased, so no money moved — but unset
// billing defaults to OUR account, so the failure direction is always us paying.

test('a customer third-party account is billed to the customer, not to us', () => {
  const v = shipstationEligibility({
    status: 'Picked', shipMethodName: 'UPS® Ground',
    thirdPartyAcct: '782847', thirdPartyZip: '75247',
  })
  assert.equal(v.push, true)
  assert.equal(v.serviceCode, 'ups_ground')
  assert.deepEqual(v.billTo, { party: 'third_party', account: '782847', zip: '75247' })
})

test('no third-party account means our own account, explicitly', () => {
  // IF7451/7453/7455 — genuinely ours to pay.
  const v = shipstationEligibility({ status: 'Picked', shipMethodName: 'UPS® Ground' })
  assert.equal(v.push, true)
  assert.equal(v.billTo, null)   // caller falls back to the named Big Box account
})

test('a third-party account with no postal code is HELD', () => {
  // UPS validates third-party billing on the account zip, and the fallback direction
  // is us paying, so a missing zip is not a thing to push through.
  const v = shipstationEligibility({
    status: 'Picked', shipMethodName: 'UPS® Ground', thirdPartyAcct: '782847', thirdPartyZip: null,
  })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.THIRD_PARTY_NO_ZIP)
  assert.match(v.reason, /782847/)
})

test('a FAILED read never reads as "no third party"', () => {
  // The whole reason this hold exists: absent billing data bills us.
  const v = shipstationEligibility({ status: 'Picked', shipMethodName: 'UPS® Ground', readFailed: true })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.SHIP_DETAIL_UNREADABLE)
})

test('the service NAME beats the carrier group, which cannot tell them apart', () => {
  // ⚠️ transaction.shipcarrier is a GROUP: "FedEx/USPS/More" covers BOTH Fedex
  // (IF7452) and DHL Express (IF7450). Gating on it held the right two orders for the
  // wrong reason, and would misclassify a "More"-group order that is really UPS.
  const dhl = shipstationEligibility({ status: 'Picked', carrier: 'FedEx/USPS/More', shipMethodName: 'DHL Express' })
  assert.equal(dhl.hold, HOLD.CARRIER_NOT_SET_UP)
  assert.match(dhl.reason, /DHL Express is not set up/)

  const fedex = shipstationEligibility({ status: 'Picked', carrier: 'FedEx/USPS/More', shipMethodName: 'Fedex' })
  assert.match(fedex.reason, /Fedex is not set up/)

  // The group says not-UPS; the NAME says UPS and wins.
  const ups = shipstationEligibility({ status: 'Picked', carrier: 'FedEx/USPS/More', shipMethodName: 'UPS® Ground' })
  assert.equal(ups.push, true)
})

test('the ® in the NetSuite service name is not load-bearing', () => {
  for (const n of ['UPS® Ground', 'UPS Ground', 'ups ground', '  UPS®  Ground  ']) {
    assert.equal(shipstationEligibility({ status: 'Picked', shipMethodName: n }).serviceCode, 'ups_ground', n)
  }
})

test('a named UPS service we have not mapped is still held', () => {
  const v = shipstationEligibility({ status: 'Picked', shipMethodName: 'UPS 2nd Day Air' })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.UNKNOWN_SERVICE)
  assert.match(v.reason, /"UPS 2nd Day Air"/)
})

// The live set again, now with the REST data. The billing column is the new part.
test('the live lane bills three to us and one to the customer', () => {
  const LIVE = [
    { if: 'IF7405', status: 'Picked', shipMethodName: 'UPS® Ground', thirdPartyAcct: '782847', thirdPartyZip: '75247' },
    { if: 'IF7450', status: 'Picked', shipMethodName: 'DHL Express', thirdPartyAcct: '953308190' },
    { if: 'IF7451', status: 'Picked', shipMethodName: 'UPS® Ground' },
    { if: 'IF7452', status: 'Picked', shipMethodName: 'Fedex', thirdPartyAcct: '401715762' },
    { if: 'IF7453', status: 'Picked', shipMethodName: 'UPS® Ground' },
    { if: 'IF7455', status: 'Picked', shipMethodName: 'UPS® Ground' },
  ]
  const { push, held } = partitionForShipstation(LIVE)
  assert.deepEqual(push.map((p) => p.row.if), ['IF7405', 'IF7451', 'IF7453', 'IF7455'])
  // ⚠️ The correction: IF7405 goes on the CUSTOMER's account. It was pushed on ours.
  assert.deepEqual(push.find((p) => p.row.if === 'IF7405').billTo,
    { party: 'third_party', account: '782847', zip: '75247' })
  for (const k of ['IF7451', 'IF7453', 'IF7455']) {
    assert.equal(push.find((p) => p.row.if === k).billTo, null, k)
  }
  assert.deepEqual(held.map((h) => h.row.if), ['IF7450', 'IF7452'])
})
