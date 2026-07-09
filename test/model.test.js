// Unit tests for the pure model logic (no DB, no network).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv } from '../src/ingest/csv.js'
import {
  refNumber, cleanName, num, fromOpenSalesOrders, fromUnpackedFulfillments, fromFulfillmentPipeline,
} from '../src/ingest/savedSearches.js'
import { buildPipeline, computeFlags } from '../src/model/pipeline.js'
import { deriveSource } from '../src/model/source.js'
import { STAGE } from '../src/model/stages.js'

test('parseCsv handles quoted commas and duplicate headers', () => {
  const rows = parseCsv('a,b,b\n"x,y",2,3\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].a, 'x,y') // comma preserved inside quotes
  assert.equal(rows[0].b, '2') // first "b"
  assert.equal(rows[0]['b (2)'], '3') // duplicate header disambiguated
})

test('saved-search helpers normalize NetSuite formats', () => {
  assert.equal(refNumber('Sales Order #SO12043'), 'SO12043')
  assert.equal(refNumber('Transfer Order #TO171'), 'TO171')
  assert.equal(cleanName('494 Level Shoes'), 'Level Shoes')
  assert.equal(num('.00'), 0)
  assert.equal(num('6,837.00'), 6837)
  assert.equal(num(''), null)
})

test('buildPipeline merges sources by SO and picks the furthest stage', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', customer: 'X' },
    { source: 'inv', stage: STAGE.INVOICED, soNumber: 'SO1', shippingStatus: 'Pending Payment', customer: 'X' },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders.length, 1)
  assert.equal(orders[0].soNumber, 'SO1')
  assert.equal(orders[0].stage, STAGE.INVOICED) // invoiced (rank 4) beats picked (rank 2)
  assert.equal(orders[0].fulfillments.length, 1)
})

test('buildPipeline drops Transfer Order records — not tracked', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'TO171', ifNumber: 'IF7145', customer: 'X' },
    { source: 'open', stage: STAGE.OPEN, soNumber: 'SO1', customer: 'Y' },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders.length, 1)
  assert.equal(orders[0].soNumber, 'SO1')
})

test('fromUnpackedFulfillments drops Transfer Order rows at the source', () => {
  // Regression: buildPipeline() skips TO# records, but loadFulfillments/
  // loadInvoices read the raw mapper output directly and don't go through
  // buildPipeline — so a TO row surviving the mapper caused a foreign-key
  // crash (fulfillments row referencing an order that was never inserted).
  const rows = fromUnpackedFulfillments([
    { 'Document Number': 'IF7145', 'Created From': 'Transfer Order #TO171', Status: 'Picked', Date: '5/26/2026' },
    { 'Document Number': 'IF7264', 'Created From': 'Sales Order #SO12062', Status: 'Picked', Date: '6/29/2026' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].soNumber, 'SO12062')
})

test('computeFlags reads shortage through ATS (only while Open)', () => {
  const today = new Date('2026-07-08')
  const ats = computeFlags(
    { stage: STAGE.OPEN, isAts: true, qtyOrdered: 8, qtyAllocated: 6, qtyFulfilled: 0, fulfillments: [] },
    today,
  )
  assert.ok(ats.some((f) => f.key === 'STOCK_SHORT'))

  const nonAts = computeFlags(
    { stage: STAGE.OPEN, isAts: false, qtyOrdered: 10, qtyAllocated: 2, qtyFulfilled: 0, fulfillments: [] },
    today,
  )
  assert.ok(nonAts.some((f) => f.key === 'AWAITING_PO'))
  assert.ok(!nonAts.some((f) => f.key === 'STOCK_SHORT'))
})

test('computeFlags suppresses shortage once an IF exists (Picked+)', () => {
  // Eleanor case: order for 5, only 3 committed, but an IF is already picked
  // and shipping the 3 on hand. The "short 2" is a settled decision, not an
  // alert — so no STOCK_SHORT once the order has moved past Open.
  const flags = computeFlags(
    { stage: STAGE.PICKED, isAts: true, qtyOrdered: 5, qtyAllocated: 3, qtyFulfilled: 0, fulfillments: [{ status: 'Picked' }] },
    new Date('2026-07-08'),
  )
  assert.ok(!flags.some((f) => f.key === 'STOCK_SHORT'))
})

test('computeFlags flags an overdue ship date', () => {
  const flags = computeFlags(
    { shipDate: new Date('2026-06-01'), fulfillments: [] },
    new Date('2026-07-08'),
  )
  assert.ok(flags.some((f) => f.key === 'OVERDUE'))
})

test('deriveSource classifies EDI partners', () => {
  assert.equal(deriveSource('599 Nordstrom - Cedar Rapids'), 'edi')
  assert.equal(deriveSource('166 ShopBop'), 'edi')
  assert.equal(deriveSource('Bloomingdale’s'), 'edi')
  assert.equal(deriveSource('509 Kapok'), 'boutique')
})

test('fromOpenSalesOrders gates on Approval Status and reads invoice', () => {
  const rows = fromOpenSalesOrders([
    { 'Document Number': 'SO1', 'Maximum of Approval Status': 'On Hold' },
    { 'Document Number': 'SO2', 'Maximum of Approval Status': 'Approved' },
    { 'Document Number': 'SO3' }, // no column at all — must default to OPEN, not hidden
    // has an invoice → INVOICED (its invoice columns come from the Billing join)
    {
      'Document Number': 'SO4', 'Maximum of Approval Status': 'Approved',
      'Maximum of Document Number': 'INV999', 'Maximum of Status (2)': 'Open',
      'Maximum of Invoice Status': 'Approved For Shipping',
    },
  ])
  assert.equal(rows.find((r) => r.soNumber === 'SO1').stage, STAGE.ON_HOLD)
  assert.equal(rows.find((r) => r.soNumber === 'SO2').stage, STAGE.OPEN)
  assert.equal(rows.find((r) => r.soNumber === 'SO3').stage, STAGE.OPEN)
  const so4 = rows.find((r) => r.soNumber === 'SO4')
  assert.equal(so4.stage, STAGE.INVOICED) // buildPipeline promotes to APPROVED via shippingStatus
  assert.equal(so4.invoice, 'INV999')
  assert.equal(so4.shippingStatus, 'Approved For Shipping')
})

test('fromFulfillmentPipeline maps Picked/Packed and drops Transfer Orders', () => {
  const rows = fromFulfillmentPipeline([
    { 'Document Number': 'IF1', 'Maximum of Created From': 'Sales Order #SO1', 'Maximum of Status': 'Picked', 'Maximum of Date': '7/8/2026', 'Maximum of Name': 'Eleanor' },
    { 'Document Number': 'IF2', 'Maximum of Created From': 'Sales Order #SO2', 'Maximum of Status': 'Packed', 'Maximum of Date': '7/2/2026' },
    { 'Document Number': 'IF3', 'Maximum of Created From': 'Transfer Order #TO9', 'Maximum of Status': 'Picked' },
  ])
  assert.equal(rows.length, 2) // TO dropped
  assert.equal(rows.find((r) => r.ifNumber === 'IF1').stage, STAGE.PICKED)
  assert.equal(rows.find((r) => r.ifNumber === 'IF1').soNumber, 'SO1')
  assert.equal(rows.find((r) => r.ifNumber === 'IF2').stage, STAGE.PACKED)
})

test('fromUnpackedFulfillments branches Picked vs Shipped per row', () => {
  const rows = fromUnpackedFulfillments([
    { 'Document Number': 'IF1', 'Created From': 'SO1', Status: 'Picked', Date: '7/1/2026' },
    { 'Document Number': 'IF2', 'Created From': 'SO2', Status: 'Shipped', Date: '7/2/2026' },
  ])
  const picked = rows.find((r) => r.ifNumber === 'IF1')
  const shipped = rows.find((r) => r.ifNumber === 'IF2')
  assert.equal(picked.stage, STAGE.PICKED)
  assert.equal(picked.actualShipDate, null)
  assert.equal(shipped.stage, STAGE.SHIPPED)
  assert.ok(shipped.actualShipDate instanceof Date)
})

test('buildPipeline computes Picked staleness from date and flags it', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', customer: 'X', date: new Date('2026-07-01') },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders[0].daysPending, 7)
  assert.ok(orders[0].flags.some((f) => f.key === 'PICK_STALLED'))
})

test('computeFlags suppresses shortage noise while On Hold', () => {
  const flags = computeFlags(
    { stage: STAGE.ON_HOLD, isAts: true, qtyOrdered: 8, qtyAllocated: 6, qtyFulfilled: 0, fulfillments: [] },
    new Date('2026-07-08'),
  )
  assert.ok(!flags.some((f) => f.key === 'STOCK_SHORT'))
})
