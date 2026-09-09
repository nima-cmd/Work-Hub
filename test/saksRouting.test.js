// test/saksRouting.test.js — the rules, and the real shipment that exercises them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dcFor, modeFor, documentsRequired, checkSaksShipment, businessDaysBefore,
  DEADLINES, AUDIT, PROHIBITED,
} from '../src/model/saksRouting.js'

const WED_9_SEP = new Date('2026-09-09T12:00:00Z')

test('⚠️ THE DC CODE IS ZERO-PADDED IN EDI AND BARE IN THE GUIDE', () => {
  // PO 0008928906 carries ship-to `0510`; the guide's table says `510`. A lookup that
  // misses means somebody types an address by hand.
  assert.equal(dcFor('0510').abbrev, 'PNDC')
  assert.equal(dcFor('510').abbrev, 'PNDC')
  assert.equal(dcFor(510).name, 'NMG-Pinnacle Point')
  assert.deepEqual(dcFor('0510').address, ['4123 Pinnacle Point Dr', 'Dallas, TX 75211'])
  assert.equal(dcFor('999'), null, 'an unknown code is null, never a guess')
})

test('⚠️ 11 CARTONS AT 266 LB MATCHES NEITHER DEFINITION — the real IF7650', () => {
  // Parcel is <=15 cartons AND <150 lb. LTL is >15 cartons AND >150 lb. This is
  // inside the carton ceiling and far over the weight one, so it satisfies neither,
  // and guessing parcel costs full freight plus $75 a package.
  const m = modeFor({ cartons: 11, weightLb: 266 })
  assert.equal(m.mode, 'ask-tms')
  assert.equal(m.certain, false)
  assert.match(m.reason, /NEITHER definition/)
  assert.match(m.reason, /do not assume parcel/)
})

test('the unambiguous modes are still called', () => {
  assert.equal(modeFor({ cartons: 4, weightLb: 60 }).mode, 'parcel')
  assert.equal(modeFor({ cartons: 40, weightLb: 900 }).mode, 'LTL')
  assert.equal(modeFor({ cartons: 200, weightLb: 9000 }).mode, 'TL')
  assert.equal(modeFor({ cartons: 30, weightLb: 400, pallets: 9 }).mode, 'TL', 'pallets alone can make it TL')
  assert.equal(modeFor({ cartons: 30, weightLb: 400, cubicFeet: 800 }).mode, 'TL', 'so can cubic feet')
})

test('⚠️ THE MANIFEST IS REQUIRED WHETHER OR NOT WE SEND AN ASN', () => {
  // The one document that does not depend on EDI status at all — and the one we do
  // not currently produce.
  for (const asn of [true, false, undefined]) {
    const d = documentsRequired({ asnWillBeSent: asn })
    assert.equal(d.manifest.required, true)
    assert.equal(d.masterBol.required, true)
    assert.match(d.manifest.why, /Required for all shipments/)
  }
})

test('⚠️ THE PACKING SLIP TURNS ON WHETHER THE 856 ACTUALLY GOES OUT', () => {
  // Not on whether we call ourselves EDI-capable. We receive Saks 850s (newest
  // 2026-09-03) but the last 856 DELIVERED to that partner was 2024-11-01.
  assert.equal(documentsRequired({ asnWillBeSent: true }).packingSlip.required, false)

  const no = documentsRequired({ asnWillBeSent: false })
  assert.equal(no.packingSlip.required, true)
  assert.match(no.packingSlip.why, /expense offset fee/)
  assert.ok(no.packingSlip.rules.some((r) => /all six sides/.test(r)))
  assert.ok(no.packingSlip.rules.some((r) => /PER PURCHASE ORDER/.test(r)))

  // ⚠️ Unknown is its own answer. Defaulting to "not required" because we are
  // nominally EDI-capable is exactly how an expense offset fee arrives unexplained.
  const unknown = documentsRequired({})
  assert.equal(unknown.packingSlip.required, null)
  assert.match(unknown.packingSlip.why, /2024-11-01/)
})

test('business days skip weekends, and the helper admits it ignores holidays', () => {
  // Cancel Friday 2026-09-11, three business days prior = Tuesday 2026-09-08.
  assert.equal(businessDaysBefore('2026-09-11', 3), '2026-09-08')
  // Across a weekend: Monday 2026-09-14 minus 3 = Wednesday 2026-09-09.
  assert.equal(businessDaysBefore('2026-09-14', 3), '2026-09-09')
  assert.equal(businessDaysBefore('nonsense', 3), null)
})

test('⚠️ PO 0008928906 IS ALREADY PAST ITS TMS ROUTING DEADLINE', () => {
  // Real: cancel 2026-09-11, no confirmation number, today Wednesday 2026-09-09.
  const r = checkSaksShipment(
    { dcCode: '0510', cancelAfter: '2026-09-11', cartons: 11, weightLb: 266 },
    { today: WED_9_SEP },
  )
  const late = r.blocking.find((f) => f.what === 'Past the TMS routing deadline')
  assert.ok(late, 'the deadline must be reported, not merely computable')
  assert.match(late.detail, /required routing by 2026-09-08/)
  assert.equal(r.dc.abbrev, 'PNDC')
})

test('the two things that always block a BOL are named separately', () => {
  const r = checkSaksShipment({ dcCode: '0510', cartons: 4, weightLb: 60 }, { today: WED_9_SEP })
  const whats = r.blocking.map((f) => f.what)
  assert.ok(whats.includes('No TMS confirmation number'))
  assert.ok(whats.includes('Freight terms unknown'))
  // ⚠️ Freight terms say where to ask, because the guide is explicit that Logistics
  // will not answer it and people ask them anyway.
  assert.match(r.blocking.find((f) => f.what === 'Freight terms unknown').detail, /buying office/)
})

test('⚠️ A CARTON COUNT MISMATCH IS PRICED, NOT JUST FLAGGED — IF7650', () => {
  // Ten cartons exist, all declaring of_total 11.
  const r = checkSaksShipment(
    { dcCode: '0510', cartonsDeclared: 11, cartonsActual: 10, cartons: 11, weightLb: 266 },
    { today: WED_9_SEP },
  )
  const f = r.blocking.find((x) => x.what === 'Carton count does not match')
  assert.ok(f)
  assert.match(f.detail, /\$1000\/month|\$1,000/)
  assert.match(f.detail, /Vendor Audit Program/)
  assert.equal(AUDIT.itemErrorRateTrigger, 0.02)
})

test('a full truckload with no seal number is rejected at pickup, so it blocks', () => {
  const r = checkSaksShipment({ dcCode: '0510', cartons: 300, weightLb: 9000, tmsConfirmation: 'X', freightTerms: 'Collect' }, { today: WED_9_SEP })
  assert.ok(r.blocking.some((f) => f.what === 'No bolt seal number'))
  // An LTL does NOT need one — multiple stops, seal not required (guide p11).
  const ltl = checkSaksShipment({ dcCode: '0510', cartons: 40, weightLb: 900, tmsConfirmation: 'X', freightTerms: 'Collect', palletIndicator: 'Y' }, { today: WED_9_SEP })
  assert.deepEqual(ltl.blocking, [])
})

test('an unknown DC blocks rather than letting someone type an address', () => {
  const r = checkSaksShipment({ dcCode: '0999' }, { today: WED_9_SEP })
  assert.ok(r.blocking.some((f) => f.what === 'Unknown DC'))
  assert.equal(r.dc, null)
})

test('the prohibition only WE can catch is marked as such', () => {
  const ours = PROHIBITED.filter((p) => p.appCanCatch)
  assert.ok(ours.some((p) => /Multiple BOLs to the same destination/.test(p.rule)),
    'we mint the BOL numbers, so nothing else can see this before it is printed')
  assert.equal(DEADLINES.tmsRouting.businessDaysBeforeCancel, 3)
  assert.deepEqual(DEADLINES.asn.hoursBeforeArrival, [24, 48])
})
