// test/bulkPickAllocation.test.js — the shortage half of the existing bulk pick.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demandLines, poolFor, bulkPick } from '../src/model/bulkPick.js'
import { shortfall, allocate } from '../src/model/allocationPlan.js'

const row = (o) => ({
  po: '1236143', tranid: 'SO1', customer: "0002 Bloomingdale's - 0002 Boca Raton",
  sku: 'K', itemId: '1', itemtype: 'InvtPart', quantity: -10, isclosed: 'F',
  locationId: '9', locationName: "Bloomingdale's", ...o,
})

test('⚠️ THE ALLOCATION USES THE TICKET\'S OWN FILTERS, NOT ITS OWN', () => {
  // If the allocation re-filtered independently, the two halves of one sheet would
  // disagree about what is shipping — the ticket totalling one number and the cut
  // list reconciling to another, with no way to tell which was right.
  const lines = [
    row({ tranid: 'SO1', quantity: -10 }),
    row({ tranid: 'SO2', quantity: -6, isclosed: 'T' }),        // closed — dropped by both
    row({ tranid: 'SO3', quantity: -4, itemtype: 'Discount' }), // non-goods — dropped by both
  ]
  const ticket = bulkPick(lines, ['1236143'])
  const demand = demandLines(lines, ['1236143'])
  assert.equal(demand.length, 1)
  assert.equal(demand[0].qty, 10)
  // The ticket's SKU total and the demand total must agree, always.
  assert.equal(ticket.skus.find((s) => s.sku === 'K').total,
    demand.reduce((a, d) => a + d.qty, 0))
})

test('⚠️ QUANTITIES ARE ABS\'d — SuiteQL returns sales-order lines NEGATIVE', () => {
  const demand = demandLines([row({ quantity: -10 })], ['1236143'])
  assert.equal(demand[0].qty, 10)
})

test('⚠️ ONE POOL, BY NAME — summing every location would allocate stock in China', () => {
  // Nima: "what we have in the warehouse for bloomingdaels is all we can use."
  const rows = [
    { sku: 'K', locationName: "Bloomingdale's", onHand: 72 },
    { sku: 'K', locationName: 'China', onHand: 97 },
    { sku: 'K', locationName: 'Damages', onHand: 2 },
  ]
  assert.deepEqual(poolFor(rows, "Bloomingdale's"), { K: 72 })
  assert.deepEqual(poolFor(rows, 'China'), { K: 97 })
  // Case and padding do not matter; an unnamed pool yields nothing rather than everything.
  assert.deepEqual(poolFor(rows, "  bloomingdale's "), { K: 72 })
  assert.equal(poolFor(rows, ''), null)
  assert.deepEqual(poolFor(rows, 'Nowhere'), {})
})

test('the live Bloomingdale\'s case reproduces end to end', () => {
  // 137 wanted across two POs, 72 in the pool, whole-line cuts only.
  const lines = [
    row({ po: '1236132', tranid: 'SO12577', customer: '0231 CFC', quantity: -50 }),
    row({ po: '1236143', tranid: 'SO12601', quantity: -10 }),
    row({ po: '1236143', tranid: 'SO12604', quantity: -10 }),
    row({ po: '1236143', tranid: 'SO12589', quantity: -4 }),
    row({ po: '1236143', tranid: 'SO12607', quantity: -1 }),
    row({ po: '1236143', tranid: 'SO12588', quantity: -62 }),
  ]
  const demand = demandLines(lines, ['1236143', '1236132'])
  const pool = poolFor([{ sku: 'K', locationName: "Bloomingdale's", onHand: 72 }], "Bloomingdale's")
  const s = shortfall(demand, pool)
  assert.equal(s.totalDemand, 137)
  assert.equal(s.totalShort, 65)
  const p = allocate(demand, pool, { rule: 'whole-line-smallest-first' })
  assert.equal(p.lines.filter((l) => l.allocated > 0 && l.cut > 0).length, 0, 'no partials')
})
