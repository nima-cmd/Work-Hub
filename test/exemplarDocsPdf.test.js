// test/exemplarDocsPdf.test.js — the printed carton label and packing slip.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import PDFDocument from 'pdfkit'
import {
  LAYOUTS, renderCartonLabel, cartonLabelsPdf, packingSlipPdf, PACKING_SLIP_HANDLING,
} from '../server/exemplarDocsPdf.js'

const carton = {
  carton: 20, totalCartons: 22, units: 10, totalUnits: 270,
  sscc: '085072747013622044', upc: '840470890080',
  style: 'SN41262LD-CHOCOLATE | Porto Small Half-Moon Bag | Chocolate',
  // ⚠️ The STOREFRONT, not Orderful's trading-partner name — same correction as the
  // label fixture. Store 0077 is SAKS GLOBAL, renamed EXEMPLAR LUXURY GROUP on 9/21.
  shipFromName: 'Entrelaced Holdings, LLC', operatingCompany: 'EXEMPLAR LUXURY GROUP',
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

test('⚠️ THE HANDLING RULES ARE EXPORTED, NOT PRINTED ON THE CUSTOMER SHEET', async () => {
  // They used to print on the slip. A packing slip is a CUSTOMER document, and that
  // block quoted Exemplar's own section numbers and fee amount back at them while
  // telling the receiver we needed reminding how to attach it. The instructions still
  // matter, so they come back as data for the app to show.
  assert.equal(PACKING_SLIP_HANDLING.length, 4)
  assert.ok(PACKING_SLIP_HANDLING.some((h) => /IN ADVANCE/.test(h)))
  assert.ok(PACKING_SLIP_HANDLING.some((h) => /ALL SIX SIDES/.test(h)))
  const doc = await packingSlipPdf({ ...carton, cartons: [carton] }, { on: '2026-09-21' })
  doc.end()
  assert.ok(doc)
})

test('⚠️ THE TWO DOCUMENTS CANNOT NAME DIFFERENT COMPANIES', () => {
  // The labels derived the ship-to from storefrontFor(); the packing-slip script had
  // "Saks Fifth Avenue" typed in, so the slip and the labels for one shipment named
  // different consignees. Two documents in one pouch disagreeing is what a receiver
  // raises a discrepancy on, so this throws rather than printing the mismatch.
  return assert.rejects(
    () => packingSlipPdf({ ...carton, operatingCompany: 'Saks Fifth Avenue', cartons: [carton] }, { on: '2026-09-21' }),
    /storefront on 2026-09-21 is "EXEMPLAR LUXURY GROUP"/)
})

test('⚠️ AND THE STOREFRONT IS DATE-DRIVEN, SO THE DATE MATTERS', () => {
  // Before 2026-09-21 store 0077's storefront is still SAKS GLOBAL. Shipping on the
  // 11th with EXEMPLAR LUXURY GROUP on the paperwork is a real question, not a
  // formatting one — the guard makes it impossible to pass silently either way.
  return assert.rejects(
    () => packingSlipPdf({ ...carton, cartons: [carton] }, { on: '2026-09-11' }),
    /storefront on 2026-09-11 is "SAKS GLOBAL"/)
})
