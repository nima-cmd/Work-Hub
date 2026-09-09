// test/inventoryTransferCsv.test.js — moving what arrived, and only what arrived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInventoryTransferCsv, destinationFor, buildNetsuiteExport } from '../src/model/inventoryTransferCsv.js'
import { indexPoLines } from '../src/model/itemReceiptCsv.js'

const PO_LINES = [
  { poNumber: '1785', sku: 'A-X', item_line_position: 1, qty_ordered: 25, qty_received: 0, final_destination: 'Virtual Warehouse' },
  { poNumber: '1785', sku: 'B-Y', item_line_position: 2, qty_ordered: 60, qty_received: 0, final_destination: 'Virtual Warehouse' },
]
const slip = (skuTotals) => ({ containerNum: '55', containerDate: '2026.9.7', skuTotals })
const rowsOf = (r) => r.csv.trim().split('\n').slice(1).map((l) => l.split(','))

test('⚠️ AN ALREADY-RECEIVED PO STILL TRANSFERS', () => {
  // The asymmetry I had backwards in a comment before checking. PO 9999 has no open
  // lines, so the receipt skips it — but its units are in China and they are moving.
  // Excluding it would strand them there forever.
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(slip([{ poNumber: '9999', sku: 'C-Z', units: 12 }]), byPo, [])
  const rows = rowsOf(r)
  assert.equal(rows.length, 1, 'the PO the receipt could not touch is still moved')
  assert.equal(rows[0][8], 'C-Z')
  assert.equal(rows[0][9], '12')
})

test('⚠️ BUT AN UNMATCHED LINE DOES NOT TRANSFER', () => {
  // Never received, so nothing to move. Held back and reported, not dropped.
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(
    slip([{ poNumber: '1785', sku: 'A-X', units: 25 }, { poNumber: '1785', sku: 'GHOST-X', units: 3 }]),
    byPo,
    [{ poNumber: '1785', sku: 'GHOST-X', qty: 3 }],
  )
  assert.deepEqual(rowsOf(r).map((x) => x[8]), ['A-X'])
  assert.equal(r.heldBack.length, 1)
  assert.match(r.heldBack[0].reason, /not received/)
})

test('⚠️ THE EXCLUSION IS PER LINE, NOT PER PO', () => {
  // One bad SKU must not stop the rest of its own PO from moving.
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(
    slip([{ poNumber: '1785', sku: 'A-X', units: 25 }, { poNumber: '1785', sku: 'B-Y', units: 60 }, { poNumber: '1785', sku: 'GHOST-X', units: 3 }]),
    byPo,
    [{ poNumber: '1785', sku: 'GHOST-X', qty: 3 }],
  )
  assert.deepEqual(rowsOf(r).map((x) => x[8]).sort(), ['A-X', 'B-Y'])
})

test('the destination comes from the PO Final Naghedi Destination', () => {
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }]), byPo, [])
  assert.equal(rowsOf(r)[0][4], 'Virtual Warehouse')
  assert.equal(rowsOf(r)[0][3], 'China', 'always out of China')
  assert.deepEqual(r.missingDestinations, [])
})

test('⚠️ A BLANK DESTINATION IS USED BUT REPORTED', () => {
  // The fallback is the WRONG location, and this transfer physically moves stock in
  // the books. Refusing to generate helps nobody; going quiet is what does damage.
  const { byPo } = indexPoLines([{ poNumber: '1785', sku: 'A-X', item_line_position: 1, qty_ordered: 25, qty_received: 0, po_location: 'Warehouse Bulk' }])
  const r = buildInventoryTransferCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }]), byPo, [])
  assert.equal(rowsOf(r)[0][4], 'Warehouse Bulk')
  assert.deepEqual(r.missingDestinations, [{ poNumber: 'PO1785', fallbackLocation: 'Warehouse Bulk', units: 25 }])
})

test('with nothing at all to go on, it falls back to Warehouse and says so', () => {
  const d = destinationFor([])
  assert.deepEqual(d, { location: 'Warehouse', isFallback: true })
})

test('⚠️ STYLE AND COLOUR ARE DELIBERATELY EMPTY', () => {
  // NetSuite derives both from the item. Supplying them invites a disagreement
  // between the file and the item record that the import resolves silently.
  const { byPo } = indexPoLines(PO_LINES)
  const row = rowsOf(buildInventoryTransferCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }]), byPo, []))[0]
  assert.equal(row[6], '', 'Style Number')
  assert.equal(row[7], '', 'Color')
})

test('the header and External ID are what the import expects', () => {
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }]), byPo, [])
  assert.equal(r.csv.split('\n')[0],
    'External ID,Memo,Date,From Location,To Location,PO #,Style Number,Color,Item,Quantity,Purchase Order')
  const row = rowsOf(r)[0]
  assert.equal(row[0], 'EXT-55 carton 2026.9.71785', 'the receipt key minus IR-')
  assert.equal(row[5], '1785', 'PO # is digits only')
  assert.equal(row[10], 'Purchase Order #PO1785')
  assert.equal(r.filename, 'Inventory Transfer - 55 carton 2026.9.7.csv')
})

test('⚠️ THE TWO EXTERNAL IDS PAIR, WHICH IS HOW A SLIP IS LINKED TO NETSUITE LATER', () => {
  // Verified live: EXT-IR-321 carton 2026.7.101706 and EXT-321 carton
  // 2026.7.101706 are the same shipment. 134 such pairs already exist.
  return buildNetsuiteExport(
    { containerNum: '321', containerDate: '2026.7.10', skuTotals: [{ poNumber: '1706', sku: 'A-X', units: 1 }] },
    [{ poNumber: '1706', sku: 'A-X', item_line_position: 1, qty_ordered: 1, qty_received: 0, final_destination: 'Warehouse' }],
  ).then(({ itemReceipt, transfer, importOrder }) => {
    const ir = itemReceipt.csv.trim().split('\n')[1].split(',')[0]
    const tr = transfer.csv.trim().split('\n')[1].split(',')[0]
    assert.equal(ir, 'EXT-IR-321 carton 2026.7.101706')
    assert.equal(tr, 'EXT-321 carton 2026.7.101706')
    assert.equal(`EXT-IR-${tr.slice(4)}`, ir, 'one is the other with IR- inserted')
    assert.deepEqual(importOrder, ['itemReceipt', 'transfer'], 'receipt first, always')
  })
})

test('not-tracked items stay off the transfer too', () => {
  const { byPo } = indexPoLines(PO_LINES)
  const r = buildInventoryTransferCsv(slip([{ poNumber: '1785', sku: 'A-X', units: 25 }, { poNumber: '1785', sku: 'HANGTAG-RED', units: 300 }]), byPo, [])
  assert.deepEqual(rowsOf(r).map((x) => x[8]), ['A-X'])
  assert.equal(r.excluded.length, 1)
})
