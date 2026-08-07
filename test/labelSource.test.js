// Where labels are made. One switch, and it must fail CLOSED.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pushingAllowed, pushBlockedForLocation, LABEL_SOURCE, PUSH_DISABLED_REASON } from '../src/model/labelSource.js'

test('labels are made in NetSuite right now', () => {
  assert.equal(LABEL_SOURCE, 'netsuite')
  assert.equal(pushingAllowed(), false)
})

test('it fails CLOSED — only an explicit force or a flipped source opens it', () => {
  // A truthy-but-not-true value must not sneak past; the whole point is that pushing
  // creates a second live label on a box that already has one.
  for (const bad of [undefined, null, 0, '', 'yes', 1, {}]) {
    assert.equal(pushingAllowed({ force: bad }), false, JSON.stringify(bad))
  }
  assert.equal(pushingAllowed({ force: true }), true)
  assert.equal(pushingAllowed({ source: 'shipstation' }), true)
})

test('the reason names the file to read and the actual hazard', () => {
  // A block whose message does not say why becomes a mystery in three weeks.
  assert.match(PUSH_DISABLED_REASON, /labelSource\.js/)
  assert.match(PUSH_DISABLED_REASON, /second live label/)
  assert.match(PUSH_DISABLED_REASON, /force/)
})

// ── the off-Warehouse unblock (Nima, 2026-08-07) ─────────────────────────────
// "can we unblock shipstation label for anything no the warehouse location"

test('the Warehouse location stays blocked — that is where the double label came from', () => {
  assert.equal(pushingAllowed({ location: 'Warehouse' }), false)
  assert.match(pushBlockedForLocation('Warehouse'), /second live label/)
})

test('partner locations are unblocked', () => {
  for (const loc of ["Bloomingdale's", 'Nordstrom', 'Shopbop']) {
    assert.equal(pushingAllowed({ location: loc }), true, `${loc} should be pushable`)
    assert.equal(pushBlockedForLocation(loc), null)
  }
})

test('⚠️ China stays blocked even though it is not the Warehouse', () => {
  // His own 2026-08-04 rule: FOB Pending Approval means the goods are in China
  // awaiting collection and we never dispatch them, so we never make the label
  // (0 of 12 ever had one). A literal reading of "anything not the Warehouse"
  // would hand it a label for a box we never give a carrier.
  assert.equal(pushingAllowed({ location: 'China' }), false)
  assert.match(pushBlockedForLocation('China'), /never dispatch/)
})

test('⚠️ a MISSING location is held, never treated as unblocked', () => {
  // Same failure direction as SHIP_DETAIL_UNREADABLE: an absent field must not be
  // the thing that authorises a live write.
  for (const bad of [null, undefined, '', '   ']) {
    assert.equal(pushingAllowed({ location: bad }), false, `${JSON.stringify(bad)} must not unblock`)
  }
  assert.match(pushBlockedForLocation(null), /absent field/)
})

test('a caller passing no location at all keeps the old global block', () => {
  // Nothing widens silently: the unblock is opt-in per order.
  assert.equal(pushingAllowed({}), false)
  assert.equal(pushingAllowed({ force: true }), true)
  assert.equal(pushingAllowed({ source: 'shipstation' }), true)
  // force still wins over a blocked location — it is the read-the-reason escape hatch
  assert.equal(pushingAllowed({ location: 'Warehouse', force: true }), true)
})
