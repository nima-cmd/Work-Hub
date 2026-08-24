import test from 'node:test'
import assert from 'node:assert/strict'
import { isParcelLane, bolAllowed, noBolReason, showsParcelPushButton, PARCEL_LANE_SQL } from '../src/model/parcelLane.js'
import { partnerForDc } from '../src/model/dc.js'
import { deriveSource } from '../src/model/source.js'

// The gap: ShopBop is an EDI partner that ships small parcel, so it had neither
// label lane — the boutique push filtered on source='boutique', and the EDI push
// could only build from a routing shipment (i.e. from a BOL it must never get).

test('parcel lane: ShopBop is EDI by channel and parcel by lane — both stay true', () => {
  const shopbop = { customer: 'ShopBop', location: 'Shopbop' }
  // The channel classification is UNCHANGED — the whole pipeline keys on it.
  assert.equal(deriveSource(shopbop.customer, shopbop.location), 'edi')
  // ...and the lane is answered separately.
  assert.equal(isParcelLane(shopbop), true)
  assert.equal(isParcelLane({ customer: 'ShopBop - SDF4' }), true)
  assert.equal(isParcelLane({ location: 'Shopbop' }), true)
})

test('parcel lane: freight EDI partners and boutiques are not in it', () => {
  assert.equal(isParcelLane({ customer: "Bloomingdale's - 0001 59th St. - New York" }), false)
  assert.equal(isParcelLane({ customer: 'Nordstrom - 004 Bellevue Square' }), false)
  assert.equal(isParcelLane({ customer: 'Saint Bernard' }), false)
  assert.equal(isParcelLane({}), false)
})

test('parcel lane: no BOL for ShopBop, and the refusal says what to do instead', () => {
  assert.equal(bolAllowed({ customer: 'ShopBop' }), false)
  assert.equal(bolAllowed({ customer: "Bloomingdale's - 0053 Soho" }), true)
  const why = noBolReason({ customer: 'ShopBop' })
  assert.match(why, /1135EW/)          // their account, not ours
  assert.match(why, /Source Alliance/) // who issues it when it IS freight
  assert.match(why, /ShipStation/)     // the alternative, not just a refusal
  assert.equal(noBolReason({ customer: 'Nordstrom - 599' }), null)
})

test('parcel lane: the SQL fragment and the predicate come from one list', () => {
  // Both consumers derive from PARCEL_PARTNER_NAMES — a rule written twice drifts.
  assert.match(PARCEL_LANE_SQL, /o\.customer ILIKE '%shopbop%'/)
  assert.match(PARCEL_LANE_SQL, /o\.location ILIKE '%shopbop%'/)
  // No backticks: this string is interpolated into a template literal in
  // server/queries.js, where a backtick would close the SQL and 500 the API.
  assert.equal(PARCEL_LANE_SQL.includes('`'), false)
})

test('partnerForDc: a ShopBop FC is ShopBop, not the Bloomingdale default', () => {
  // The live defect: SBX2 resolved to Bloomingdale's, which is how BOL NB1731262
  // was minted for a ShopBop PO and filed under the wrong partner.
  assert.equal(partnerForDc('SBX2'), 'Shopbop')
  assert.equal(partnerForDc('SDF4'), 'Shopbop')
  assert.equal(partnerForDc('sbx2'), 'Shopbop')
  // The two established branches are untouched.
  assert.equal(partnerForDc('599'), 'Nordstrom')
  assert.equal(partnerForDc('089'), 'Nordstrom')
  assert.equal(partnerForDc('SC'), "Bloomingdale's")
  assert.equal(partnerForDc('CG'), "Bloomingdale's")
})

// ── The break-glass push (Nima, 2026-08-11) ──────────────────────────────────
// "sometimes the netsuite UPS label creator has issues and we're in a rush and
// printing it in shipstation if we can push the data out would be better than
// manually creating the label ourself."
//
// The override must lift the POLICY block and never the FACT block, so these two
// guards are asserted to live in different places on purpose.

test('break-glass: force lifts the location policy', async () => {
  const { pushingAllowed } = await import('../src/model/labelSource.js')
  // Warehouse is NetSuite's to label — blocked by policy, forceable by a human
  // who knows NetSuite's label creator is down.
  assert.equal(pushingAllowed({ location: 'Warehouse' }), false)
  assert.equal(pushingAllowed({ location: 'Warehouse', force: true }), true)
})

test('break-glass: force can NEVER lift an existing label', async () => {
  const { shipstationEligibility, HOLD } = await import('../src/model/shipstationEligible.js')
  // labelCount lives in the ELIGIBILITY model, which the force flag does not
  // reach — two live labels on one box is a double charge and a wrong tracking
  // number on the ASN. There is deliberately no force parameter here to pass.
  const v = shipstationEligibility({ status: 'Picked', labelCount: 1, carrier: 'UPS', shipMethodName: 'UPS® Ground' })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.ALREADY_LABELLED)
  // Belt and braces: the function takes no `force`, so no caller can smuggle one.
  const forced = shipstationEligibility({ status: 'Picked', labelCount: 1, carrier: 'UPS', shipMethodName: 'UPS® Ground', force: true })
  assert.equal(forced.push, false)
})

// ── The button that could never appear (2026-08-24) ─────────────────────────
//
// Nima: "my shopbop isn't going into shipstation". The push path was fine — a dry
// run created WH-IF7533 / POJ00384243 without complaint. The button simply was not
// on the card, because Kanban.jsx gated it on
//     !o.isGroup && (o.source !== 'edi' || isParcelLane(o))
// and EDI orders are ALWAYS grouped into PO cards, so the parcel-lane exception
// sitting right beside `!o.isGroup` was unreachable for every EDI order — i.e. for
// the only partner it was written for.

test('a GROUPED ShopBop PO card offers the push button — the case that was dead', () => {
  assert.equal(showsParcelPushButton({
    isGroup: true, source: 'edi', customer: 'ShopBop - SDF4', location: 'Shopbop',
  }), true)
})

test('the old condition really was unreachable, so this is not a cosmetic change', () => {
  const o = { isGroup: true, source: 'edi', customer: 'ShopBop - SDF4', location: 'Shopbop' }
  const old = !o.isGroup && (o.source !== 'edi' || isParcelLane(o))
  assert.equal(old, false, 'the old gate refused it')
  assert.equal(showsParcelPushButton(o), true, 'the new one allows it')
})

test('an ungrouped ShopBop order still offers it', () => {
  assert.equal(showsParcelPushButton({
    isGroup: false, source: 'edi', customer: 'ShopBop', location: 'Shopbop',
  }), true)
})

test('an EDI FREIGHT group never offers it — its label question is a BOL', () => {
  assert.equal(showsParcelPushButton({
    isGroup: true, source: 'edi', customer: "Bloomingdale's", location: 'Warehouse',
  }), false)
  assert.equal(showsParcelPushButton({
    isGroup: true, source: 'edi', customer: 'Nordstrom (US) (Direct to Store)', location: 'Warehouse',
  }), false)
})

test('a boutique GROUP still does not, so GroupLabelButtons is not doubled up', () => {
  assert.equal(showsParcelPushButton({
    isGroup: true, source: 'boutique', customer: 'Gee Beauty Canada', location: 'Warehouse',
  }), false)
})

test('a boutique single order is unchanged', () => {
  assert.equal(showsParcelPushButton({
    isGroup: false, source: 'boutique', customer: "Gracie's", location: 'Warehouse',
  }), true)
})
