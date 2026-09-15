// test/containerDelivery.test.js — the leg between the port and the books.
//
// ⚠️ THE TESTS THAT MATTER MOST HERE ARE THE NEGATIVE ONES. Every bug this module is
// written against was a state being inferred from evidence that did not support it: a
// port date read as an arrival, an empty transfer list read as fully received, "no
// receipt" read as "not delivered". Those get a test each.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deliveryFor, allReceived, receivedOn, unusableWindow, awaitingReceipt,
  DELIVERY_EVIDENCE, NOT_DELIVERY_EVIDENCE, UNUSABLE_WINDOW_LABEL,
} from '../src/model/containerDelivery.js'
import { legFor, containerLeg } from '../src/model/containerTransfer.js'

const to = (n, o = {}) => ({ toNumber: n, units: 100, ...o })

test('⚠️ a port date is NEVER delivery — the mistake this module exists to prevent', () => {
  // The 59-carton container, as it actually stood on 2026-09-15: at the port two days,
  // six transfer orders, not one of them received. I previously called this landed and
  // reported its receipts overdue.
  const d = deliveryFor({
    portArrivedOn: '2026-09-13',
    transferOrders: [to('TO224'), to('TO225'), to('TO226'), to('TO227'), to('TO228'), to('TO229')],
  })
  assert.equal(d.state, 'unknown')
  assert.equal(d.on, null)
  assert.equal(d.actionable, false)
  // It still SAYS the port date — the fix is to stop concluding from it, not to hide it.
  assert.match(d.why, /at the port on 2026-09-13/)
  assert.match(d.why, /tracked by nobody/)
  // And the reason it is not evidence is written down where someone would add it.
  assert.match(NOT_DELIVERY_EVIDENCE.portArrivedOn, /drayage/)
})

test('⚠️ "unknown" is not "not delivered" — the two containers that must not merge', () => {
  const atSea = deliveryFor({ transferOrders: [to('TO220'), to('TO221')] })
  const inTheYard = deliveryFor({
    deliveredOn: '2026-09-15', deliveredBy: 'Nima',
    transferOrders: [to('TO220'), to('TO221')],
  })
  // Neither has a receipt. They are NOT the same state, and only one is work.
  assert.equal(atSea.state, 'unknown')
  assert.equal(atSea.actionable, false)
  assert.equal(inTheYard.state, 'delivered')
  assert.equal(inTheYard.actionable, true)
  assert.deepEqual(inTheYard.awaitingReceipt, ['TO220', 'TO221'])
  assert.equal(inTheYard.units, 200)
})

test('⚠️ an empty transfer list is not "every TO received" — [].every() is true', () => {
  assert.equal(allReceived([]), false)
  const d = deliveryFor({ transferOrders: [] })
  assert.equal(d.state, 'unknown')
  assert.notEqual(d.state, 'received')
})

test('a partly-received container is still not received', () => {
  const tos = [to('TO200', { receivedOn: '2026-08-18' }), to('TO201')]
  assert.equal(allReceived(tos), false)
  assert.equal(receivedOn(tos), null, 'a date would claim the whole container landed')
  const d = deliveryFor({ deliveredOn: '2026-08-17', transferOrders: tos })
  assert.equal(d.state, 'delivered')
  assert.deepEqual(d.awaitingReceipt, ['TO201'])
  assert.equal(d.units, 100, 'only the unreceived units are the backlog')
})

test('⚠️ the container is dated by its LAST receipt, not its first', () => {
  // 321 carton: real dates, 8/17 and 8/18 across its fifteen transfer orders.
  const tos = [to('TO205', { receivedOn: '2026-08-17' }), to('TO201', { receivedOn: '2026-08-18' })]
  assert.equal(receivedOn(tos), '2026-08-18')
  const d = deliveryFor({ transferOrders: tos })
  assert.equal(d.state, 'received')
  assert.equal(d.on, '2026-08-18')
  assert.equal(d.evidence, DELIVERY_EVIDENCE.RECEIVED)
  assert.equal(d.evidence.kind, 'observed')
})

test('⚠️ a person\'s date SURVIVES the receipt — they answer different questions', () => {
  const d = deliveryFor({
    deliveredOn: '2026-08-14', deliveredBy: 'Nima',
    transferOrders: [to('TO201', { receivedOn: '2026-08-18' })],
  })
  assert.equal(d.state, 'received')
  assert.equal(d.on, '2026-08-18', 'the observed fact is the state')
  assert.equal(d.enteredOn, '2026-08-14', 'and the entered one is not thrown away')
  // Four days on the floor before anyone told NetSuite. That gap is the thing worth
  // seeing, and it only exists because both dates are kept.
})

test('an entered delivery names its author — an entered fact carries who decided it', () => {
  const withWho = deliveryFor({ deliveredOn: '2026-09-15', deliveredBy: 'Nima', transferOrders: [to('TO224')] })
  assert.equal(withWho.by, 'Nima')
  assert.match(withWho.why, /Nima recorded it arrived/)
  assert.equal(withWho.evidence.kind, 'entered')
  // and stays honest when nobody was recorded
  const without = deliveryFor({ deliveredOn: '2026-09-15', transferOrders: [to('TO224')] })
  assert.equal(without.by, null)
  assert.match(without.why, /recorded as arrived on 2026-09-15/)
})

test('⚠️ awaitingReceipt counts what a person SAID is here — never "has no receipt"', () => {
  const containers = [
    { containerLabel: 'at sea', transferOrders: [to('TO220'), to('TO221')] },
    { containerLabel: 'on the dock', portArrivedOn: '2026-09-13', transferOrders: [to('TO224')] },
    { containerLabel: 'in the yard', deliveredOn: '2026-09-14', deliveredBy: 'Nima', transferOrders: [to('TO226'), to('TO227')] },
    { containerLabel: 'done', transferOrders: [to('TO201', { receivedOn: '2026-08-18' })] },
  ]
  const backlog = awaitingReceipt(containers)
  // Three of the four have no receipt. Exactly ONE is a receiving backlog.
  assert.equal(backlog.length, 1)
  assert.equal(backlog[0].label, 'in the yard')
  assert.equal(backlog[0].units, 200)
  assert.deepEqual(backlog[0].transferOrders, ['TO226', 'TO227'])
  assert.match(backlog[0].action, /receive 2 transfer orders/)
  assert.match(backlog[0].action, /no order can draw on them/)
})

test('a delivered container with every TO already received is not actionable', () => {
  const backlog = awaitingReceipt([
    { containerLabel: 'done', deliveredOn: '2026-08-14', transferOrders: [to('TO201', { receivedOn: '2026-08-18' })] },
  ])
  assert.deepEqual(backlog, [], 'nothing left to receive is not work')
})

test('⚠️ the unusable window is NOT time at sea, and says so in its own label', () => {
  // 321 carton, real: fulfilled 7/10, received 8/18.
  const w = unusableWindow([to('TO201', { fulfilledOn: '2026-07-10', receivedOn: '2026-08-18' })])
  assert.equal(w.days, 39)
  assert.equal(w.fulfilledOn, '2026-07-10')
  assert.equal(w.receivedOn, '2026-08-18')
  assert.equal(w.label, UNUSABLE_WINDOW_LABEL)
  assert.match(w.label, /usable by nobody/)
  assert.doesNotMatch(w.label, /sea|transit/i,
    'the fulfilment date tracks the packing slip, not the vessel — GLC had 59 leaving 8 days later')
  // Unfinished legs produce nothing rather than a span against today.
  assert.equal(unusableWindow([to('TO224', { fulfilledOn: '2026-08-17' })]), null)
  assert.equal(unusableWindow([]), null)
})

test('⚠️ the TO status found in live data that the table did not know', () => {
  // 2 transfer orders, 42 units, carrying "Pending Receipt/Partially Fulfilled".
  // Before this it returned null and read as "unrecognised status".
  const leg = legFor('Transfer Order : Pending Receipt/Partially Fulfilled')
  assert.ok(leg, 'a real live status must not be unrecognised')
  assert.equal(leg.arrived, false)
  assert.match(leg.leg, /part shipped/)
  // It orders between Pending Fulfillment and Pending Receipt, so a container holding
  // one is not reported as fully in transit.
  assert.ok(leg.order > legFor('Transfer Order : Pending Fulfillment').order)
  assert.ok(leg.order < legFor('Transfer Order : Pending Receipt').order)
  const c = containerLeg([
    { toNumber: 'TO1', status: 'Transfer Order : Pending Receipt', units: 10 },
    { toNumber: 'TO2', status: 'Transfer Order : Pending Receipt/Partially Fulfilled', units: 42 },
  ])
  assert.deepEqual(c.unrecognised, [], 'no longer unrecognised')
  assert.match(c.leg, /part shipped/, 'the least-advanced TO still decides the container')
  assert.equal(c.arrived, false)
})
