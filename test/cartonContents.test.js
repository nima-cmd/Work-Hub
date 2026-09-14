// test/cartonContents.test.js — the field that blocked both Exemplar documents.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCartonContents, lookupKeys, isUpc, isItemId } from '../src/model/cartonContents.js'

const ITEMS = [
  { upc: '840470893555', itemid: 'SN03011LD-MOCHA', displayname: 'St. Barths Petit Tote | Mocha' },
  { upc: '810077100000', itemid: 'SN82014BD-ATLANTIC', displayname: 'Porto Bag | Atlantic' },
]
const ctn = (n, contents) => ({ carton: n, units: 10, sscc: '0'.repeat(18), contents })

test('a UPC resolves to the style the label and slip need', () => {
  const r = resolveCartonContents([ctn(1, '840470893555')], ITEMS)
  assert.equal(r.printable, true)
  assert.equal(r.cartons[0].style, 'SN03011LD-MOCHA | St. Barths Petit Tote | Mocha')
  assert.equal(r.cartons[0].upc, '840470893555')
})

test('an item id is already a style, and its UPC is filled in for the slip', () => {
  // 17 of 3,761 carton records hold an itemid rather than a UPC.
  const r = resolveCartonContents([ctn(1, 'SN82014BD-ATLANTIC')], ITEMS)
  assert.equal(r.printable, true)
  assert.equal(r.cartons[0].style, 'SN82014BD-ATLANTIC | Porto Bag | Atlantic')
  assert.equal(r.cartons[0].upc, '810077100000')
})

test('⚠️ "Mixed SKUs" IS A REAL CASE AND IT IS NOT A STYLE — 779 of 3,761 cartons', () => {
  // §8.5 wants style/colour/size on every carton; our extraction does not say what
  // Exemplar wants when one holds several. That is a question for them, not something
  // to answer by printing the word "MIXED".
  const r = resolveCartonContents([ctn(1, 'Mixed SKUs')], ITEMS)
  assert.equal(r.printable, false)
  assert.equal(r.problems[0].kind, 'mixed')
  assert.equal(r.cartons[0].style, null)
})

test('⚠️ NULL CONTENTS IS THE COMMONEST SHAPE — 2,459 of 3,761 — and it is not blank-able', () => {
  const r = resolveCartonContents([ctn(1, null)], ITEMS)
  assert.equal(r.printable, false)
  assert.equal(r.problems[0].kind, 'unrecorded')
})

test('a UPC NetSuite does not know is reported, never guessed', () => {
  const r = resolveCartonContents([ctn(1, '999999999999')], ITEMS)
  assert.equal(r.problems[0].kind, 'unknown-upc')
  assert.match(r.problems[0].why, /999999999999/)
})

test('⚠️ ALL OR NOTHING PER SHIPMENT — 20 printable of 22 is two unlabelled cartons', () => {
  // Easier to miss on a pallet than a wrong label, and the same fee.
  const r = resolveCartonContents([ctn(1, '840470893555'), ctn(2, null)], ITEMS)
  assert.equal(r.printable, false)
  assert.equal(r.cartons[0].style, 'SN03011LD-MOCHA | St. Barths Petit Tote | Mocha')
})

test('lookupKeys asks about only what can be looked up', () => {
  const k = lookupKeys([ctn(1, '840470893555'), ctn(2, 'Mixed SKUs'), ctn(3, null), ctn(4, 'SN82014BD-ATLANTIC')])
  assert.deepEqual(k.upcs, ['840470893555'])
  assert.deepEqual(k.itemIds, ['SN82014BD-ATLANTIC'])
})

test('the shape tests do not overlap', () => {
  assert.ok(isUpc('840470893555') && !isItemId('840470893555'))
  assert.ok(isItemId('SN82014BD-ATLANTIC') && !isUpc('SN82014BD-ATLANTIC'))
  assert.ok(!isUpc('Mixed SKUs') && !isItemId('Mixed SKUs'))
})
