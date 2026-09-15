// test/containerTransfer.test.js — the China → US leg, as transfer orders.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByContainer, containerLeg, nextAction, legFor, memoKey } from '../src/model/containerTransfer.js'

const TO = (n, status, units = 10, memo = '59 cartons') => ({ toNumber: n, status, units, memo })
const TRANSIT = 'Transfer Order : Pending Receipt'
const RECEIVED = 'Transfer Order : Received'

test('the memo IS the container label, matched byte for byte after trimming', () => {
  assert.equal(memoKey('  59 cartons LCL to LA INVOICE&PL (1) carton 2026.8.17  '),
    '59 cartons LCL to LA INVOICE&PL (1) carton 2026.8.17')
  const { byContainer } = groupByContainer([TO('TO224', TRANSIT, 79, 'A'), TO('TO225', TRANSIT, 359, 'A')], ['A'])
  assert.equal(byContainer.get('A').length, 2)
})

test('⚠️ A TO WHOSE MEMO MATCHES NOTHING IS RETURNED, NOT DROPPED', () => {
  // TO217 has an empty memo and TO215 says "PO1616Transfer" — a transfer order that is
  // not a container leg is normal; one that SHOULD be and has a typo'd memo is exactly
  // what must not vanish.
  const { byContainer, unmatched } = groupByContainer(
    [TO('TO224', TRANSIT, 79, 'A'), TO('TO217', TRANSIT, 5, ''), TO('TO215', RECEIVED, 5, 'PO1616Transfer')], ['A'])
  assert.equal(byContainer.size, 1)
  assert.deepEqual(unmatched.map((t) => t.toNumber), ['TO217', 'TO215'])
})

test('⚠️ THE CONTAINER IS THE LEAST-ADVANCED TO, NOT THE MOST', () => {
  // Five received and one still at sea is a container that has NOT landed. Reporting
  // the furthest-along leg would call it done while a PO is still on the water.
  const leg = containerLeg([TO('TO224', RECEIVED), TO('TO225', RECEIVED), TO('TO226', TRANSIT)])
  assert.equal(leg.leg, 'in transit')
  assert.equal(leg.arrived, false)
  assert.equal(leg.mixed, true)
})

test('all received is arrived; all in transit is not', () => {
  assert.equal(containerLeg([TO('a', RECEIVED), TO('b', RECEIVED)]).arrived, true)
  assert.equal(containerLeg([TO('a', TRANSIT), TO('b', TRANSIT)]).arrived, false)
  assert.equal(containerLeg([TO('a', TRANSIT)]).mixed, false)
})

test('⚠️ AN UNRECOGNISED STATUS IS NAMED, NEVER FOLDED IN', () => {
  // A status string we do not know is a change at NetSuite's end; guessing which leg it
  // means is how a container silently reads as landed.
  const leg = containerLeg([TO('TO999', 'Transfer Order : Something New')])
  assert.deepEqual(leg.unrecognised, ['TO999: "Transfer Order : Something New"'])
  assert.equal(leg.arrived, false)
  assert.equal(legFor('Transfer Order : Something New'), null)
})

test('no transfer orders is unknown, not "not shipped"', () => {
  const leg = containerLeg([])
  assert.equal(leg.known, false)
  assert.match(leg.why, /China leg is not recorded/)
})

test('⚠️ PORT ARRIVAL NEVER TELLS ANYONE TO RECEIVE A TRANSFER ORDER', () => {
  // Nima, 2026-09-15: "59 hasn't arrived it arrived at port, the part where its
  // transported to us is the part that is invisible." The drayage is tracked by nobody
  // we can read, so a port date must not become an instruction.
  const a = nextAction({ transferOrders: [TO('TO224', TRANSIT)], portArrivedOn: '2026-09-13' })
  assert.match(a.action, /wait for delivery/)
  assert.match(a.why, /drayage to Glendale is not tracked/)
  assert.equal(a.blocking, false)
})

test('a landed container asks for nothing', () => {
  assert.match(nextAction({ transferOrders: [TO('a', RECEIVED)] }).action, /nothing/)
})
