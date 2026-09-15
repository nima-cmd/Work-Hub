// test/macysStores.test.js — Macy's own Store-to-DC listing, updated 2026-07-28.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STORES, SOURCE, store, dcForStore, storesForDc, dcCounts, CODES_WITHOUT_ADDRESS } from '../src/model/macysStores.js'
import { DC_ABBREV } from '../src/model/dc.js'
import { isRemovedDc } from '../src/model/macysRouting.js'

test('the listing is the one the Routing Guide points at, and it dates itself', () => {
  assert.equal(SOURCE.updated, '2026-07-28')
  assert.match(SOURCE.pointedAtBy, /§2.1/)
  assert.equal(STORES.length, 40)
})

test('⚠️ IT ANSWERS THE QUESTION A PO CANNOT — store number to DC', () => {
  // §2.1: "Purchase orders will only contain location numbers and quantities. Store to
  // DC listing documents must be utilized to map each location to the correct receiving
  // DC." Our open SOs read "Bloomingdale's - 0006 Short Hills" — no DC anywhere.
  assert.equal(dcForStore('0006'), 'SC')
  assert.equal(dcForStore(6), 'SC', 'a bare number pads to four digits')
  assert.equal(dcForStore('0002'), 'ST')
})

test('⚠️ AN UNKNOWN STORE IS NULL, NEVER A GUESSED DC', () => {
  // Wrong-location freight is $250/receipt plus $10/carton plus the freight. A guessed
  // DC is the most expensive kind of helpful.
  assert.equal(dcForStore('9999'), null)
  assert.equal(dcForStore(''), null)
  assert.equal(store('9999'), null)
})

test('⚠️ TU AND HI ARE REAL — the two codes DC_ABBREV could never name', () => {
  // dc.js has carried seven codes and a standing note that a cargo tag for Bloomies
  // University Village or Hawaii Pool Stock abbreviated to nothing.
  assert.equal(dcForStore('0065'), 'TU')
  assert.equal(dcForStore('0947'), 'HI')
  assert.match(store('0065').name, /University Village/)
  assert.match(store('0947').name, /Hawaii/)
  // ⚠️ And they are still NOT in DC_ABBREV, on purpose: the listing gives the STORE's
  // address, not the DC's, so we can abbreviate them but not address them.
  const codes = new Set(Object.values(DC_ABBREV))
  for (const c of CODES_WITHOUT_ADDRESS) assert.ok(!codes.has(c), `${c} must not be given an invented DC name`)
})

test('every other code in the listing IS one dc.js already knows', () => {
  const known = new Set([...Object.values(DC_ABBREV), ...CODES_WITHOUT_ADDRESS])
  for (const code of Object.keys(dcCounts())) {
    assert.ok(known.has(code), `the listing uses ${code} and nothing else knows it`)
  }
})

test('⚠️ CHESHIRE IS ABSENT HERE TOO — two documents agreeing, not one being trusted', () => {
  // The Routing Guide's 4/14/26 revision removed Cheshire, West Johnson and Sacramento.
  // No store in this file routes to any of them. Our own SO11521 shipped to Cheshire on
  // 2026-04-07, a week before.
  assert.ok(!STORES.some((s) => isRemovedDc(s.name)))
  assert.equal(store('0135'), null, 'the Cheshire pool stock location is gone')
})

test('a DC lists the stores it serves, for consolidating a BOL', () => {
  assert.equal(storesForDc('SC').length, 13)
  assert.equal(storesForDc('sc').length, 13, 'case does not matter')
  assert.deepEqual(storesForDc('ZZ'), [])
})

test('the store rows carry a real address, not just a name', () => {
  const s = store('0001')
  assert.equal(s.city, 'New York')
  assert.equal(s.state, 'NY')
  assert.equal(s.zip, '10022')
  assert.ok(s.street)
})
