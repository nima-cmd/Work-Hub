// test/pickStock.test.js — on-hand stock on the bulk pick ticket, and the short call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { withStock, stockColumns, stockLocationIds } from '../src/model/pickStock.js'
import { bulkPick } from '../src/model/bulkPick.js'
import { pickStockSql, normaliseStockRow, STOCK_LOCATIONS } from '../src/ingest/bulkPickFetch.js'

// A line as the live query returns it, for a Bloomingdale's multi-store PO.
const line = (o) => ({
  po: 'P1', tranid: 'SO1', customer: 'Bloomingdale\'s - 12 - Soho', sku: 'SN01', itemId: '101',
  itemtype: 'InvtPart', quantity: -10, isclosed: 'F', locationId: '7',
  locationName: "Warehouse Bulk : Bloomingdale's", ...o,
})
const stock = (itemId, locationId, onHand) => ({ itemId, locationId, onHand })
const opts = { locations: STOCK_LOCATIONS, ok: true }

test("⚠️ the order's own location is a column, and it is NOT Warehouse", () => {
  // Measured live 2026-09-01: every line of PO 7242978 sits in `Warehouse Bulk :
  // Bloomingdale's`, a bucket holding 0 units of all 10 SKUs. Showing only Warehouse and
  // Virtual Warehouse would never say where the order actually is.
  const t = bulkPick([line()], ['P1'])
  assert.deepEqual(t.orderLocations, [{ id: '7', name: "Warehouse Bulk : Bloomingdale's" }])
  const cols = stockColumns(t.orderLocations, STOCK_LOCATIONS)
  assert.deepEqual(cols.map((c) => c.name), ["Warehouse Bulk : Bloomingdale's", 'Warehouse', 'Virtual Warehouse'])
  assert.deepEqual(cols.map((c) => c.isOrderLocation), [true, false, false])
})

test('⚠️ a boutique order already IN Warehouse does not get the column twice', () => {
  const t = bulkPick([line({ locationId: '2', locationName: 'Warehouse' })], ['P1'])
  const cols = stockColumns(t.orderLocations, STOCK_LOCATIONS)
  assert.deepEqual(cols.map((c) => c.name), ['Warehouse', 'Virtual Warehouse'])
  assert.equal(cols[0].isOrderLocation, true)
})

test('⚠️ SHORT IS ON HAND vs UNITS NEEDED — not availability (Nima, 2026-09-01)', () => {
  // His reasoning: the sales order being picked is itself the commitment, so `available`
  // has already deducted it. On hand 29 against a need of 10 is not short, even though
  // the same row reads available 0 in NetSuite.
  const t = bulkPick([line({ quantity: -10 })], ['P1'])
  const s = withStock(t, [stock('101', '7', 0), stock('101', '2', 29), stock('101', '3', 0)], opts)
  assert.equal(s.skus[0].onHandTotal, 29)
  assert.equal(s.skus[0].short, 0)
  assert.deepEqual(s.shortSkus, [])
})

test('short is named with need, have and the gap', () => {
  const t = bulkPick([line({ quantity: -40 })], ['P1'])
  const s = withStock(t, [stock('101', '7', 0), stock('101', '2', 12), stock('101', '3', 5)], opts)
  assert.deepEqual(s.shortSkus, [{ sku: 'SN01', need: 40, have: 17, short: 23 }])
})

test('⚠️ the shortfall is measured across ALL columns, never one location', () => {
  // The partner bucket is empty by design — stock is transferred in at pick time. A
  // per-location test would flag every SKU of a perfectly healthy pull.
  const t = bulkPick([line({ quantity: -10 })], ['P1'])
  const s = withStock(t, [stock('101', '7', 0), stock('101', '2', 10)], opts)
  assert.equal(s.skus[0].onHand['7'], 0)
  assert.equal(s.skus[0].short, 0)
})

test('⚠️ a NULL on-hand reads as 0 but never removes the location', () => {
  // aggregateItemLocation returned a null on-hand at Virtual Warehouse on the very first
  // SKU of PO 7242978. Dropping the row would drop the column.
  const t = bulkPick([line({ quantity: -1 })], ['P1'])
  const s = withStock(t, [stock('101', '3', null)], opts)
  assert.equal(s.skus[0].onHand['3'], 0)
  assert.equal(Object.keys(s.skus[0].onHand).length, 3)
})

test('⚠️ negative on-hand is SHOWN, and only the shortfall is clamped', () => {
  const t = bulkPick([line({ quantity: -5 })], ['P1'])
  const s = withStock(t, [stock('101', '2', -4)], opts)
  assert.equal(s.skus[0].onHand['2'], -4)
  // needed 5, an oversold location holds nothing to pull → short 5, not 9.
  assert.equal(s.skus[0].short, 5)
  assert.equal(s.skus[0].onHandTotal, 0)
})

test('⚠️ A FAILED LOOKUP IS UNKNOWN, NOT ZERO — and nothing is called short', () => {
  // A sheet reporting zero stock because a query timed out would have someone cancel a
  // pull they could have made.
  const t = bulkPick([line({ quantity: -10 })], ['P1'])
  const s = withStock(t, [], { locations: STOCK_LOCATIONS, ok: false, error: 'timeout' })
  assert.equal(s.stockKnown, false)
  assert.equal(s.stockError, 'timeout')
  assert.deepEqual(s.shortSkus, [])
  assert.equal(s.skus[0].onHandTotal, undefined)
})

test('the ticket still totals units when stock is unknown', () => {
  const t = bulkPick([line({ quantity: -10 })], ['P1'])
  const s = withStock(t, [], { locations: STOCK_LOCATIONS, ok: false })
  assert.equal(s.totalUnits, 10)
  assert.equal(s.skus.length, 1)
})

test('⚠️ the stock query is scoped by INTEGER ids, never a quoted string', () => {
  const sql = pickStockSql(['101', '102'], ['7', '2', '3'])
  assert.match(sql, /il\.item IN \(101, 102\)/)
  assert.match(sql, /il\.location IN \(7, 2, 3\)/)
  assert.match(sql, /quantityonhand/)
  // ⚠️ Never `quantityavailable` — that is the measure this feature deliberately rejects.
  assert.doesNotMatch(sql, /quantityavailable/)
})

test('⚠️ a non-integer id is dropped, not interpolated', () => {
  assert.equal(pickStockSql(["1 OR 1=1"], ['2']), null)
  assert.match(pickStockSql(['101', "1;DROP"], ['2']), /il\.item IN \(101\)/)
})

test('no items or no locations means no query at all', () => {
  assert.equal(pickStockSql([], ['2']), null)
  assert.equal(pickStockSql(['101'], []), null)
})

test('⚠️ stock rows are read case-insensitively, like every other SuiteQL alias', () => {
  // SuiteQL lowercases aliases; `qty_on_hand` and `QTY_ON_HAND` must both land.
  const r = normaliseStockRow({ ITEM_ID: 101, location_id: 2, LOCATION_NAME: 'Warehouse', qty_on_hand: 29 })
  assert.deepEqual(r, { itemId: 101, locationId: 2, locationName: 'Warehouse', onHand: 29 })
})

test('the live query is scoped to the order location plus the two Glendale buckets', () => {
  const t = bulkPick([line()], ['P1'])
  assert.deepEqual(stockLocationIds(t.orderLocations, STOCK_LOCATIONS), ['7', '2', '3'])
})

test('⚠️ a fully-cancelled PO adds no location column', () => {
  // Same rule as the headline counts: the table describes what is being PICKED.
  const t = bulkPick([line({ isclosed: 'T', locationId: '9', locationName: 'Warehouse Bulk : Tuckernuck' })], ['P1'])
  assert.deepEqual(t.orderLocations, [])
})
