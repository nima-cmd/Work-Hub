import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLabelWorksheet, labelLine, worksheetCsv, CSV_COLUMNS } from '../src/model/labelWorksheet.js'
import { parcelBilling } from '../src/model/bolAddresses.js'

// Nima, 2026-08-05: "i dont need the name and the carton count i do need how each
// carton in the shipment its weight and dimension. If this is something we can make
// as an export to import into UPS let me know."
//
// A DC-direct shipment has ONE address and many stores, so PO + store is what
// distinguishes the labels; weight and dimensions are what the carrier needs.

// Built through parcelBilling, the real path — so the fixture cannot pass values the
// app would never resolve.
const SHIP = {
  bolNumber: 'NB1731256', dc: 'CG', carrier: 'UPS GRND', shipDirect: true,
  billing: parcelBilling({ partner: "Bloomingdale's", carrier: 'UPS GRND' }),
  address: { name: "Macy's CFC China Grove DC", street: '1305 Liberty Ridge Rd', city: 'China Grove', state: 'NC', zip: '28023' },
}
const IF7469 = {
  poNumber: '8040291', storeNumber: '0231', ifNumber: 'IF7469',
  cartons: [
    { cartonNo: '1', weightLb: 44, lengthIn: 24, widthIn: 16, heightIn: 17, boxName: '24x16x17', ucc: '00000185961413' },
    { cartonNo: '2', weightLb: 47, lengthIn: 24, widthIn: 16, heightIn: 17, boxName: '24x16x17', ucc: '00000186280787' },
  ],
}

test('each carton carries its OWN weight, never a divided total', () => {
  const w = buildLabelWorksheet(SHIP, [IF7469])
  assert.equal(w.cartons, 2)
  // ⚠️ THE REASON PER-CARTON DETAIL MATTERS. These two boxes are the SAME type and
  // weigh 44lb and 47lb — real live values. An average (45.5) would be wrong on
  // both, and a wrong weight on a carrier label gets rebilled.
  assert.equal(w.lines[0].weightLb, 44)
  assert.equal(w.lines[1].weightLb, 47)
  assert.equal(w.totalWeightLb, 91)   // a cross-check against the BOL, not label input
})

test('dimensions come through per carton, formatted for a label', () => {
  const w = buildLabelWorksheet(SHIP, [IF7469])
  assert.equal(w.lines[0].dims, '24x16x17')
  assert.equal(w.lines[0].lengthIn, 24)
  assert.equal(w.lines[0].heightIn, 17)
})

test('a carton with no dimensional box name reports the gap, never a zero', () => {
  // A zero dimension on a carrier label is a rejected shipment, not a small box.
  const w = buildLabelWorksheet(SHIP, [{
    poNumber: '8040313', storeNumber: '0002', ifNumber: 'IF7456',
    cartons: [{ cartonNo: '1', weightLb: 5, lengthIn: null, widthIn: null, heightIn: null, boxName: 'MAILER' }],
  }])
  assert.equal(w.lines[0].dims, null)
  assert.equal(w.lines[0].lengthIn, null)
  assert.equal(w.incomplete, 1)   // surfaced, so it can be fixed before printing
})

test('a fulfilment with no carton rows still gets a line', () => {
  // The box exists physically whether or not the feed has caught up; a missing line
  // is how a carton ships unlabelled.
  const w = buildLabelWorksheet(SHIP, [{ poNumber: '8040313', storeNumber: '0002', ifNumber: 'IF7456', cartons: [] }])
  assert.equal(w.cartons, 1)
  assert.equal(w.lines[0].missing, true)
  assert.equal(w.incomplete, 1)
})

test('freight shipments get no parcel worksheet, and say so', () => {
  // Freight moves on the BOL — a per-carton parcel sheet is meaningless, and an
  // empty list would look like missing data instead of a different lane.
  assert.equal(buildLabelWorksheet({ ...SHIP, shipDirect: false }, [IF7469]).applicable, false)
})

test('the label reference is the PO and the store', () => {
  assert.equal(labelLine({ poNumber: '8040291', storeNumber: '0231' }), 'PO 8040291 · Store 0231')
  assert.match(labelLine({ poNumber: '8040291', storeNumber: null }), /Store \?/)
})

// ── the CSV export ──────────────────────────────────────────────────────────
test('the CSV is one row per carton with the address and billing repeated', () => {
  const w = buildLabelWorksheet(SHIP, [IF7469])
  const csv = worksheetCsv([w])
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.equal(lines.length, 3)                       // header + 2 cartons

  const first = lines[1].split(',')
  assert.equal(first[0], '8040291')                   // Reference1_PO
  assert.equal(first[1], '0231')                      // Reference2_Store
  assert.equal(first[8], '44')                        // Weight_Lb — this carton's
  assert.equal(lines[2].split(',')[8], '47')          // ...and the other's
  assert.ok(lines[1].includes('Third Party Bill'))
  assert.ok(lines[1].includes('5R12Y0'))
  // ⚠️ UPS validates a third-party account against its postal code; without it the
  // import is rejected or silently bills the shipper — i.e. us, for Macy's freight.
  assert.ok(lines[1].includes('30083'))
  // Carrier and Service are separate: "UPS GRND" is not a service level.
  assert.ok(lines[1].includes('Ground'))
})

// ── the standing rules (Nima, 2026-08-05) ───────────────────────────────────
// "For Bloomingdales its always ground the account number is 5R12Y0 and the zip code
// is 30083 for fedex its also always ground letting us select collect"
test("Bloomingdale's UPS defaults to third-party billing with the zip", () => {
  const b = parcelBilling({ partner: "Bloomingdale's", carrier: 'UPS GRND' })
  assert.equal(b.service, 'Ground')
  assert.equal(b.terms, 'Third Party Bill')
  assert.equal(b.account, '5R12Y0')
  assert.equal(b.accountZip, '30083')
  assert.equal(b.fromRule, true)   // nothing was typed; the rule supplied it
})

test("Bloomingdale's FedEx is collect on our own account, with no third-party zip", () => {
  const b = parcelBilling({ partner: "Bloomingdale's", carrier: 'FEDEX GROUND- PARCEL-COLLECT (FDEG)' })
  assert.equal(b.service, 'Ground')
  assert.equal(b.terms, 'Collect')
  assert.equal(b.account, null)
  assert.equal(b.accountZip, null)   // never inherits Macy's zip
})

test('a stored value overrides the rule, and never borrows the rule\'s zip', () => {
  // Recording an exception must not be silently overwritten by the standing rule...
  const b = parcelBilling({ partner: "Bloomingdale's", carrier: 'UPS GRND', billToAccount: 'C6J610' })
  assert.equal(b.account, 'C6J610')
  // ...and a DIFFERENT account must not inherit 30083, which belongs to Macy's.
  // Pairing an account with the wrong postal code is how third-party billing
  // silently falls back to billing the shipper.
  assert.equal(b.accountZip, null)
})

test('a partner with no stated parcel rule gets nothing invented', () => {
  const b = parcelBilling({ partner: 'Nordstrom', carrier: 'UPS GRND' })
  assert.equal(b.terms, null)
  assert.equal(b.account, null)
  assert.equal(b.service, null)
})

test('the CSV quotes fields containing commas', () => {
  // "City of Industry, CA" style values would otherwise shift every later column.
  const w = buildLabelWorksheet(
    { ...SHIP, address: { name: 'DC, Main', street: '1 A St', city: 'X', state: 'CA', zip: '9' } },
    [{ poNumber: 'P1', storeNumber: '01', ifNumber: 'IF1', cartons: [{ cartonNo: '1', weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1 }] }],
  )
  assert.match(worksheetCsv([w]), /"DC, Main"/)
})

test('a freight sheet contributes no CSV rows', () => {
  const freight = buildLabelWorksheet({ ...SHIP, shipDirect: false }, [IF7469])
  assert.equal(worksheetCsv([freight]).trim(), CSV_COLUMNS.join(','))   // header only
})
