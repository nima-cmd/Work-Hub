import test from 'node:test'
import assert from 'node:assert/strict'
import { ifRemovalEvent, SPINE_LABEL } from '../src/model/orderEvents.js'

// Nima, 2026-08-11: "IF7452 is about to get deleted, a new IF is about to be made
// for that SO … how do we make sure this doesn't muck up our system and that it
// knows to get rid of the deleted old record it was tracking."
//
// Deleting the row was already handled (reconcileFulfillments, 2026-07-30). What
// wasn't: the custody register is driven by order_events and only LEFT JOINs
// fulfillments, so a scanned-then-deleted IF sat there forever with a null SO,
// customer and status, and nothing cleared it — a deleted IF never departs.
// IF7406 had been doing exactly that for 13 days.

test('removal event: names the IF and the status it had when it vanished', () => {
  const ev = ifRemovalEvent({ ifNumber: 'IF7452', soNumber: 'SO12302', status: 'Picked' })
  assert.equal(ev.eventType, 'IF_REMOVED')
  assert.equal(ev.docType, 'IF')
  assert.equal(ev.docNumber, 'IF7452')
  assert.equal(ev.soNumber, 'SO12302')
  assert.match(ev.note, /no longer in NetSuite \(was Picked\)/)
})

test('removal event: carries NO date — the deletion date is unknowable', () => {
  // NetSuite keeps no record of when a deleted record was deleted, so the caller
  // stamps NOW() (when the absence was OBSERVED) rather than this inventing one.
  const ev = ifRemovalEvent({ ifNumber: 'IF7452', status: 'Picked' })
  assert.equal('occurredAt' in ev, false)
  assert.equal('occurred_at' in ev, false)
})

test('removal event: UNLINKED is not written as a sales order', () => {
  // 'UNLINKED' is this repo's placeholder for "no SO"; writing it as one would mint
  // a link to a document that does not exist.
  assert.equal(ifRemovalEvent({ ifNumber: 'IF1', soNumber: 'UNLINKED', status: 'Picked' }).soNumber, null)
  assert.equal(ifRemovalEvent({ ifNumber: 'IF1', status: 'Picked' }).soNumber, null)
})

test('removal event: an unknown status is said, not guessed', () => {
  assert.match(ifRemovalEvent({ ifNumber: 'IF1' }).note, /was unknown status/)
})

test('removal event: no IF number means no event', () => {
  assert.equal(ifRemovalEvent({}), null)
  assert.equal(ifRemovalEvent(), null)
})

test('IF_REMOVED renders with a label, and stays distinct from departure', () => {
  // Without a label the timeline shows "IF_REMOVED" verbatim — the trap that put
  // CUSTODY_CLEARED and SHIPPED_VALUE into EXTRA_LABEL in the first place.
  assert.equal(SPINE_LABEL.get('IF_REMOVED'), 'Fulfilment removed in NetSuite')
  // One event says the truck left; the other says the document went away. Lumping
  // them would let a withdrawn fulfilment read as a departure.
  assert.notEqual(SPINE_LABEL.get('IF_REMOVED'), SPINE_LABEL.get('CUSTODY_CLEARED'))
})
