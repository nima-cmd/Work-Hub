import test from 'node:test'
import assert from 'node:assert/strict'
import { authProvenance, AUTH_SOURCE, AUTH_STATE } from '../src/model/routingAuthSource.js'

const bloom = (over = {}) => ({
  partner: "Bloomingdale's", dc: 'SC', projectNumber: '9022514', shipmentNumber: '52172263', ...over,
})

test('a parcel lane never has an authorization at all', () => {
  const p = authProvenance({ group: { partner: 'ShopBop', dc: 'SBX2' } })
  assert.equal(p.source, AUTH_SOURCE.NONE)
  assert.equal(p.state, AUTH_STATE.NOT_APPLICABLE)
  assert.equal(p.arrived, null)
})

// Live row #29: a ShopBop shipment STORED as "Bloomingdale's" (partnerForDc resolves
// every non-numeric DC that way). Trusting the stored partner sent the card looking
// for a Macy's routing email that will never arrive. The DC is the objective field.
test('the DC outranks a stored partner that is wrong', () => {
  const p = authProvenance({
    shipment: { partner: "Bloomingdale's", dc: 'SBX2', status: 'needs_routing' },
  })
  assert.equal(p.source, AUTH_SOURCE.NONE)
  assert.equal(p.state, AUTH_STATE.NOT_APPLICABLE)
})

test('a numeric DC is Nordstrom even if the row says otherwise', () => {
  const p = authProvenance({ shipment: { partner: "Bloomingdale's", dc: '569' } })
  assert.equal(p.source, AUTH_SOURCE.NORDSTROM_TENDER)
})

test('Nordstrom has no authorization number — it says so instead of reading as missing', () => {
  const p = authProvenance({ shipment: { partner: 'Nordstrom', dc: '569' } })
  assert.equal(p.source, AUTH_SOURCE.NORDSTROM_TENDER)
  assert.equal(p.state, AUTH_STATE.NOT_APPLICABLE)
  assert.match(p.detail, /Mark routed/)
})

test('Nordstrom names whether a TMS tender has been ingested', () => {
  const withT = authProvenance({ shipment: { partner: 'Nordstrom', tender: { shipmentId: 'S1' } } })
  const without = authProvenance({ shipment: { partner: 'Nordstrom' } })
  assert.match(withT.detail, /tender carries the pickup date/)
  assert.match(without.detail, /No tender ingested/)
})

test('an applied authorization says which number is on the card', () => {
  const p = authProvenance({ shipment: bloom({ authNumber: '00052850382S' }), notification: null })
  assert.equal(p.state, AUTH_STATE.APPLIED)
  assert.equal(p.arrived, true)
  assert.match(p.detail, /00052850382S/)
})

// ⚠️ The distinction this module exists for. `undefined` = nobody looked;
// `null` = we looked and there was nothing. Collapsing them is how a lane starts
// LOOKING automated while being hand entry.
test('undefined notification reports "nothing reads this", not "not arrived"', () => {
  const p = authProvenance({ shipment: bloom() })
  assert.equal(p.state, AUTH_STATE.NOT_READ)
  assert.equal(p.manual, true)
  assert.equal(p.arrived, null)
  assert.match(p.detail, /Nothing in this app reads that email/)
  assert.match(p.detail, /9022514/)
})

test('null notification with refs entered is an honest "waiting"', () => {
  const p = authProvenance({ shipment: bloom(), notification: null })
  assert.equal(p.state, AUTH_STATE.WAITING)
  assert.equal(p.arrived, false)
  assert.equal(p.manual, false)
  assert.match(p.detail, /52172263/)
})

test('no project/shipment number means nothing CAN match — a different sentence', () => {
  const p = authProvenance({
    shipment: bloom({ projectNumber: null, shipmentNumber: null }), notification: null,
  })
  assert.equal(p.state, AUTH_STATE.NO_REFS)
  assert.match(p.detail, /no notification can match/)
})

test('a matched-but-unapplied notification is its own state', () => {
  const p = authProvenance({
    shipment: bloom(),
    notification: { authNumber: '00052850382S', receivedAt: '2026-08-13T14:00:20Z' },
  })
  assert.equal(p.state, AUTH_STATE.ARRIVED)
  assert.equal(p.arrived, true)
  assert.match(p.detail, /not applied to this card yet/)
})

// Reachable only with no DC to resolve: partnerForDc is total and defaults every
// non-numeric code to Bloomingdale's, so with a DC present this branch cannot fire.
// Kept because a DC-less card must not be told to wait for a Macy's email.
test('an unrecognised partner with no DC admits it has no convention', () => {
  const p = authProvenance({ shipment: { partner: 'Saks', dc: null } })
  assert.equal(p.source, AUTH_SOURCE.UNKNOWN)
  assert.equal(p.state, AUTH_STATE.NOT_READ)
  assert.equal(p.manual, true)
})
