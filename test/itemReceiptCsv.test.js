// test/itemReceiptCsv.test.js — the guards that took a long time to get right.
//
// Each test names what removing the rule costs, because none of it is visible in
// the CSV format and all of it was learned from failed imports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildItemReceiptCsv, indexPoLines, toPoFull, slipDateToUs, isNotTracked } from '../src/model/itemReceiptCsv.js'

// One PO, four item lines, one of them already fully received.
const PO_LINES = [
  { poNumber: '1785', sku: 'SN04022CP-FIRENZE', item_line_position: 1, qty_ordered: 25, qty_received: 0, final_destination: 'Warehouse' },
  { poNumber: '1785', sku: 'SN04023QJ-CHOCOLATE', item_line_position: 2, qty_ordered: 60, qty_received: 0, final_destination: 'Warehouse' },
  { poNumber: '1785', sku: 'SN13011QJ-LINEN', item_line_position: 3, qty_ordered: 40, qty_received: 40, final_destination: 'Warehouse' },
  { poNumber: '1785', sku: 'SN13012LD-CERISE', item_line_position: 4, qty_ordered: 60, qty_received: 20, final_destination: 'Warehouse' },
]
const slip = (skuTotals) => ({ containerNum: '55', containerDate: '2026.9.7', skuTotals })
const rowsOf = (r) => r.csv.trim().split('\n').slice(1).map((l) => l.split(','))

test('⚠️ THE F ROWS ARE MANDATORY — without them NetSuite auto-receives the rest', () => {
  // The most expensive lesson in the file. A receipt that names only what shipped
  // makes NetSuite receive every remaining open line, pulling in units that are
  // still at the factory.
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 }]), PO_LINES)
  const rows = rowsOf(r)
  const t = rows.filter((x) => x[7] === 'T')
  const f = rows.filter((x) => x[7] === 'F')
  assert.equal(t.length, 1, 'one shipped line')
  assert.ok(f.length >= 2, 'and an F row for every other STILL-OPEN line')
  assert.deepEqual(f.map((x) => x[4]).sort(), ['SN04023QJ-CHOCOLATE', 'SN13012LD-CERISE'])
})

test('⚠️ A FULLY-RECEIVED LINE IS EXCLUDED FROM THE F ROWS', () => {
  // It has nothing left to match, and the import dies on "Unable to find a matching
  // line for sublist expense". Safe to skip: a closed line has no balance to protect.
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 }]), PO_LINES)
  const skus = rowsOf(r).map((x) => x[4])
  assert.ok(!skus.includes('SN13011QJ-LINEN'), 'the 40-of-40 received line must not appear')
})

test('⚠️ T AND F SORT TOGETHER, LINE 1 FIRST', () => {
  // NetSuite's Standard Item Receipt form ANCHORS the receipt on the first CSV row
  // it sees. Two blocks — all T then all F — anchors it on whatever shipped first.
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 10 }]), PO_LINES)
  const rows = rowsOf(r)
  assert.deepEqual(rows.map((x) => Number(x[5])), [1, 2, 4], 'one ascending sequence')
  assert.equal(rows[0][4], 'SN04022CP-FIRENZE', 'order line 1 leads, though it did not ship')
  assert.equal(rows[0][7], 'F')
})

test('⚠️ OVER-RECEIVE IS MEASURED AGAINST REMAINING, NOT GROSS ORDERED', () => {
  // SN13012LD-CERISE is 60 ordered with 20 already received — 40 remaining. Shipping
  // 50 is an over-receive even though 50 < 60, and comparing against ordered would
  // let a second shipment of the same units through unnoticed.
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 50 }]), PO_LINES)
  assert.equal(r.overReceives.length, 1)
  assert.deepEqual(r.overReceives[0], {
    poNumber: 'PO1785', sku: 'SN13012LD-CERISE', shipped: 50,
    remaining: 40, ordered: 60, received: 20, excess: 10,
    // ⚠️ The line still HAS room (40 remaining), so this is extra shipped rather
    // than a re-import of a container already received.
    kind: 'excess-shipped',
  })
  assert.equal(r.blocked, true, 'and it BLOCKS the export by default')
})

test('⚠️ EXTRA SHIPPED AND A DUPLICATE IMPORT LOOK IDENTICAL, AND ARE NOT', () => {
  // Nima, 2026-09-11: "can we also receive the extra unit on the ir and use it on the
  // transfer and keep the PO the same showing the overrage in receipt."
  //
  // Yes — for the benign shape only. A line with room left that receives a few more
  // units than ordered is the factory making extras, and receiving them records what
  // physically arrived. A line with NOTHING remaining is what every line looks like
  // once this container's receipt has already been imported, and importing it again
  // doubles the stock silently. That was the four over-receives of 2026-09-08.
  const excess = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 41 }]), PO_LINES)
  assert.equal(excess.excessShipped.length, 1)
  assert.equal(excess.excessShipped[0].excess, 1)
  assert.equal(excess.blockingOverReceives.length, 0)
  assert.equal(excess.blocked, true, 'still blocks until someone decides')

  // ⚠️ acceptExcess is an explicit decision, and it lets ONLY this shape through.
  const accepted = buildItemReceiptCsv(
    slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 41 }]), PO_LINES, { acceptExcess: true })
  assert.equal(accepted.blocked, false)
  assert.equal(accepted.acceptedExcess.length, 1)
  // The receipt carries the FULL shipped quantity, so the PO reads "received 61 of 60".
  assert.ok(accepted.csv.includes(',41,'), 'the extra unit is on the receipt')
})

test('⚠️ acceptExcess NEVER LIFTS THE DUPLICATE BLOCK', () => {
  // A fully-received line has nothing remaining. Letting acceptExcess through here
  // would re-import a container that already landed and double the stock — the exact
  // failure the block exists for, reached by the door meant for the other case.
  // SN13011QJ-LINEN is 40 ordered, 40 received — nothing remaining. Shipping it
  // again is precisely what a re-imported container looks like.
  const dup = buildItemReceiptCsv(
    slip([{ poNumber: '1785', sku: 'SN13011QJ-LINEN', units: 40 }]), PO_LINES, { acceptExcess: true })
  assert.equal(dup.blockingOverReceives.length, 1)
  assert.equal(dup.blockingOverReceives[0].kind, 'nothing-remaining')
  assert.equal(dup.blocked, true, 'acceptExcess must not open this door')
  assert.deepEqual(dup.acceptedExcess, [])
})

test('a shipment inside the remaining balance is not flagged', () => {
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 40 }]), PO_LINES)
  assert.deepEqual(r.overReceives, [])
  assert.equal(r.blocked, false)
})

test('⚠️ GUARD 1 — A PO NOT OPEN IN NETSUITE IS DROPPED, NOT GUESSED AT', () => {
  // No order lines and no Created From to build against; it usually means already
  // fully received. Its POs feed the Transfer's exclusion list so both files agree.
  const r = buildItemReceiptCsv(slip([{ poNumber: '9999', sku: 'SN01-X', units: 5 }]), PO_LINES)
  assert.deepEqual(r.unknownPOs, [{ poNumber: 'PO9999', skuCount: 1, units: 5 }])
  assert.deepEqual(r.excludedPOs, ['PO9999'])
  assert.equal(r.rows, 0)
})

test('⚠️ GUARD 2 — A SHIPPED SKU WITH NO OPEN LINE IS FLAGGED, NOT INVENTED', () => {
  const r = buildItemReceiptCsv(slip([
    { poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 },
    { poNumber: '1785', sku: 'SN99999XX-GHOST', units: 3 },
  ]), PO_LINES)
  assert.deepEqual(r.unmatchedLines, [{ poNumber: 'PO1785', sku: 'SN99999XX-GHOST', qty: 3 }])
  assert.ok(!rowsOf(r).some((x) => x[4] === 'SN99999XX-GHOST'))
})

test('⚠️ ONE SKU ON TWO PO LINES BLOCKS THE EXPORT', () => {
  // Keyed PO+SKU, the index cannot represent both, and neither Order Line nor
  // match-by-item can reliably target the right one.
  const dupLines = [...PO_LINES, { poNumber: '1785', sku: 'SN04022CP-FIRENZE', item_line_position: 5, qty_ordered: 10, qty_received: 0 }]
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 }]), dupLines)
  assert.deepEqual(r.duplicateSkus, [{ poNumber: 'PO1785', skus: ['SN04022CP-FIRENZE'] }])
  assert.equal(r.blocked, true)
})

test('⚠️ ORDER LINE IS item_line_position, NOT line_seq', () => {
  // The Item Receipt's Order Line counts positions among ITEM lines only. A PO with
  // an expense or tax line before an item would shift every line_seq after it, and
  // the receipt would target the wrong line.
  const { byPo } = indexPoLines([
    { poNumber: '1785', sku: 'A-X', item_line_position: 1, line_seq: 3, qty_ordered: 5, qty_received: 0 },
    { poNumber: '1785', sku: 'B-Y', item_line_position: 2, line_seq: 7, qty_ordered: 5, qty_received: 0 },
  ])
  assert.equal(byPo.get('PO1785').get('A-X').orderLine, 1)
  assert.equal(byPo.get('PO1785').get('B-Y').orderLine, 2)
})

test('the header, External ID and Created From are exactly what the import expects', () => {
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 }]), PO_LINES)
  const header = r.csv.split('\n')[0]
  assert.equal(header, 'External ID,Created From,Date,Memo,Item,Order Line,Quantity,Receive,To Location')
  const row = rowsOf(r)[0]
  assert.equal(row[0], 'EXT-IR-55 carton 2026.9.71785')
  assert.equal(row[1], 'Purchase Order #PO1785')
  assert.equal(row[2], '09/07/2026')
  assert.equal(row[8], 'China')
  assert.equal(r.filename, 'Item Receipts - 55 carton 2026.9.7.csv')
})

test('⚠️ THE EXTERNAL ID MATCHES THE ONE ALREADY IN NETSUITE', () => {
  // Verified live: 134 records carry these keys, e.g. EXT-IR-321 carton
  // 2026.7.101706 paired with EXT-321 carton 2026.7.101706. Changing the shape
  // would orphan every past container from its receipt.
  const r = buildItemReceiptCsv(
    { containerNum: '321', containerDate: '2026.7.10', skuTotals: [{ poNumber: '1706', sku: 'A-X', units: 1 }] },
    [{ poNumber: '1706', sku: 'A-X', item_line_position: 1, qty_ordered: 1, qty_received: 0 }],
  )
  assert.equal(rowsOf(r)[0][0], 'EXT-IR-321 carton 2026.7.101706')
})

test('not-tracked items never reach a receipt, and are reported', () => {
  const r = buildItemReceiptCsv(slip([
    { poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 25 },
    { poNumber: '1785', sku: 'HANGTAG-BLACK', units: 500 },
    { poNumber: '1785', sku: 'STICKER-LOGO', units: 200 },
  ]), PO_LINES)
  assert.equal(r.excluded.length, 2, 'surfaced, never silently dropped')
  assert.ok(!rowsOf(r).some((x) => /HANGTAG|STICKER/.test(x[4])))
  assert.equal(isNotTracked('SN04022CP-FIRENZE'), false)
})

test('a PO number gains its prefix, and keeps it if it had one', () => {
  assert.equal(toPoFull('1785'), 'PO1785')
  assert.equal(toPoFull('PO1785'), 'PO1785')
  assert.equal(toPoFull('po1785'), 'PO1785')
})

test('slip dates become US format, whatever the separator', () => {
  assert.equal(slipDateToUs('2026.9.7'), '09/07/2026')
  assert.equal(slipDateToUs('2026-09-07'), '09/07/2026')
  assert.equal(slipDateToUs(null), '')
})

test('a container label with a comma is quoted, not left to break the file', () => {
  const r = buildItemReceiptCsv(
    { containerNum: 'Air, urgent', containerDate: '2026.9.9', skuTotals: [{ poNumber: '1785', sku: 'SN04022CP-FIRENZE', units: 1 }] },
    PO_LINES,
  )
  assert.match(r.csv.split('\n')[1], /"EXT-IR-Air, urgent carton 2026.9.91785"/)
})

test('⚠️ A MANUALLY CLOSED LINE IS NOT OPEN, WHATEVER THE ARITHMETIC SAYS', () => {
  // Closed short: 60 ordered, 0 received. remaining computes to 60 but the line is
  // not receivable — emitting a Receive = F row for it is exactly the case that
  // breaks the import with "Unable to find a matching line for sublist expense".
  // Found by diffing this pipeline against Naghedi-Warehouse, which reads isclosed.
  const lines = [
    { poNumber: '1785', sku: 'A-X', item_line_position: 1, qty_ordered: 25, qty_received: 0 },
    { poNumber: '1785', sku: 'CLOSED-SHORT', item_line_position: 2, qty_ordered: 60, qty_received: 0, line_closed: true },
  ]
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }]), lines)
  const skus = rowsOf(r).map((x) => x[4])
  assert.ok(!skus.includes('CLOSED-SHORT'), 'no F row for a closed line')
  assert.deepEqual(skus, ['A-X'])
})

test('⚠️ AND SHIPPING AGAINST A CLOSED LINE IS AN OVER-RECEIVE', () => {
  const lines = [{ poNumber: '1785', sku: 'CLOSED-SHORT', item_line_position: 1, qty_ordered: 60, qty_received: 0, line_closed: true }]
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'CLOSED-SHORT', units: 10 }]), lines)
  assert.equal(r.overReceives.length, 1)
  assert.equal(r.overReceives[0].remaining, 0)
  assert.equal(r.blocked, true)
})

test('⚠️ THE ACCEPTED EXTRA UNIT REACHES THE TRANSFER TOO', async () => {
  // "receive the extra unit on the ir and use it on the transfer" — a receipt that
  // takes 41 and a transfer that moves 40 would leave one unit received in China and
  // never moved, which is worse than not receiving it at all.
  const { buildNetsuiteExport } = await import('../src/model/inventoryTransferCsv.js')
  const out = await buildNetsuiteExport(
    slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 41 }]), PO_LINES, { acceptExcess: true })
  assert.equal(out.itemReceipt.blocked, false)
  assert.ok(out.itemReceipt.csv.includes(',41,'), 'the receipt takes all 41')
  assert.ok(out.transfer.csv.includes('41'), 'and the transfer moves all 41')
})

test('⚠️ WITHOUT THE DECISION, NEITHER FILE IS OFFERED', () => {
  // The default has to stay refusing. An over-receive that happens because nobody
  // looked is the failure this block was built for.
  const r = buildItemReceiptCsv(slip([{ poNumber: '1785', sku: 'SN13012LD-CERISE', units: 41 }]), PO_LINES)
  assert.equal(r.blocked, true)
  assert.deepEqual(r.acceptedExcess, [])
})
