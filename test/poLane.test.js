// test/poLane.test.js — which lane a PO's stock is going to.
//
// ⚠️ EVERY DESTINATION STRING HERE IS REAL, read off the 80 open POs on 2026-09-18:
// China · (null) · Virtual Warehouse · Warehouse · Warehouse Bulk : Nordstrom ·
// Warehouse Bulk : Bloomingdale's · Warehouse Bulk : Saint Bernard · Warehouse Bulk :
// Shopbop. The load-bearing tests are the ones where the answer is NOT a lane — the 20
// POs with no destination, and China, which means the stock never arrives.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { poLane, laneBreakdown, LANES, LANE_ORDER } from '../src/model/poLane.js'

test('the four real lanes, off the real location names', () => {
  assert.equal(poLane('Virtual Warehouse').lane, 'retail')
  assert.equal(poLane('Warehouse').lane, 'boutique')
  assert.equal(poLane('Warehouse Bulk : Nordstrom').lane, 'partner')
  assert.equal(poLane('China').lane, 'fob')
})

test('⚠️ the partner NAME survives the classification', () => {
  // Nordstrom late for a drop is a chargeback; Shopbop late is not. One "partner"
  // bucket would erase the difference the lane exists to draw.
  assert.equal(poLane('Warehouse Bulk : Nordstrom').partner, 'Nordstrom')
  assert.equal(poLane("Warehouse Bulk : Bloomingdale's").partner, "Bloomingdale's")
  assert.equal(poLane('Warehouse Bulk : Saint Bernard').partner, 'Saint Bernard')
  assert.equal(poLane('Warehouse Bulk : Shopbop').partner, 'Shopbop')
})

test('⚠️ a substring test would collapse three lanes into one', () => {
  // Every one of these contains the literal word "Warehouse".
  const lanes = ['Virtual Warehouse', 'Warehouse', 'Warehouse Bulk : Shopbop'].map((d) => poLane(d).lane)
  assert.deepEqual(lanes, ['retail', 'boutique', 'partner'])
})

test('⚠️ China is a destination that means the stock never arrives', () => {
  const c = poLane('China')
  assert.equal(c.lane, 'fob')
  assert.equal(LANES.fob.arrivesHere, false)
  assert.match(c.why, /never received here/)
})

test('⚠️ no destination is its own answer, not a default lane', () => {
  for (const empty of [null, undefined, '', '   ']) {
    const c = poLane(empty)
    assert.equal(c.lane, 'unknown')
    assert.equal(c.destination, null)
    assert.match(c.why, /nobody has said where/)
  }
  // And it must never silently become retail — 20 of 80 open POs land here.
  assert.notEqual(poLane(null).lane, 'retail')
})

test('⚠️ an unrecognised location is NAMED, not bucketed', () => {
  const c = poLane('Third Party 3PL : Someone New')
  assert.equal(c.lane, 'unknown')
  // The raw value is kept so the screen can ask about it rather than hide it.
  assert.equal(c.destination, 'Third Party 3PL : Someone New')
  assert.match(c.why, /not a location this app recognises/)
})

test('the breakdown keeps partners apart and orders the lanes', () => {
  const b = laneBreakdown([
    { destination: 'Virtual Warehouse', units: 900 },
    { destination: 'Warehouse Bulk : Nordstrom', units: 200 },
    { destination: 'Warehouse Bulk : Shopbop', units: 100 },
    { destination: 'China', units: 500 },
    { destination: null, units: 50 },
  ])
  assert.equal(b.total, 1750)
  assert.deepEqual(b.lanes.map((l) => l.lane), ['retail', 'partner', 'partner', 'fob', 'unknown'])
  assert.deepEqual(b.lanes.filter((l) => l.lane === 'partner').map((l) => l.partner), ['Nordstrom', 'Shopbop'])
})

test('⚠️ "arriving" excludes FOB and unrouted stock', () => {
  const b = laneBreakdown([
    { destination: 'Virtual Warehouse', units: 900 },
    { destination: 'China', units: 500 },
    { destination: null, units: 50 },
  ])
  // 1,450 units exist. Only 900 of them are coming here, and a "how much is inbound
  // for this drop" figure that said 1,450 would promise merchandise nobody collects.
  assert.equal(b.total, 1450)
  assert.equal(b.arriving, 900)
})

test('the same destination on many lines sums rather than repeats', () => {
  const b = laneBreakdown([
    { destination: 'Virtual Warehouse', units: 10 },
    { destination: 'Virtual Warehouse', units: 30 },
  ])
  assert.equal(b.lanes.length, 1)
  assert.equal(b.lanes[0].units, 40)
})

test('LANE_ORDER covers every lane, so nothing sorts off the end', () => {
  assert.deepEqual([...LANE_ORDER].sort(), Object.keys(LANES).sort())
})
