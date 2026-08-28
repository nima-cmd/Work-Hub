// test/transferOrder.test.js — which transfers are work, and which are not.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRACKED_DESTINATIONS, isTrackedDestination, trackedTransfers, untrackedDestinations,
  isReceived, transferHeadline, RECEIVED, transferFilingFolder,
} from '../src/model/transferOrder.js'

// The live population, measured 2026-08-27.
const LIVE = [
  ...Array(79).fill({ destination: 'Warehouse' }),
  ...Array(59).fill({ destination: 'Virtual Warehouse' }),
  ...Array(15).fill({ destination: 'Nordstrom' }),
  ...Array(12).fill({ destination: "Bloomingdale's" }),
  ...Array(10).fill({ destination: 'Office' }),
  ...Array(6).fill({ destination: 'Shopbop' }),
  ...Array(4).fill({ destination: 'Consignment' }),
  { destination: 'Saint Bernard' }, { destination: 'Offsite Storage' },
]

test('only the two destinations Nima named are tracked', () => {
  assert.deepEqual(TRACKED_DESTINATIONS, ['Office', 'Consignment'])
  assert.equal(trackedTransfers(LIVE).length, 14, '10 Office + 4 Consignment out of 187')
})

test('⚠️ inbound transfers are NOT work — that was the whole point', () => {
  // Nima: "its not a container being shipped to us in the shape of a transfer order."
  // 138 of 187 transfers move stock INTO the warehouse.
  assert.equal(isTrackedDestination('Warehouse'), false)
  assert.equal(isTrackedDestination('Virtual Warehouse'), false)
})

test('partner-location transfers are excluded until he says otherwise', () => {
  // ⚠️ 33 of these exist and they may well be real work. Including them because they
  // LOOK outbound would put freight on a shared calendar nobody asked to see there.
  for (const d of ['Nordstrom', "Bloomingdale's", 'Shopbop']) {
    assert.equal(isTrackedDestination(d), false, d)
  }
})

test('matching is case- and whitespace-insensitive, but never fuzzy', () => {
  assert.equal(isTrackedDestination('office'), true)
  assert.equal(isTrackedDestination('  Consignment  '), true)
  // ⚠️ Not a prefix or substring match: a new location called "Office Annex" is a
  // DIFFERENT place, and quietly treating it as the Office would ship freight to a
  // calendar entry naming somewhere it is not going.
  assert.equal(isTrackedDestination('Office Annex'), false)
  assert.equal(isTrackedDestination('Consignment Returns'), false)
})

test('an unknown or missing destination is untracked, not an error', () => {
  assert.equal(isTrackedDestination(null), false)
  assert.equal(isTrackedDestination(''), false)
  assert.equal(isTrackedDestination('Somewhere New'), false)
  assert.deepEqual(trackedTransfers([{ destination: null }]), [])
})

test('untracked destinations are REPORTED, so a new location is noticed', () => {
  // ⚠️ Silently dropping them means freight goes untracked because nobody knew a
  // location had been added.
  const out = untrackedDestinations(LIVE)
  assert.equal(out[0].destination, 'Warehouse')
  assert.equal(out[0].count, 79)
  assert.equal(out.some((u) => u.destination === 'Office'), false, 'tracked ones are not listed')
  assert.equal(untrackedDestinations([{ destination: null }])[0].destination, '(none)')
})

test('⚠️ "Received" is evidence of arrival; its ABSENCE is evidence of nothing', () => {
  // Nima: "sometiems they dont receive on their end". So an unreceived transfer may
  // well have arrived — anything reporting on it must say "not confirmed received",
  // never "not delivered".
  assert.equal(isReceived(RECEIVED), true)
  assert.equal(isReceived('Transfer Order : Pending Fulfillment'), false)
  assert.match(transferHeadline({ toNumber: 'TO217', destination: 'Office', status: 'Transfer Order : Pending Fulfillment' }),
    /not confirmed received/)
  assert.doesNotMatch(transferHeadline({ toNumber: 'TO217', destination: 'Office', status: 'Transfer Order : Pending Fulfillment' }),
    /not delivered/)
  assert.match(transferHeadline({ toNumber: 'TO190', destination: 'Consignment', status: RECEIVED }), /· received/)
})

test('the headline names the destination, because that IS the shipment', () => {
  assert.match(transferHeadline({ toNumber: 'TO217', destination: 'Office' }), /TO217 → Office/)
  // A transfer with no destination still gets an honest line rather than "→ null".
  assert.match(transferHeadline({ toNumber: 'TO9' }), /an unnamed location/)
})

test('where a transfer\'s paperwork files — an ENTERED mapping', () => {
  // Nima, 2026-08-27: "its fine to go under boutiques as Naghedi for Office and
  // Consignment for Consignment." The destination is a NetSuite location name; the
  // folder is what a person expects to find in Drive. "Office" among 37 real boutiques
  // would read as somebody else's shop, so our own goods go under our own name.
  assert.equal(transferFilingFolder('Office'), 'Naghedi')
  assert.equal(transferFilingFolder('office'), 'Naghedi')
  assert.equal(transferFilingFolder('  Consignment '), 'Consignment')
})

test('⚠️ an unmapped destination files NOWHERE, and that is the safe answer', () => {
  // scanFiling already holds this line for boutique slips — "a slip in the wrong place
  // is harder to find than one that was never filed and said so". A transfer to a new
  // destination is exactly when that matters.
  assert.equal(transferFilingFolder('Warehouse'), null)
  assert.equal(transferFilingFolder('Somewhere New'), null)
  assert.equal(transferFilingFolder(null), null)
  assert.equal(transferFilingFolder(''), null)
})
