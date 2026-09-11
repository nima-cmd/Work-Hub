// test/bulkPickAllocation.test.js — the shortage half of the existing bulk pick.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demandLines, poolFor, bulkPick, leafLocation } from '../src/model/bulkPick.js'
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

const TICKET = {
  stockColumns: [
    { id: '7', name: "Warehouse Bulk : Bloomingdale's", isOrderLocation: true },
    { id: '2', name: 'Warehouse' },
    { id: '19', name: 'Offsite Storage', offsite: true },
  ],
  skus: [{ sku: 'K', onHand: { 7: 72, 2: 5, 19: 0 } }],
}

test('⚠️ THE POOL COMES FROM THE TICKET, NOT THE RAW STOCK ROWS', () => {
  // The raw rows are keyed by ITEM ID, so reading them by `sku` silently yields an
  // empty pool — live, that surfaced as "no stock rows for pool Bloomingdale's" on a
  // ticket visibly printing a Bloomingdale's column with 72 in it. withStock() has
  // already done the itemId->sku join and keyed on-hand by location id.
  assert.deepEqual(poolFor(TICKET, "Bloomingdale's"), { K: 72 })
  assert.deepEqual(poolFor(TICKET, 'Warehouse'), { K: 5 })
  assert.deepEqual(poolFor(TICKET, 'Offsite Storage'), { K: 0 })
})

test('⚠️ ONE POOL, NEVER THE SUM — 72 is the answer, not 77', () => {
  // Nima: "what we have in the warehouse for bloomingdaels is all we can use."
  // Summing the columns would report 77 and understate the shortage by 5.
  const pool = poolFor(TICKET, "Bloomingdale's")
  assert.equal(pool.K, 72)
  const summed = Object.values(TICKET.skus[0].onHand).reduce((a, n) => a + n, 0)
  assert.equal(summed, 77, 'which is what NOT choosing a pool would have used')
})

test('an unknown pool is null, so the caller can list the real ones', () => {
  assert.equal(poolFor(TICKET, 'Nowhere'), null)
  assert.equal(poolFor(TICKET, ''), null)
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
  const pool = poolFor(TICKET, "Bloomingdale's")
  const s = shortfall(demand, pool)
  assert.equal(s.totalDemand, 137)
  assert.equal(s.totalShort, 65)
  const p = allocate(demand, pool, { rule: 'whole-line-smallest-first' })
  assert.equal(p.lines.filter((l) => l.allocated > 0 && l.cut > 0).length, 0, 'no partials')
})

test('⚠️ THE POOL MATCHES ON THE LEAF — NetSuite location names are PATHS', () => {
  // pickStockSql selects l.fullname, so a row reads "Naghedi : Bloomingdale's".
  // Comparing the whole path against "Bloomingdale's" matches nothing — and that is
  // exactly what happened on the first live call: the ticket printed a Bloomingdale's
  // column holding 72 while the allocation said there were no stock rows for that
  // pool. The repo already had this trap recorded for destinations.
  // The live column is literally named "Warehouse Bulk : Bloomingdale's".
  assert.deepEqual(poolFor(TICKET, "Bloomingdale's"), { K: 72 })
  // Works from either side: a full path as the pool name resolves too.
  assert.deepEqual(poolFor(TICKET, "Warehouse Bulk : Bloomingdale's"), { K: 72 })
})

test('leafLocation is the same split the display helper uses', async () => {
  const { leafLocation } = await import('../src/model/bulkPick.js')
  assert.equal(leafLocation("Naghedi : Bloomingdale's"), "Bloomingdale's")
  assert.equal(leafLocation('Warehouse'), 'Warehouse')
  assert.equal(leafLocation('A : B : C'), 'C')
  assert.equal(leafLocation(null), '')
})
