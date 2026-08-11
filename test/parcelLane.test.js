import test from 'node:test'
import assert from 'node:assert/strict'
import { isParcelLane, bolAllowed, noBolReason, PARCEL_LANE_SQL } from '../src/model/parcelLane.js'
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
