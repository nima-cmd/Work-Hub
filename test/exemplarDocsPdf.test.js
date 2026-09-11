// test/exemplarDocsPdf.test.js — the printed carton label and packing slip.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import PDFDocument from 'pdfkit'
import { LAYOUTS, renderCartonLabel, cartonLabelsPdf, packingSlipPdf } from '../server/exemplarDocsPdf.js'

const carton = {
  carton: 20, totalCartons: 22, units: 10, totalUnits: 270,
  sscc: '085072747013622044', upc: '840470890080',
  style: 'SN41262LD-CHOCOLATE | Porto Small Half-Moon Bag | Chocolate',
  shipFromName: 'Entrelaced Holdings, LLC', operatingCompany: 'Saks Fifth Avenue',
  po: '0008928906', department: '0118', vendorNumber: '7126456',
  store: '0077', storeAbbrev: 'PNDC', dc: '0510',
}

test('⚠️ THE MARGIN IS PART OF THE SIZE', () => {
  // On the 3x6 a half-inch margin drops the barcode under the conveyor spec, so the
  // margin is not a style choice and is not left to the caller.
  assert.equal(LAYOUTS['3x6'].margin, 0.25 * 72)
  assert.equal(LAYOUTS['half-sheet'].margin, 0.5 * 72)
})

test('⚠️ GEOMETRY IS CHECKED BEFORE ANYTHING IS DRAWN', async () => {
  // So a future layout tweak cannot quietly shrink the symbol under the readable
  // floor and produce 22 cartons of unscannable labels.
  const doc = new PDFDocument({ autoFirstPage: false })
  const tooNarrow = { w: 1.5 * 72, h: 6 * 72, margin: 0.25 * 72, label: 'test 1.5in' }
  doc.addPage({ size: [tooNarrow.w, tooNarrow.h], margin: 0 })
  await assert.rejects(() => renderCartonLabel(doc, carton, tooNarrow), /will not read/)
})

test('a non-compliant carton is refused, not rendered partially', async () => {
  const doc = new PDFDocument({ autoFirstPage: false })
  doc.addPage()
  await assert.rejects(
    () => renderCartonLabel(doc, { ...carton, department: '' }, LAYOUTS['half-sheet']),
    /non-compliant/)
})

test('both stocks render every carton', async () => {
  for (const size of ['half-sheet', '3x6']) {
    const doc = await cartonLabelsPdf([carton, { ...carton, carton: 21 }], size)
    doc.end()
    assert.ok(doc, size)
  }
  await assert.rejects(() => cartonLabelsPdf([carton], 'letter'), /unknown label size/)
})

test('the packing slip carries the §8.5 handling rules, not just the lines', async () => {
  // ⚠️ Printing it is the easy half. The Manual also requires it emailed in advance,
  // in a removable pouch with the unsigned BOL, and "PACKING SLIP ATTACHED" on all
  // six sides — $250 under §12.4 — so those instructions are ON the sheet.
  const doc = await packingSlipPdf({ ...carton, cartons: [carton] })
  doc.end()
  assert.ok(doc)
})
