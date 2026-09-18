// test/dhlAccount.test.js — which DHL account bills a shipment.
//
// Nima, 2026-09-18: "885857720 is for coming out of LA the other number is for when
// they ship from china i believe."
//
// ⚠️ THE LOAD-BEARING TESTS ARE THE REFUSALS. Both accounts quote IDENTICALLY on the
// Glendale → Lima lane (verified live: $247.95 EXPRESS WORLDWIDE on each), so a wrong
// account is invisible in every API response and shows up only on an invoice. This is
// the UPS C6J610/18GE01 rule with a different carrier.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountFor, DHL_ACCOUNTS } from '../src/model/dhlAccount.js'

test('a US-origin shipment bills the LA account', () => {
  const r = accountFor('US')
  assert.equal(r.ok, true)
  assert.equal(r.account, '885857720')
  assert.match(r.why, /LA/)
})

test('⚠️ a China-origin shipment REFUSES rather than falling back to LA', () => {
  // The China account's purpose came with "i believe" attached. Billing it on an
  // assumption is an invoice arriving at the wrong entity, invisible until reconciled.
  const r = accountFor('CN')
  assert.equal(r.ok, false)
  assert.equal(r.account, null)
  assert.equal(r.needsConfirmation, '940296615')
  assert.match(r.why, /never been confirmed/)
  // And it must never quietly become the LA account.
  assert.notEqual(r.account, '885857720')
})

test('⚠️ no origin country is a refusal, not a default', () => {
  for (const missing of [null, undefined, '', '  ']) {
    const r = accountFor(missing)
    assert.equal(r.ok, false)
    assert.equal(r.account, null)
    assert.match(r.why, /no origin country/)
  }
})

test('an origin we have no account for says exactly that', () => {
  const r = accountFor('FR')
  assert.equal(r.ok, false)
  assert.match(r.why, /no DHL account is recorded for shipments leaving FR/)
})

test('the configured account wins for US, and is honoured', () => {
  const r = accountFor('US', { configured: '885857720' })
  assert.equal(r.ok, true)
  assert.equal(r.account, '885857720')
})

test('⚠️ a configured account that contradicts the origin is REFUSED', () => {
  // DHL_ACCOUNT_NUMBER set to the China account while shipping from the US is a
  // misconfiguration that would otherwise bill the wrong entity on every label.
  const r = accountFor('US', { configured: '940296615' })
  assert.equal(r.ok, false)
  assert.equal(r.account, null)
  assert.match(r.why, /China origin account/)
})

test('⚠️ an unrecognised configured account is FLAGGED, not silently trusted', () => {
  const r = accountFor('US', { configured: '123456789' })
  assert.equal(r.ok, true, 'it still ships — the number may be a new, real account')
  assert.equal(r.unknown, true)
  assert.match(r.why, /not an account this app recognises/)
})

test('the roster records both accounts, and only one is verified', () => {
  assert.equal(DHL_ACCOUNTS['885857720'].verified, true)
  assert.equal(DHL_ACCOUNTS['940296615'].verified, false)
  assert.equal(DHL_ACCOUNTS['885857720'].origin, 'US')
  assert.equal(DHL_ACCOUNTS['940296615'].origin, 'CN')
})
