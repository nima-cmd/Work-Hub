#!/usr/bin/env node
// scripts/rack-import-csv.js — build the NetSuite customer-import CSVs for the 325
// Nordstrom Rack stores plus 297, the CS Rack Warehouse.
//
// ⚠️ ALL 325 RACK STORES ARE MISSING FROM NETSUITE and always have been (a `%RACK%`
// search over the whole customer table returns 0, re-verified 2026-09-01). Every Rack
// 850 therefore lands with no customer to key on.
//
// ── WHERE EVERY VALUE COMES FROM, AND WHY ────────────────────────────────────
//
// Nothing here is invented. Store list and DC mapping come from Nordstrom's own
// Store_Address_List.xlsx; the constants and the DC address blocks are read out of the
// 102 existing Nordstrom store records in NetSuite, which were checked as a group and
// are genuinely uniform — one GROUP BY over all 102 returns a single row.
//
// ⚠️ STORE NUMBER IS FOUR DIGITS, ZERO-PADDED, AND THE 850 IS THE AUTHORITY.
// Nima, 2026-09-01, asked to settle this from "the edi for 50220600" rather than from
// the full-line records. Read live: every SDQ code on that 850 is a real Rack store
// number padded to four — 0167 Cerritos Plaza, 0351 Beverly Connection, 0363 Plaza
// Bonita, 0370 South Bay, 0371 Summerlin, 0372 Esplanade, 0378 Mission Valley — and
// each PO1 line's N1-ST ship-to is that store's DC, also padded to four (0399, 0799).
// The two agree on every line, so the padding is the partner's convention, not noise.
//
// ⚠️ CUSTOMER ID STAYS AT THREE, and that is deliberate divergence, not an oversight.
// All 102 existing records use a 3-padded entityid ("001", "220") and are NAMED from it
// ("Nordstrom - 220 - Michigan Avenue"). Padding the id to four would make Rack the only
// Nordstrom customer whose record name did not match its siblings. The 850's four-digit
// code lands in Store Number, where a machine reads it; the id stays human-consistent.
//
// ⚠️ EDI STORE NUMBER IS LEFT EMPTY ON PURPOSE. The field exists and is populated on 26
// of the 102 full-line records — with values that are NOT that store's number. Store 220
// carries 0334, which is Colonies Crossroads *Rack* on DC 399. Store 001 carries 0568 =
// Elizabethtown FC. Store 020 carries 0036 = Park Meadows Rack. Three for three the value
// is a different real store, so whatever that field means, copying the shape of it onto
// 326 new records would be inventing data. Work-Hub reads custentity_store_number
// (src/ingest/netsuiteSync.js), not this one.
//
// ⚠️ THE ADDRESS ON A STORE IS ITS DC'S ADDRESS, IN THE DC ADDRESS FIELDS — never a
// street address on the address sublist. Verified: the template record 2179 has ZERO
// rows in customerAddressbook, and its DC Address fields carry DC 299's address. That is
// how these records answer "where does this ship", and it is why Nordstrom's own
// workbook lists the DC's address against stores that have not opened yet.
//
// ⚠️ NO EMAIL. The full-line records all carry nordmerchinv@nordstrom.com, a Nordstrom
// merchandising mailbox. Rack is a different organisation with a different contact
// (Stephanie Inzunza), and putting a live address on 326 records is how mail reaches
// people who never asked for it. Left blank for a human to decide.

import fs from 'node:fs'
import path from 'node:path'

// ── the constants, read from the 102 existing records (all identical) ────────
const CONST = {
  'Individual': 'F',
  'Price Level': 'Wholesale Price',
  'Terms': 'Net 60',
  'Category': 'Department Store',
  'Currency': 'USA',
  'Sales Rep': 'Aviva Parise',
  'Department': 'Wholesale',
  'Shipping Method': 'LTL',
  'EDI Customer': 'T',
  'Comments': 'EDI',
  'Inactive': 'F',
}

// The six DCs: internal id to parent with, and the address block every store on that DC
// carries. Read live from NetSuite 2026-09-01, not transcribed from the workbook.
//
// ⚠️ THE PARENT REFERENCE IS `<parent entityid> <hierarchical company names>`, AND IT
// TOOK THREE ATTEMPTS AND A CONTROLLED EXPERIMENT TO ESTABLISH THAT.
//
//     399 Nordstrom : Nordstrom - DC 399 - S California DC
//
// NetSuite renders the same customer three different ways and only one of them matches
// on import. Both wrong guesses failed EVERY row, which is the useful part — a parent
// reference either resolves or the row dies, so there is no half-imported state:
//
//   internal id  `2068`                                              — FAILED (11/11).
//       The field resolves by NAME unless a person changes its reference type in the
//       mapping UI, so the id was searched for as a customer's name.
//   `fullname`   `294 Nordstrom : 399 Nordstrom - DC 399 - S Cal…`   — FAILED (11/11).
//       fullname prefixes the entityid at EVERY level; the picklist prefixes it once.
//   `entitytitle`/BUILTIN.DF `399 Nordstrom - DC 399 - S Cal…`       — FAILED (probe).
//       No hierarchy at all, so it is not a path.
//   picklist form (below)                                            — WORKS.
//       Proven by a 3-row probe carrying one format each: store 167 imported as
//       customer 18779 with the right parent; 351 and 363 were rejected. Verified
//       afterwards field by field against the template.
//
// It is `entityid + ' ' + altname`, where altname is the " : "-joined path of
// COMPANY NAMES. Both halves are read out of NetSuite, never assembled from parts —
// getting the space, the colon or the prefix wrong fails silently at import time.
export const DCS = {
  '089': { parentId: 2067, parentRef: '089 Nordstrom : Nordstrom - DC 089 - Portland DC', addressee: 'Portland DC', line1: '5703 N Marine Dr', city: 'Portland', state: 'OR', zip: '97203' },
  '299': { parentId: 2068, parentRef: '299 Nordstrom : Nordstrom - DC 299 - Central States DC', addressee: 'Central States DC', line1: '5050 Chavenelle Rd', city: 'Dubuque', state: 'IA', zip: '52002' },
  '399': { parentId: 2069, parentRef: '399 Nordstrom : Nordstrom - DC 399 - S California DC', addressee: 'S California DC', line1: '1600 S Milliken Ave', city: 'Ontario', state: 'CA', zip: '91761' },
  '499': { parentId: 2070, parentRef: '499 Nordstrom : Nordstrom - DC 499 - N California DC', addressee: 'N California DC', line1: '37599 Filbert St', city: 'Newark', state: 'CA', zip: '94560' },
  '699': { parentId: 2075, parentRef: '699 Nordstrom : Nordstrom - DC 699 - Marlboro DC', addressee: 'Marlboro DC', line1: '839 Commerce Dr', city: 'Upper Marlboro', state: 'MD', zip: '20774' },
  '799': { parentId: 2076, parentRef: '799 Nordstrom : Nordstrom - DC 799 - Gainesville DC', addressee: 'Gainesville DC', line1: '5497 NE 49th Terrace', city: 'Gainesville', state: 'FL', zip: '32609' },
}

// The workbook writes DC 89; NetSuite stores 089 on 101 of 102 records (one stray "89"
// is an existing typo). ⚠️ Normalised to the NetSuite form, so the new rows join.
export const dcKey = (raw) => String(raw ?? '').trim().padStart(3, '0')

// ⚠️ THE TWO PADDINGS ARE DIFFERENT AND BOTH ARE DELIBERATE — see the header.
export const customerId = (store) => String(store).trim().padStart(3, '0')
export const storeNumber = (store) => String(store).trim().padStart(4, '0')
export const externalId = (store) => `NORDRACK-${customerId(store)}`

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n'

/** One import row for one store. */
export function importRow({ store, dc, name }) {
  const key = dcKey(dc)
  const d = DCS[key]
  if (!d) throw new Error(`store ${store}: DC "${dc}" is not one of the six Nordstrom DCs`)
  const id = customerId(store)
  return {
    'External ID': externalId(store),
    'Customer ID': id,
    'Company Name': `Nordstrom - ${id} - ${name}`,
    // ⚠️ THE NAME, because that is what the importer resolves by default — see DCS.
    // The internal id rides in the next column for anyone who does switch the field's
    // reference type, and so a human can check the row landed on the right DC.
    'Parent Company': d.parentRef,
    'Parent Company Internal ID (reference only)': d.parentId,
    'Store Name': name,
    'Store Number': storeNumber(store),
    'EDI Store Number': '',
    'DC Location': key,
    'DC Address Addressee': d.addressee,
    'DC Address Atention': `DC ${key}`,
    'DC Address Line 1': d.line1,
    'DC Address Line 2': '',
    'DC Address City': d.city,
    'DC Address State': d.state,
    'DC Address Zip Code': d.zip,
    'Email Addressee': `Nordstrom - ${id} - ${name}`,
    ...CONST,
  }
}

export const HEADERS = Object.keys(importRow({ store: '1', dc: '299', name: 'x' }))

// ── reading Nordstrom's workbook ─────────────────────────────────────────────
// The sheet is the supplier address list Nordstrom publishes; "Store Name - Address
// List" is the only sheet carrying every store with its DC.
export function rackStoresFrom(rows) {
  const out = []
  for (const r of rows) {
    const store = String(r.st ?? '').trim()
    const name = String(r.name ?? '').trim()
    if (!store || !/^\d+$/.test(store)) continue
    if (!/rack/i.test(name)) continue
    out.push({ store, dc: String(r.dc ?? '').trim(), name })
  }
  return out
}

// The CS Rack Warehouse. ⚠️ NOT in the address sheet — it appears only on the Store-DC
// sheet, and Nordstrom confirmed it in writing (Stephanie Inzunza, 2026-08-25: "297 is
// our warehouse"), shipping to 299 Central States DC.
export const WAREHOUSE_297 = { store: '297', dc: '299', name: 'CS Rack Warehouse' }

// The stores on PO 50220600 — read off that 850's SDQ codes, not chosen by hand.
export const PO_50220600_STORES = ['167', '351', '363', '370', '371', '372', '378', '7742', '7760', '7768']

function main() {
  const [, , sheetJson, outDir] = process.argv
  if (!sheetJson || !outDir) {
    console.error('usage: node scripts/rack-import-csv.js <stores.json> <outDir>')
    console.error('  stores.json = [{st, dc, name}] extracted from Store_Address_List.xlsx')
    process.exit(2)
  }
  const rows = JSON.parse(fs.readFileSync(sheetJson, 'utf8'))
  const rack = rackStoresFrom(rows)
  const all = [WAREHOUSE_297, ...rack]

  const seen = new Set()
  for (const s of all) {
    const id = customerId(s.store)
    if (seen.has(id)) throw new Error(`duplicate customer id ${id} (store ${s.store})`)
    seen.add(id)
  }

  const needed = all.filter((s) => s.store === '297' || PO_50220600_STORES.includes(s.store))
  const missing = PO_50220600_STORES.filter((s) => !all.some((x) => x.store === s))
  if (missing.length) throw new Error(`PO 50220600 names stores absent from the sheet: ${missing.join(', ')}`)

  fs.writeFileSync(path.join(outDir, 'nordstrom-rack-NEEDED-NOW.csv'), toCsv(HEADERS, needed.map(importRow)))
  fs.writeFileSync(path.join(outDir, 'nordstrom-rack-customers.csv'), toCsv(HEADERS, all.map(importRow)))
  console.log(`NEEDED-NOW ${needed.length} rows · full ${all.length} rows · ${HEADERS.length} columns`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
