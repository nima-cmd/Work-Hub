// Unit tests for the inbound container grouping (pure; no DB, no network).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  groupContainers, containerState, lateContainers, containerHeadline,
  LIVE_WINDOW_DAYS, REMNANT_RECEIVED_PCT,
} from '../src/model/containers.js'

const TODAY = new Date('2026-08-02T12:00:00Z')

// One PO line. Defaults describe an ordinary open line so each test only has to
// state the field it is actually about.
const line = (o = {}) => ({
  poNumber: 'PO1', item: 'SN-A', vendor: 'Chelly', destination: 'Virtual Warehouse',
  expectedReceipt: '2026-07-01', qtyOrdered: 100, qtyReceived: 0, qtyRemaining: 100, ...o,
})

test('POs sharing a due date are one container', () => {
  // Nima, 2026-08-02: several POs on the same due date means they were grouped
  // into a container. Live data agrees — 7/7/6/12 POs per date.
  const { containers } = groupContainers([
    line({ poNumber: 'PO1739' }), line({ poNumber: 'PO1741' }), line({ poNumber: 'PO1745' }),
    line({ poNumber: 'PO1789', expectedReceipt: '2026-08-15' }),
  ], { today: TODAY })

  assert.equal(containers.length, 2)
  const jul = containers.find((c) => c.expectedReceipt === '2026-07-01')
  assert.equal(jul.poCount, 3)
  assert.deepEqual(jul.poNumbers, ['PO1739', 'PO1741', 'PO1745'])
  assert.equal(jul.unitsOpen, 300)
})

test('a split shipment puts one PO in two containers', () => {
  // "These POs can be split shipment and sent in multiple containers."
  const { containers } = groupContainers([
    line({ poNumber: 'PO1', item: 'A', expectedReceipt: '2026-07-01' }),
    line({ poNumber: 'PO1', item: 'B', expectedReceipt: '2026-08-15' }),
  ], { today: TODAY })
  assert.equal(containers.length, 2)
  for (const c of containers) assert.deepEqual(c.poNumbers, ['PO1'])
})

test('late only counts containers past due inside the live window', () => {
  const { containers } = groupContainers([
    line({ poNumber: 'PAST', expectedReceipt: '2026-07-01' }),   // 32 days late
    line({ poNumber: 'FUTURE', expectedReceipt: '2026-09-01' }), // 30 days out
  ], { today: TODAY })

  assert.equal(containers.find((c) => c.poNumbers[0] === 'PAST').state, 'late')
  assert.equal(containers.find((c) => c.poNumbers[0] === 'FUTURE').state, 'awaiting')
  assert.deepEqual(lateContainers(containers).map((c) => c.poNumbers[0]), ['PAST'])
})

test('a container due today is not yet late', () => {
  const { containers } = groupContainers([line({ expectedReceipt: '2026-08-02' })], { today: TODAY })
  assert.equal(containers[0].daysLate, 0)
  assert.equal(containers[0].state, 'awaiting')
})

test('mostly-received containers collapse as remnants, however recent', () => {
  // Real PO1738: 62 days past due, 790 of 800 units received. A reconciliation
  // job, not a missing shipment — it must never reach the chip.
  const { containers, unreconciled } = groupContainers([
    line({ poNumber: 'PO1738', expectedReceipt: '2026-06-01', qtyOrdered: 800, qtyReceived: 790, qtyRemaining: 10 }),
  ], { today: TODAY })

  assert.equal(containers.length, 0)
  assert.equal(unreconciled.length, 1)
  assert.equal(unreconciled[0].state, 'remnant')
  assert.equal(lateContainers(containers).length, 0)
})

test('containers older than the window collapse as long-past, not overdue', () => {
  // The app cannot tell "never arrived" from "arrived and was never closed out",
  // so anything this old is labelled unreconciled rather than late.
  const { containers, unreconciled } = groupContainers([
    line({ poNumber: 'PO1409', expectedReceipt: '2025-04-24', qtyReceived: 0 }),
  ], { today: TODAY })

  assert.equal(containers.length, 0)
  assert.equal(unreconciled[0].state, 'long-past')
  assert.ok(unreconciled[0].daysLate > LIVE_WINDOW_DAYS)
})

test('a barely-receipted container is late, not "being worked"', () => {
  // Real 2026-07-01: 2,135 ordered, 135 received, 32 days past due. An earlier
  // cut called any receipt at all "receiving", which filed both genuinely late
  // containers as in-progress while ancient one-unit dregs took the chip.
  const { containers } = groupContainers([
    line({ expectedReceipt: '2026-07-01', qtyOrdered: 2135, qtyReceived: 135, qtyRemaining: 2000 }),
  ], { today: TODAY })

  assert.equal(containers[0].state, 'late')
  assert.match(containerHeadline(containers[0]), /only 135 received/)
})

test('containerState: the threshold boundaries', () => {
  assert.equal(containerState(REMNANT_RECEIVED_PCT, 5), 'remnant')      // exactly 90% collapses
  assert.equal(containerState(REMNANT_RECEIVED_PCT - 0.01, 5), 'late')
  assert.equal(containerState(0, LIVE_WINDOW_DAYS), 'late')             // last day in the window
  assert.equal(containerState(0, LIVE_WINDOW_DAYS + 1), 'long-past')
  assert.equal(containerState(0, 0), 'awaiting')
  // A fully-received container collapses even when it is ancient — the remnant
  // test runs first so the reason shown is the accurate one.
  assert.equal(containerState(1, 900), 'remnant')
})

test('an undated PO line is never called late', () => {
  // The ledger's honest-timestamp rule: no due date is no basis for "overdue".
  const { containers, unreconciled, undated } = groupContainers([
    line({ expectedReceipt: null }), line({ expectedReceipt: undefined }),
  ], { today: TODAY })
  assert.equal(containers.length, 0)
  assert.equal(unreconciled.length, 0)
  assert.equal(undated.length, 2)
})

test('fully received and dismissed lines are not open supply', () => {
  const { containers, unreconciled, undated } = groupContainers([
    line({ qtyRemaining: 0 }),
    line({ dismissed: true }),
  ], { today: TODAY })
  assert.deepEqual([containers.length, unreconciled.length, undated.length], [0, 0, 0])
})

test('lines with no Final Naghedi Destination are counted, not dropped', () => {
  // 327 live lines across 16 POs have no destination, which makes them
  // unmatchable to any OC — a finding to surface, not rows to hide.
  const { containers } = groupContainers([
    line({ item: 'A', destination: '' }),
    line({ item: 'B', destination: null }),
    line({ item: 'C', destination: 'Warehouse Bulk : Nordstrom' }),
  ], { today: TODAY })

  assert.equal(containers[0].lineCount, 3)
  assert.equal(containers[0].unmatchableLines, 2)
  assert.deepEqual(containers[0].destinations, ['Warehouse Bulk : Nordstrom'])
})

test('the live board is ordered most-overdue first', () => {
  const { containers } = groupContainers([
    line({ poNumber: 'A', expectedReceipt: '2026-09-15' }),
    line({ poNumber: 'B', expectedReceipt: '2026-07-01' }),
    line({ poNumber: 'C', expectedReceipt: '2026-07-15' }),
  ], { today: TODAY })
  assert.deepEqual(containers.map((c) => c.expectedReceipt), ['2026-07-01', '2026-07-15', '2026-09-15'])
})

test('units total across every line in the container', () => {
  const { containers } = groupContainers([
    line({ item: 'A', qtyOrdered: 100, qtyReceived: 40, qtyRemaining: 60 }),
    line({ item: 'B', qtyOrdered: 50, qtyReceived: 0, qtyRemaining: 50 }),
  ], { today: TODAY })
  const c = containers[0]
  assert.equal(c.unitsOrdered, 150)
  assert.equal(c.unitsReceived, 40)
  assert.equal(c.unitsOpen, 110)
  assert.ok(Math.abs(c.receivedPct - 40 / 150) < 1e-9)
})

test('headlines read as plain English, singular and plural', () => {
  const one = groupContainers([line({ qtyOrdered: 1, qtyRemaining: 1, expectedReceipt: '2026-08-01' })], { today: TODAY })
  assert.match(containerHeadline(one.containers[0]), /^1 PO, 1 unit — due 1 day ago/)

  const soon = groupContainers([line({ expectedReceipt: '2026-08-15' })], { today: TODAY })
  assert.match(containerHeadline(soon.containers[0]), /expected in 13 days/)
})
