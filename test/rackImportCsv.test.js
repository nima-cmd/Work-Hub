// test/rackImportCsv.test.js — the Nordstrom Rack customer-import CSV.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  importRow, customerId, storeNumber, externalId, dcKey, rackStoresFrom, toCsv,
  HEADERS, DCS, WAREHOUSE_297, PO_50220600_STORES,
} from '../scripts/rack-import-csv.js'

test('⚠️ TWO PADDINGS, AND THEY DIFFER ON PURPOSE — id 3, store number 4', () => {
  // The 850 for PO 50220600 sends every store code padded to four (0167, 0378). The 102
  // existing NetSuite records use a 3-padded entityid and are NAMED from it. Both are
  // honoured rather than one being bent to the other.
  assert.equal(customerId('3'), '003')
  assert.equal(storeNumber('3'), '0003')
  assert.equal(customerId('167'), '167')
  assert.equal(storeNumber('167'), '0167')
  // A genuinely 4-digit store is untouched by either.
  assert.equal(customerId('7742'), '7742')
  assert.equal(storeNumber('7742'), '7742')
})

test('⚠️ the parent is the FULL hierarchical name — an internal id fails every row', () => {
  // The first real import (11 rows, 2026-09-01) died with `Invalid parent reference key
  // "2068"` on all 11: the field resolves by NAME unless someone changes its reference
  // type, so the id was searched for as a customer name.
  const r = importRow({ store: '167', dc: '399', name: 'Cerritos Plaza Rack' })
  assert.equal(r['Parent Company'], '399 Nordstrom : Nordstrom - DC 399 - S California DC')
  // ⚠️ Pinned to the ONE form that imports. Proven by probe: store 167 landed as
  // customer 18779; the fullname and entitytitle forms were rejected outright.
  assert.match(r['Parent Company'], /^399 Nordstrom : Nordstrom - DC 399/)
})

test('the record is named from the 3-digit id, like every existing Nordstrom store', () => {
  const r = importRow({ store: '167', dc: '399', name: 'Cerritos Plaza Rack' })
  assert.equal(r['Company Name'], 'Nordstrom - 167 - Cerritos Plaza Rack')
  assert.equal(r['Customer ID'], '167')
  assert.equal(r['Store Number'], '0167')
})

test('⚠️ the workbook writes DC 89, NetSuite stores 089 — normalised, or the row orphans', () => {
  assert.equal(dcKey('89'), '089')
  assert.equal(dcKey('299'), '299')
  const r = importRow({ store: '3', dc: '89', name: 'Southcenter Square Rack' })
  assert.equal(r['DC Location'], '089')
  assert.equal(r['Parent Company'], '089 Nordstrom : Nordstrom - DC 089 - Portland DC')
})

test('every store carries its DC\'s address, not its own', () => {
  // A Nordstrom store record has NO address-book entry; the DC Address fields are the
  // only address on it. Verified against record 2179, which has zero customerAddressbook rows.
  const r = importRow({ store: '167', dc: '399', name: 'Cerritos Plaza Rack' })
  assert.equal(r['DC Address Line 1'], '1600 S Milliken Ave')
  assert.equal(r['DC Address City'], 'Ontario')
  assert.equal(r['DC Address State'], 'CA')
  assert.equal(r['DC Address Zip Code'], '91761')
  assert.equal(r['DC Address Addressee'], 'S California DC')
  assert.equal(r['DC Address Atention'], 'DC 399')
})

test('⚠️ EDI Store Number is left BLANK — the field does not hold what its name says', () => {
  // On the full-line records it holds a different real store: 220 → 0334 (Colonies
  // Crossroads Rack), 001 → 0568 (Elizabethtown FC), 020 → 0036 (Park Meadows Rack).
  for (const dc of Object.keys(DCS)) {
    assert.equal(importRow({ store: '1', dc, name: 'x' })['EDI Store Number'], '')
  }
})

test('external ids are namespaced and unique per store', () => {
  assert.equal(externalId('3'), 'NORDRACK-003')
  assert.equal(externalId('297'), 'NORDRACK-297')
  assert.equal(externalId('7742'), 'NORDRACK-7742')
})

test('297 is the CS Rack Warehouse and it hangs off DC 299', () => {
  // Nordstrom in writing (Stephanie Inzunza, 2026-08-25): "297 is our warehouse".
  const r = importRow(WAREHOUSE_297)
  assert.equal(r['Customer ID'], '297')
  assert.equal(r['Store Number'], '0297')
  assert.equal(r['Parent Company'], '299 Nordstrom : Nordstrom - DC 299 - Central States DC')
  assert.equal(r['Parent Company Internal ID (reference only)'], 2068)
  assert.equal(r['DC Location'], '299')
  assert.equal(r['DC Address Line 1'], '5050 Chavenelle Rd')
})

test('⚠️ an unknown DC throws rather than producing a parentless row', () => {
  // A store with no parent lands at the top level of the customer list, where nothing
  // routes it — worse than a failed import, because it looks like it worked.
  assert.throws(() => importRow({ store: '1', dc: '569', name: 'Elizabethtown FC' }), /not one of the six/)
})

test('only Rack rows are taken, and only ones with a numeric store number', () => {
  const rows = [
    { st: '3', dc: '89', name: 'Southcenter Square Rack' },
    { st: '1', dc: '89', name: 'Downtown Seattle' },       // full-line, already exists
    { st: 'ST #', dc: 'DC #', name: 'STORE NAME' },        // the header row
    { st: '2281', dc: '299', name: "Hunter's Square Rack (Farmington Hills, MI)" },
  ]
  assert.deepEqual(rackStoresFrom(rows).map((r) => r.store), ['3', '2281'])
})

test('a store name containing a comma survives the CSV round trip', () => {
  const csv = toCsv(HEADERS, [importRow({ store: '2281', dc: '299', name: "Hunter's Square Rack (Farmington Hills, MI)" })])
  assert.match(csv, /"Nordstrom - 2281 - Hunter's Square Rack \(Farmington Hills, MI\)"/)
})

test('the PO 50220600 shortlist is the 850\'s own SDQ codes', () => {
  // Read off the transaction, not chosen by hand: 7 stores to DC 399, 3 to DC 799.
  assert.equal(PO_50220600_STORES.length, 10)
  const dcs = { 167: '399', 351: '399', 363: '399', 370: '399', 371: '399', 372: '399', 378: '399', 7742: '799', 7760: '799', 7768: '799' }
  for (const s of PO_50220600_STORES) assert.ok(dcs[s], `${s} missing from the 850's mapping`)
})

test('every row carries all 28 columns, in a stable order', () => {
  assert.equal(HEADERS.length, 28)
  assert.equal(HEADERS[0], 'External ID')
  const r = importRow({ store: '167', dc: '399', name: 'x' })
  assert.deepEqual(Object.keys(r), HEADERS)
})
