// server/exemplarDocsPdf.js — the carton label and the packing slip, as PDFs.
//
// Nima, 2026-09-11: "are we able to generate the packing slip and the carton labels.
// one note we have two version of label paper one is half a sheet and then we also
// ahve our 3x6 which would make things small i think thought wed have to inspect."
//
// ── ⚠️ HIS WORRY ABOUT THE 3x6 IS MEASURABLE, AND HE WAS HALF RIGHT ─────────
//
// An SSCC GS1-128 is 231 modules wide with its quiet zones. Divide the usable width
// by 231 and you get the X-dimension, which is what decides whether a DC's scanner
// reads it. GS1 puts the floor at 7.5 mil, and 9.8 mil for a symbol scanned in
// motion on a conveyor — and this PO is XDOCK, so conveyor is the case that matters.
//
//   half sheet 5.5"  0.5" margins   19.5 mil   conveyor OK
//   3 x 6            0.5" margins    8.7 mil   scannable by hand, UNDER conveyor spec
//   3 x 6            0.25" margins  10.8 mil   conveyor OK
//
// So the 3x6 works, but only if the side margins come in to a quarter inch. At the
// half inch a label template would normally use, it drops below the conveyor
// recommendation — readable in the hand, marginal on a moving belt. That is exactly
// the "would make things small" he suspected, and it is a margin problem rather than
// a paper problem. LAYOUTS below encode the margin as part of the size.
//
// ⚠️ The check runs at render time, not just here: renderCartonLabel throws if the
// geometry puts the symbol under the floor, so a future layout tweak cannot quietly
// shrink the barcode.

import PDFDocument from 'pdfkit'
import { gs1BarcodePng, code128Png, xDimensionFor, X_MIN_IN, MUST_TEST_SCAN } from '../src/model/code128.js'
import { labelProblems, SHIP_FROM } from '../src/model/exemplarCartonLabel.js'
import { DCS, dcAddressLines } from '../src/model/exemplarStores.js'

const PT = 72

/**
 * ⚠️ THE MARGIN IS PART OF THE SIZE, not a style choice. See the header: on the 3x6
 * a half-inch margin drops the barcode below the conveyor spec.
 */
export const LAYOUTS = {
  'half-sheet': { w: 5.5 * PT, h: 8.5 * PT, margin: 0.5 * PT, label: 'Half sheet 5.5 x 8.5' },
  '3x6': { w: 3 * PT, h: 6 * PT, margin: 0.25 * PT, label: '3 x 6' },
  '4x6': { w: 4 * PT, h: 6 * PT, margin: 0.3125 * PT, label: '4 x 6' },
}

const line = (doc, x, y, w) => doc.moveTo(x, y).lineTo(x + w, y).stroke()

/**
 * Draw text on ONE line, shrinking the font until it fits.
 *
 * ⚠️ WRAPPING IS THE WRONG FAILURE FOR A LABEL FIELD. Bounding the width stopped
 * "0077 PNDC" overprinting the vendor number, but it then wrapped to a second line
 * and pushed into the box below. A field with a fixed box wants to get smaller, not
 * taller — and a label that silently relayouts is one a picker misreads.
 */
function fitText(doc, text, x, y, width, { size = 12, min = 5.5, font = 'Helvetica-Bold' } = {}) {
  let s = size
  doc.font(font)
  while (s > min && doc.fontSize(s).widthOfString(String(text)) > width) s -= 0.5
  doc.fontSize(s).text(String(text), x, y, { width, lineBreak: false, ellipsis: true })
  return s
}

/** One carton label. Returns the doc so the caller can add pages or pipe it. */
export async function renderCartonLabel(doc, carton, layout = LAYOUTS['half-sheet']) {
  const p = labelProblems(carton)
  if (!p.printable) {
    throw new Error(`refusing to render a non-compliant carton label: ${
      [...p.missing.map((m) => `missing ${m.field}`), ...p.errors].join('; ')}`)
  }
  const { w, h, margin: M } = layout
  const inner = w - M * 2

  // ⚠️ Geometry is checked BEFORE anything is drawn, so a layout change cannot
  // silently shrink the symbol under the readable floor.
  const x = xDimensionFor(inner / PT)
  if (!x.meetsMinimum) {
    throw new Error(`${layout.label}: usable width ${(inner / PT).toFixed(2)}in gives ${x.mils} mil, under the ${X_MIN_IN * 1000} mil floor — the barcode will not read`)
  }

  const dc = DCS[String(carton.dc).replace(/^0+/, '')]
  const addr = dcAddressLines(carton.dc)
  let y = M

  // ── FROM / TO ──
  doc.lineWidth(1).rect(M, y, inner, 92).stroke()
  // ⚠️ EVERY text() IS WIDTH-BOUNDED. Without a width pdfkit runs to the page edge,
  // so on the 3x6 "Entrelaced Holdings, LLC" printed straight through the centre
  // rule and over "Saks Fifth Avenue". It looked fine on the wider half sheet, which
  // is how a layout bug hides until the narrow stock is used.
  const colW = inner / 2 - 10
  doc.fontSize(6).font('Helvetica').text('SHIP FROM', M + 5, y + 5, { width: colW })
  doc.fontSize(8).font('Helvetica-Bold').text(SHIP_FROM.name, M + 5, y + 15, { width: colW })
  doc.font('Helvetica').fontSize(7.5)
    .text([...SHIP_FROM.lines, `${SHIP_FROM.city}, ${SHIP_FROM.state} ${SHIP_FROM.zip}`].join('\n'), M + 5, y + 33, { width: colW })
  const half = M + inner / 2
  doc.moveTo(half, y).lineTo(half, y + 92).stroke()
  doc.fontSize(6).font('Helvetica').text('SHIP TO', half + 5, y + 5, { width: colW })
  doc.fontSize(9).font('Helvetica-Bold').text(carton.operatingCompany, half + 5, y + 15, { width: colW })
  doc.fontSize(8).text(dc.name, half + 5, y + 36, { width: colW })
  doc.font('Helvetica').fontSize(7.5).text(addr.join('\n'), half + 5, y + 47, { width: colW })
  y += 92

  // ── PO / DEPT / STORE — the three §8 markings ShopBop's template omits ──
  doc.rect(M, y, inner, 74).stroke()
  doc.fontSize(6).font('Helvetica').text('PURCHASE ORDER', M + 5, y + 5)
  fitText(doc, carton.po, M + 5, y + 14, inner - 10, { size: 15 })
  // ⚠️ THREE FIELDS ACROSS, SIZED FROM THE LABEL not from fixed offsets. At M+70 the
  // store ran into the vendor number on the 3x6 — the same class of bug as above.
  const fieldW = inner / 3
  const field = (i, label, value, size) => {
    const fx = M + 5 + i * fieldW
    doc.fontSize(6).font('Helvetica').text(label, fx, y + 36, { width: fieldW - 6 })
    fitText(doc, value, fx, y + 45, fieldW - 6, { size })
  }
  field(0, 'DEPT', carton.department, 12)
  field(1, 'STORE', `${carton.store} ${carton.storeAbbrev}`, 12)
  if (carton.vendorNumber) field(2, 'VENDOR', carton.vendorNumber, 10)
  y += 74

  // ── CONTENTS ──
  doc.rect(M, y, inner, 78).stroke()
  doc.fontSize(6).font('Helvetica').text('STYLE / COLOUR / SIZE', M + 5, y + 5)
  doc.fontSize(9).font('Helvetica-Bold').text(String(carton.style), M + 5, y + 14, { width: inner - 10, height: 26, ellipsis: true })
  doc.fontSize(6).font('Helvetica').text('UPC', M + 5, y + 40)
  doc.fontSize(10).font('Helvetica-Bold').text(String(carton.upc), M + 5, y + 49)
  doc.fontSize(6).font('Helvetica').text('QTY', M + inner / 2, y + 40)
  doc.fontSize(14).font('Helvetica-Bold').text(String(carton.units), M + inner / 2, y + 48)
  doc.fontSize(7).font('Helvetica')
    .text(`STORE TOTAL  ${carton.totalUnits} units / ${carton.totalCartons} cartons`, M + 5, y + 66)
  y += 78

  doc.fontSize(16).font('Helvetica-Bold')
    .text(`CARTON ${carton.carton} OF ${carton.totalCartons}`, M, y + 6, { width: inner, align: 'center' })
  y += 30

  // ── SSCC-18 ──
  // ⚠️ The human-readable (00) line is part of the GS1-128, not decoration: it is
  // what a receiver keys when the symbol will not scan.
  doc.rect(M, y, inner, h - y - M).stroke()
  doc.fontSize(6).font('Helvetica').text('SSCC-18', M + 5, y + 5)
  const png = await gs1BarcodePng('00', carton.sscc, { scale: 4, height: 16 })
  const bcW = inner - 20
  doc.image(png, M + 10, y + 16, { width: bcW })
  const bcH = 58
  // Centre the human-readable line, shrinking it rather than letting it wrap.
  const hrSize = (() => { let s2 = 11; doc.font('Helvetica-Bold')
    while (s2 > 6 && doc.fontSize(s2).widthOfString(`(00) ${carton.sscc}`) > inner - 10) s2 -= 0.5
    return s2 })()
  doc.fontSize(hrSize).font('Helvetica-Bold')
    .text(`(00) ${carton.sscc}`, M, y + 16 + bcH + 6, { width: inner, align: 'center', lineBreak: false })
  return doc
}

/** Every carton, one per page. */
export async function cartonLabelsPdf(cartons, size = 'half-sheet') {
  const layout = LAYOUTS[size]
  if (!layout) throw new Error(`unknown label size "${size}" — have ${Object.keys(LAYOUTS).join(', ')}`)
  const doc = new PDFDocument({ size: [layout.w, layout.h], margin: 0, autoFirstPage: false })
  for (const c of cartons) {
    doc.addPage({ size: [layout.w, layout.h], margin: 0 })
    await renderCartonLabel(doc, c, layout)
  }
  return doc
}

/**
 * The packing slip — §8.5 / §12.4, $250.
 *
 * ⚠️ ONE PER PO PER STORE, AND IT GOES OUT TWICE. The Manual requires it emailed IN
 * ADVANCE and in a removable pouch on the carton, with "PACKING SLIP ATTACHED" on
 * all six sides, and for a non-trailer shipment a copy of the UNSIGNED BOL in the
 * same pouch. Printing it is the easy half; the instructions are on the sheet so the
 * other half is not forgotten.
 *
 * ⚠️ NO GS1-128 ON A PACKING SLIP. It carries a plain Code 128 of the PO for
 * convenience — putting an SSCC here would give a receiver two things that look like
 * the carton's identity.
 */
export async function packingSlipPdf(shipment) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 })
  const W = 612 - 80
  const dc = DCS[String(shipment.dc).replace(/^0+/, '')]

  doc.fontSize(17).font('Helvetica-Bold').text('PACKING SLIP', { align: 'left' })
  doc.fontSize(8).font('Helvetica').fillColor('#555')
    .text(`${shipment.operatingCompany}  ·  PO ${shipment.po}  ·  Dept ${shipment.department}  ·  Store ${shipment.store} ${shipment.storeAbbrev}`)
  doc.fillColor('black').moveDown(0.6)

  const top = doc.y
  doc.fontSize(7).font('Helvetica').text('SHIP FROM', 40, top)
  doc.fontSize(9).font('Helvetica-Bold').text(SHIP_FROM.name, 40, top + 10)
  doc.font('Helvetica').fontSize(8.5)
    .text([...SHIP_FROM.lines, `${SHIP_FROM.city}, ${SHIP_FROM.state} ${SHIP_FROM.zip}`].join('\n'), 40, top + 22)
  doc.fontSize(7).font('Helvetica').text('SHIP TO', 320, top)
  doc.fontSize(9).font('Helvetica-Bold').text(`${shipment.operatingCompany} — ${dc.name}`, 320, top + 10)
  doc.font('Helvetica').fontSize(8.5).text(dcAddressLines(shipment.dc).join('\n'), 320, top + 22)
  doc.y = top + 66

  if (shipment.vendorNumber) {
    doc.fontSize(8).font('Helvetica').text(`Vendor ${shipment.vendorNumber}    Cartons ${shipment.totalCartons}    Units ${shipment.totalUnits}`, 40, doc.y)
  }
  doc.moveDown(0.5)
  const poPng = await code128Png(String(shipment.po).replace(/\D/g, ''), { scale: 2, height: 8 })
  doc.image(poPng, 40, doc.y, { width: 150 })
  doc.y += 34
  line(doc, 40, doc.y, W); doc.moveDown(0.4)

  // ── Lines, one per carton, in carton order ──
  const cols = [40, 78, 190, 380, 452, 500]
  doc.fontSize(7.5).font('Helvetica-Bold')
  const hy = doc.y
  ;['CTN', 'STYLE', 'DESCRIPTION', 'UPC', 'QTY', 'SSCC'].forEach((h, i) => doc.text(h, cols[i], hy))
  doc.y = hy + 12
  line(doc, 40, doc.y - 3, W)

  doc.font('Helvetica').fontSize(7)
  for (const c of shipment.cartons) {
    const y = doc.y
    if (y > 700) { doc.addPage(); doc.y = 40 }
    const [sku, ...rest] = String(c.style).split('|').map((s) => s.trim())
    doc.text(String(c.carton), cols[0], doc.y)
    doc.text(sku, cols[1], y, { width: 108 })
    doc.text(rest.join(' | '), cols[2], y, { width: 185 })
    doc.text(String(c.upc), cols[3], y)
    doc.text(String(c.units), cols[4], y)
    doc.fontSize(6).text(String(c.sscc), cols[5], y + 0.5).fontSize(7)
    doc.y = y + 12
  }
  line(doc, 40, doc.y + 2, W)
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(9)
    .text(`TOTAL   ${shipment.totalCartons} cartons   ${shipment.totalUnits} units`, 40, doc.y)

  // ── ⚠️ The half of §8.5 that is not printing ──
  doc.moveDown(1)
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a6d00').text('REQUIRED HANDLING — Manual §8.5 / §12.4 ($250)')
  doc.font('Helvetica').fontSize(7.5).fillColor('black')
  for (const l of [
    'Email this slip to Exemplar IN ADVANCE of the shipment — one per PO per store.',
    'Put a copy in a REMOVABLE POUCH on the carton, with the UNSIGNED BOL (non-trailer shipments).',
    'Mark "PACKING SLIP ATTACHED" on ALL SIX SIDES of that carton.',
    'Parcel (FedEx/UPS) instead of freight: a slip goes on EVERY carton, not just one.',
  ]) doc.text('•  ' + l, { indent: 4 })
  doc.moveDown(0.4)
  doc.fontSize(7).fillColor('#555').text(MUST_TEST_SCAN)
  doc.fillColor('black')
  return doc
}
