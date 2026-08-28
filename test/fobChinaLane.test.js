// test/fobChinaLane.test.js — FOB China is never dispatched by us, and two surfaces
// were acting as though it might be.
import test from 'node:test'
import assert from 'node:assert/strict'
import { neverLabelledHere, pushingAllowed, pushBlockedForLocation } from '../src/model/labelSource.js'
import { showsParcelPushButton } from '../src/model/parcelLane.js'
import { fulfilledNeverScanned } from '../src/model/postCustody.js'

test('⚠️ a China order offers NO push button — it could only ever refuse', () => {
  // Measured 2026-08-28: IF7603 and IF7604, both FOB China, each carried a live-looking
  // "Push to ShipStation". The server blocks China and the UI does not offer force for
  // it (that offer is keyed on the reason mentioning NetSuite), so the click dead-ended.
  assert.equal(showsParcelPushButton({ location: 'China', source: 'boutique' }), false)
  assert.equal(showsParcelPushButton({ location: 'china', source: 'edi', customer: 'Shopbop' }), false)
})

test('⚠️ THE WAREHOUSE BUTTON SURVIVES — that block is a conflict, not a never', () => {
  // NetSuite labels a Warehouse box, and forcing past it is the documented break-glass
  // Nima used for IF7610 when NetSuite's label was wrong for the carton count.
  // Suppressing this too would remove the only route to a label on the orders that need
  // one most.
  assert.equal(showsParcelPushButton({ location: 'Warehouse', source: 'boutique' }), true)
  assert.ok(pushBlockedForLocation('Warehouse'), 'still blocked by default')
  assert.equal(pushingAllowed({ force: true, location: 'Warehouse' }), true, 'force still lifts it')
})

test('neverLabelledHere names only China, and never on a missing location', () => {
  assert.equal(neverLabelledHere('China'), true)
  assert.equal(neverLabelledHere('  china  '), true)
  assert.equal(neverLabelledHere('Warehouse'), false)
  // ⚠️ An absent location must not resolve to "never" any more than it resolves to
  // "allowed" — it is unknown, and pushBlockedForLocation already holds it for that.
  assert.equal(neverLabelledHere(null), false)
  assert.equal(neverLabelledHere(''), false)
})

test('⚠️ a China fulfilment is NOT accused of never being scanned out', () => {
  // There is no scan to miss: the goods are in China awaiting collection, we never take
  // custody and never hand them to a carrier. 2 of 2 live flags were false — the same
  // 100%-one-lane signature as the 28 Nordstrom cargo-tag positives.
  const picked = { custodyOut: null, custodyIn: null, status: 'Picked' }
  assert.equal(fulfilledNeverScanned(picked, { dcScanned: false }), true, 'still true in general')
  assert.equal(fulfilledNeverScanned(picked, { dcScanned: false, neverDispatched: true }), false)
})

test('the other two excuses are untouched', () => {
  assert.equal(fulfilledNeverScanned({ status: 'Shipped' }, {}), false, 'shipped')
  assert.equal(fulfilledNeverScanned({ status: 'Picked' }, { dcScanned: true }), false, 'DC tag scanned')
  // And a genuine gap still reports.
  assert.equal(fulfilledNeverScanned({ status: 'Picked' }, {}), true)
})
