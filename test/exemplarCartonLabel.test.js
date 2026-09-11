// test/exemplarCartonLabel.test.js — built against IF7650's real cartons.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cartonLabelZpl, labelProblems, shipmentLabels, ssccCheckDigit, ssccError,
  REQUIRED, SHIP_FROM, LABEL,
} from '../src/model/exemplarCartonLabel.js'

// Carton 1 of IF7650, verbatim from NetSuite.
const carton1 = {
  sscc: '185072747098541640',
  upc: '840470893555',
  style: 'SN03011LD-MOCHA · St. Barths Petit Tote | Mocha',
  carton: 1, totalCartons: 22, units: 10, totalUnits: 311,
}
const common = {
  shipFromName: SHIP_FROM.name,
  operatingCompany: 'Saks Fifth Avenue',
  po: '8928906', department: '204', store: '0077', storeAbbrev: 'PNDC',
  dc: '0510', carrier: 'PER TMS',
}
const full = { ...common, ...carton1 }

test('⚠️ THE SSCC CHECK DIGIT IS VERIFIED HERE, NOT AT THE DC', () => {
  // The Zebra's Mode D computes the BARCODE's check character, which is a different
  // thing from the SSCC's own 18th digit being right. Both of these are live values.
  assert.equal(ssccCheckDigit('18507274709854164'), 0)
  assert.equal(ssccCheckDigit('98507274709953866'), 9)
  assert.equal(ssccError('185072747098541640'), null)
  assert.equal(ssccError('985072747099538669'), null)
  // A transposed digit is caught.
  assert.match(ssccError('185072747098541641'), /check digit is 1, should be 0/)
  assert.match(ssccError('18507274709854164'), /18 digits, got 17/)
  assert.equal(ssccCheckDigit('123'), null, 'too short returns null, never a digit')
})

test('⚠️ THE THREE §8 FIELDS SHOPBOP\'S LABEL LACKS ARE REQUIRED HERE', () => {
  // The live template this is modelled on was built for ShopBop and carries no
  // department, no store number/abbreviation and no style. Each is its own
  // chargeback at $250 minimum, so copying that layout would look right and cost
  // three fees. Named explicitly so nobody "simplifies" them back out.
  const keys = REQUIRED.map(([k]) => k)
  for (const k of ['department', 'store', 'storeAbbrev', 'style']) assert.ok(keys.includes(k), k)
})

test('⚠️ A MISSING FIELD IS REPORTED, NEVER PRINTED AS A DASH', () => {
  // [[default-is-not-an-answer]]. "DEPT: —" reads as a formatting choice and is a fee.
  const p = labelProblems({ ...full, department: '', store: null })
  assert.equal(p.printable, false)
  assert.deepEqual(p.missing.map((m) => m.field), ['department', 'store'])
  assert.match(p.missing[0].requirement, /Department number/)
  // And rendering one refuses rather than emitting a partial label.
  assert.throws(() => cartonLabelZpl({ ...full, department: '' }), /non-compliant/)
})

test('an unknown DC is an error, because the ship-to block would be a guess', () => {
  const p = labelProblems({ ...full, dc: '999' })
  assert.equal(p.printable, false)
  assert.match(p.errors.join(), /DC 999 is not in the Routing Guide/)
  // The real code resolves, zero-padded or not.
  assert.equal(labelProblems({ ...full, dc: '0510' }).printable, true)
  assert.equal(labelProblems({ ...full, dc: '510' }).printable, true)
})

test('carton 23 of 22 is caught', () => {
  assert.match(labelProblems({ ...full, carton: 23 }).errors.join(), /exceeds the total/)
})

test('the ZPL carries the GS1-128 in Mode D, with the (00) application identifier', () => {
  const z = cartonLabelZpl(full)
  // ⚠️ Mode D is what makes this a GS1-128 rather than a plain Code 128 — the
  // printer applies FNC1. Losing the ",D" yields a barcode that scans as the wrong
  // symbology and fails the DC's check.
  assert.match(z, /\^BCN,225,N,N,Y,D\^FD00185072747098541640\^FS/)
  assert.match(z, /\(00\) 185072747098541640/, 'the human-readable form is required beside it')
  assert.ok(z.startsWith('^XA'))
  assert.ok(z.trimEnd().endsWith('^XZ'))
})

test('every §8 marking actually appears in the rendered label', () => {
  const z = cartonLabelZpl(full)
  assert.match(z, /Entrelaced Holdings, LLC/)     // company name
  assert.match(z, /Saks Fifth Avenue/)            // operating company
  assert.match(z, /8928906/)                      // PO
  assert.match(z, /DEPT: 204/)                    // department
  assert.match(z, /STORE: 0077 PNDC/)             // store number + abbreviation
  assert.match(z, /CARTON 1 of 22/)               // carton n of m
  assert.match(z, /STORE TOTAL: 311 units \/ 22 ctns/)
  assert.match(z, /STYLE: SN03011LD-MOCHA/)       // style / colour
  assert.match(z, /UPC: 840470893555/)
  assert.match(z, /QTY: 10/)
})

test('the ship-to block comes from the Routing Guide DC, not from free text', () => {
  const z = cartonLabelZpl(full)
  assert.match(z, /NMG-Pinnacle Point/)
  assert.match(z, /4123 Pinnacle Point Dr/)
  assert.match(z, /Dallas, TX 75211/)
  // AI 420 postal barcode, zip pulled off the DC's own address line.
  assert.match(z, /\(420\) 75211/)
  assert.match(z, /\^BCN,110,N,N,Y,D\^FD42075211\^FS/)
})

test('⚠️ ^ AND ~ ARE STRIPPED FROM DATA — they are ZPL control characters', () => {
  // A style name containing a caret would terminate the field and corrupt every
  // command after it, producing a mangled label rather than an error.
  const z = cartonLabelZpl({ ...full, style: 'SN03011^LD~MOCHA' })
  assert.match(z, /STYLE: SN03011 LD MOCHA/)
  assert.ok(!/SN03011\^LD/.test(z))
})

test('⚠️ ONE BAD CARTON DOES NOT WITHHOLD THE OTHER 21', () => {
  // The over-receive blocking bug: a per-shipment gate meant one problem held back
  // everything that was fine. Good labels print; bad ones are named.
  const cartons = [
    carton1,
    { ...carton1, carton: 2, sscc: '285072747098813614', upc: '840470800560' },
    { ...carton1, carton: 3, sscc: '385072747099088858', department: '' }, // bad
  ]
  const r = shipmentLabels(cartons, common)
  assert.equal(r.ready, 2)
  assert.equal(r.total, 3)
  assert.equal(r.blocked.length, 1)
  assert.equal(r.blocked[0].carton, 3)
  assert.deepEqual(r.blocked[0].missing.map((m) => m.field), ['department'])
  assert.ok(r.labels.every((l) => l.zpl.includes('^XZ')))
})

test('4x6 at 203 dpi — the stock the warehouse Zebra is loaded with', () => {
  assert.equal(LABEL.widthDots, 812)
  assert.equal(LABEL.heightDots, 1218)
  assert.equal(Math.round(LABEL.widthDots / LABEL.dpi), 4)
  assert.equal(Math.round(LABEL.heightDots / LABEL.dpi), 6)
})
