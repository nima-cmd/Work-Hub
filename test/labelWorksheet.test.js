import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLabelWorksheet, shortStore, labelLine } from '../src/model/labelWorksheet.js'

// Nima, 2026-08-05: "it be nice to see with which store it goes to when i manually
// create the labels… We need the PO number and the store number on them."
//
// A DC-direct shipment has ONE address and many stores, so PO + store is the only
// thing distinguishing the labels.

const SHIP = {
  bolNumber: 'NB1731256', dc: 'CG', carrier: 'FEDEX GROUND', shipDirect: true,
  address: { name: "Macy's CFC China Grove DC", street: '1305 Liberty Ridge Rd', city: 'China Grove', state: 'NC', zip: '28023' },
}

test('a multi-carton fulfilment becomes one line per carton', () => {
  const w = buildLabelWorksheet(SHIP, [
    { poNumber: '8040291', storeNumber: '0231', storeName: "Bloomingdale's - 0231 China Grove Pool Stock/Customer", ifNumber: 'IF7469', cartons: 2, units: 54 },
    { poNumber: '8170355', storeNumber: '0231', storeName: "Bloomingdale's - 0231 China Grove", ifNumber: 'IF7476', cartons: 1, units: 19 },
  ])
  assert.equal(w.cartons, 3)          // 2 + 1 labels to type
  assert.equal(w.stores, 1)
  assert.equal(w.lines[0].cartonOf, '1 of 2')
  assert.equal(w.lines[1].cartonOf, '2 of 2')
  assert.equal(w.lines[2].cartonOf, null)   // a single carton says nothing
})

// ⚠️ Units are known per FULFILMENT, never per carton — nothing records which unit
// went in which box. A split would be a fabricated number printed on a label and
// then checked against a physical carton.
test('units are never split across a fulfilment\'s cartons', () => {
  const w = buildLabelWorksheet(SHIP, [
    { poNumber: '8040291', storeNumber: '0231', ifNumber: 'IF7469', cartons: 2, units: 54 },
  ])
  assert.equal(w.lines[0].ifUnits, 54)
  assert.equal(w.lines[1].ifUnits, 54)   // the IF total on BOTH, not 27 each
})

test('a fulfilment with no carton count still gets a line', () => {
  // A box exists physically whether or not the pack feed has caught up, and a
  // missing line is how a carton ships unlabelled.
  const w = buildLabelWorksheet(SHIP, [
    { poNumber: '8040313', storeNumber: '0002', ifNumber: 'IF7456', cartons: null, units: 1 },
  ])
  assert.equal(w.cartons, 1)
  assert.equal(w.lines[0].cartonsUnknown, true)
})

test('freight shipments get no parcel worksheet, and say so', () => {
  // Freight moves on the BOL — a per-carton parcel sheet is meaningless there, and
  // returning an empty list silently would look like missing data.
  const w = buildLabelWorksheet({ ...SHIP, shipDirect: false }, [
    { poNumber: '8040313', storeNumber: '0002', ifNumber: 'IF7456', cartons: 1, units: 1 },
  ])
  assert.equal(w.applicable, false)
})

test('a missing DC address is surfaced, not guessed', () => {
  const w = buildLabelWorksheet({ ...SHIP, address: null }, [
    { poNumber: '8040313', storeNumber: '0002', ifNumber: 'IF7456', cartons: 1, units: 1 },
  ])
  assert.equal(w.shipTo, null)   // the UI then asks for confirmation in red
})

test('store names are trimmed to something readable on a row', () => {
  assert.equal(shortStore("Bloomingdale's - 0231 China Grove Pool Stock/Customer/Customer Fulfillment Center"), 'China Grove')
  assert.equal(shortStore("Bloomingdale's - 0001 59th St. - New York"), '59th St. - New York')
  assert.equal(shortStore(null), null)
  // never returns empty — a blank cell would read as missing data
  assert.equal(shortStore("Bloomingdale's - 0231 "), "Bloomingdale's - 0231")
})

test('the printed line names the PO and the store together', () => {
  assert.equal(labelLine({ poNumber: '8040291', storeNumber: '0231', cartonOf: '1 of 2' }),
    'PO 8040291 · Store 0231 · carton 1 of 2')
  // a missing store is visible rather than silently omitted
  assert.match(labelLine({ poNumber: '8040291', storeNumber: null }), /Store \?/)
})
