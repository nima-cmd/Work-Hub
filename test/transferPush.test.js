// test/transferPush.test.js — a transfer's ShipStation order.
//
// The push itself lives in server/queries.js (it needs the database), so these cover
// the part that decides WHAT gets built and WHO PAYS — which is the part that would
// cost money to get wrong.
import test from 'node:test'
import assert from 'node:assert/strict'
import { shipstationEligibility, HOLD } from '../src/model/shipstationEligible.js'
import { UPS_ACCOUNTS } from '../src/model/shipstationOrder.js'

// IF7612 / TO217 exactly as NetSuite holds it, measured 2026-08-27.
const TRANSFER = {
  status: 'Picked', labelCount: 0, carrier: 'UPS', shipMethod: 4,
  hasAddress: true, country: 'US',
  // ⚠️ A transfer has NO CUSTOMER, so third-party billing cannot exist — it is
  // resolved from the customer's account. That is why these are null by
  // construction rather than left unset, and why readFailed is honestly false:
  // nothing failed to read, there was nothing to read.
  shipMethodName: null, thirdPartyAcct: null, thirdPartyZip: null, readFailed: false,
}

test('a Picked transfer with a UPS method is pushable', () => {
  const r = shipstationEligibility(TRANSFER)
  assert.equal(r.push, true)
  assert.equal(r.serviceCode, 'ups_ground')
})

test('⚠️ the freight bills OUR account, and that is correct for a transfer', () => {
  // A transfer moves our own goods between our own locations. There is no customer to
  // bill, so billTo stays null and ShipStation uses the account the order names.
  const r = shipstationEligibility(TRANSFER)
  assert.equal(r.billTo, null)
  assert.equal(r.hold, null, 'it must not be held for unreadable billing — there was nothing to read')
})

test('⚠️ that account is the WHOLESALE one, not ecom', () => {
  // The repo's standing rule: an unspecified UPS account silently bills 18GE01 (ecom).
  // The order names 698098 = C6J610 "Big Box" — confirmed against a real transfer's
  // own history, TO23's label 1ZC6J6100304787462.
  assert.equal(UPS_ACCOUNTS.bigBox, 698098)
})

test('an already-labelled transfer is held — force can never lift it', () => {
  // TO23 and TO75 carry real labels; pushing again is a double charge and a wrong
  // number downstream.
  const r = shipstationEligibility({ ...TRANSFER, labelCount: 1 })
  assert.equal(r.push, false)
  assert.equal(r.hold, HOLD.ALREADY_LABELLED)
})

test('a shipped transfer is held — 7 of the 14 are already gone', () => {
  const r = shipstationEligibility({ ...TRANSFER, status: 'Shipped' })
  assert.equal(r.push, false)
  assert.equal(r.hold, HOLD.NOT_PICKED)
})

test('an older transfer with no carrier is held, and says to do it by hand', () => {
  // IF7195 and IF6886 carry no shipcarrier at all.
  const r = shipstationEligibility({ ...TRANSFER, carrier: null })
  assert.equal(r.push, false)
  assert.equal(r.hold, HOLD.CARRIER_NOT_SET_UP)
  assert.match(r.reason, /manually/)
})

test('no ship-to address is held rather than guessed at', () => {
  // ⚠️ The address is the thing I nearly got wrong: TO217 ships to 20 W 22nd St, NOT
  // the Office location's own 88 Lexington Ave. A transfer with no address on the
  // transaction must stop, not fall back to the location.
  const r = shipstationEligibility({ ...TRANSFER, hasAddress: false })
  assert.equal(r.push, false)
  assert.equal(r.hold, HOLD.NO_ADDRESS)
})

test('an unmapped UPS service is held rather than guessing a level', () => {
  const r = shipstationEligibility({ ...TRANSFER, shipMethod: 999 })
  assert.equal(r.push, false)
  assert.equal(r.hold, HOLD.UNKNOWN_SERVICE)
})
