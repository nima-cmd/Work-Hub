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
import { legFor, containerLeg, nextAction, whereToLook, lookupFor } from '../src/model/containerTransfer.js'
import { inferMode } from '../src/model/inboundShipment.js'

const to = (n, o = {}) => ({ toNumber: n, units: 100, ...o })
// ⚠️ nextAction only reaches its in-transit branch when the TO carries a STATUS — the
// delivery tests above never needed one, and leaving it off made the first where-to-look
// test fall through to "not shipped yet" and read as a bug in lookupFor.
const inTransit = (n) => to(n, { status: 'Transfer Order : Pending Receipt' })

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

// ── Where to look, which is not the same question as how it travels ─────────────

test('⚠️ the 11-carton AIR shipment was told it was "still at sea"', () => {
  // The real bug, with the real data: a UPS tracking number sitting in the same record
  // as a sentence asserting an ocean voyage nobody entered.
  const air = {
    transferOrders: [inTransit('TO218'), inTransit('TO219')],
    trackingNumber: '1Z HV2 589 04 3832 1771',
    forwarder: 'GLC WiseGrid',
  }
  const why = whereToLook(air)
  assert.doesNotMatch(why, /at sea/i, 'it is on a plane')
  assert.match(why, /UPS/)
  assert.match(why, /1Z HV2 589 04 3832 1771/)
  assert.equal(nextAction(air).lookup.kind, 'tracking')
  assert.equal(nextAction(air).lookup.carrier, 'UPS')
})

test('a forwarder reference sends you to the forwarder, not to a tracking site', () => {
  const sea = {
    transferOrders: [inTransit('TO220')],
    forwarderRef: 'SI0067968', forwarder: 'GLC WiseGrid',
  }
  const why = whereToLook(sea)
  assert.match(why, /No public tracking/)
  assert.match(why, /GLC WiseGrid is the only source/)
  assert.match(why, /SI0067968/)
  assert.doesNotMatch(why, /at sea/i)
  assert.equal(lookupFor(sea).kind, 'forwarder')
})

test('⚠️ an unrecognised tracking number gets NO carrier name attached', () => {
  // ⚠️ Nima, 2026-09-15: air comes from GLC sometimes and DHL other times. Naming the
  // wrong carrier sends somebody to the wrong website, which is worse than naming none.
  // Only "1Z" is safe — it is UPS's by specification.
  const dhl = { transferOrders: [inTransit('TO1')], trackingNumber: '1234567890' }
  const l = lookupFor(dhl)
  assert.equal(l.kind, 'tracking')
  assert.equal(l.carrier, null, 'we do not know whose number this is')
  assert.match(whereToLook(dhl), /look it up with whoever is carrying it/)
  assert.doesNotMatch(whereToLook(dhl), /UPS|DHL/)
})

test('⚠️ knowing nothing says so — it never falls back to a mode', () => {
  const blank = { transferOrders: [inTransit('TO1')] }
  const why = whereToLook(blank)
  assert.match(why, /Nothing we hold says where/)
  assert.doesNotMatch(why, /at sea|air|plane/i)
  assert.equal(lookupFor(blank).kind, 'none')
})

test('the port date still leads when we have one — it is the latest observation', () => {
  const atPort = {
    transferOrders: [inTransit('TO224')],
    portArrivedOn: '2026-09-13', forwarderRef: 'SE0025980', forwarder: 'GLC WiseGrid',
  }
  assert.match(whereToLook(atPort), /at the port on 2026-09-13/)
  assert.match(whereToLook(atPort), /drayage/)
})

test('⚠️ the mode field is NOT consulted, and inferMode stays a suggestion', () => {
  // src/model/inboundShipment.js already decided this: mode is NULL until a person
  // chooses it. Nothing here may read a guess as a fact — so an entered mode and no
  // mode at all produce the SAME sentence, because the sentence is about evidence.
  const base = { transferOrders: [inTransit('TO1')], trackingNumber: '1Z999AA10123456784' }
  assert.equal(whereToLook({ ...base, mode: 'sea' }), whereToLook({ ...base, mode: null }))
  // and the suggestion is still available to anyone who wants to OFFER it
  assert.deepEqual(inferMode('11 Air 1820 1777 air list carton 2026.9.7'), { mode: 'air', inferred: true })
  // ⚠️ THIS LINE ASSERTED `mode: null` AND I WROTE IT MYSELF, documenting a miss I had
  // not noticed was a defect: the old anchored pattern failed on "55 LCL carton" and on
  // the plural "59 cartons", so neither live sea container suggested anything. A test
  // can pin a bug as firmly as it pins a feature — see test/inboundShipment.test.js.
  assert.deepEqual(inferMode('55 LCL carton 2026.9.7'), { mode: 'sea', inferred: true })
})
