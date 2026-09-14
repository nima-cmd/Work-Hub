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
import { gs1BarcodePng, code128Png, xDimensionFor, X_MIN_IN, BAR_HEIGHT_MIN_IN } from '../src/model/code128.js'
import { labelProblems, SHIP_FROM } from '../src/model/exemplarCartonLabel.js'
import { DCS, dcAddressLines, consigneeCompany } from '../src/model/exemplarStores.js'

/**
 * ⚠️ THE SHIP-TO COMPANY MUST MATCH THE STORE'S STOREFRONT.
 *
 * The carton labels derive it from storefrontFor(); the packing-slip script still had
 * "Saks Fifth Avenue" typed in, so the two documents for the same shipment named
 * different companies. Nima caught it: "i think packing slip needs Exemplar Luxury
 * group instead of Saks Fifth Aveneu as ship to".
 *
 * "Saks Fifth Avenue" is Orderful's TRADING PARTNER name. Store 0077's STOREFRONT is
 * "SAKS GLOBAL", renamed "EXEMPLAR LUXURY GROUP" effective 2026-09-21. So this throws
 * rather than printing a mismatch — two documents in one pouch disagreeing about the
 * consignee is exactly the kind of thing a receiver raises a discrepancy on.
 */
function checkStorefront(shipment, on) {
  // ⚠️ THE AUTHORITY IS THE COMPANY, NOT THE EDI STOREFRONT. This compared against
  // storefrontFor(), which is the REF(19)/MTX segment value and flips on 2026-09-21 —
  // so it enforced "SAKS GLOBAL" onto printed paper for a customer NetSuite had
  // already renamed Exemplar Luxury Group on 2026-09-04. The GUARD is still the point
  // (two documents in one pouch must not name different companies); only what it
  // checks against has changed.
  void on
  const want = consigneeCompany()
  if (!want || !shipment.operatingCompany) return
  if (String(shipment.operatingCompany).toUpperCase() !== String(want).toUpperCase()) {
    throw new Error(`ship-to says "${shipment.operatingCompany}" but the consignee company is "${want}"`)
  }
}

const PT = 72

/**
 * ⚠️ THE MARGIN IS PART OF THE SIZE, not a style choice. See the header: on the 3x6
 * a half-inch margin drops the barcode below the conveyor spec.
 */
export const LAYOUTS = {
  // Half sheet keeps its half inch: it is LASER stock and a laser cannot print to the edge.
  'half-sheet': { w: 5.5 * PT, h: 8.5 * PT, margin: 0.5 * PT, label: 'Half sheet 5.5 x 8.5' },
  '3x6': { w: 3 * PT, h: 6 * PT, margin: 0.25 * PT, label: '3 x 6' },
  // ⚠️ 0.15in, NOT 0.3125in. Nima on the first 4x6 cut: "we have space both up top at
  // the bottom and to the rright and left". Five-sixteenths of an inch on each side of
  // a 4in label throws away 16% of the width — and width is what sets the barcode's
  // X-dimension. A thermal printer will go closer to the edge than a laser.
  '4x6': { w: 4 * PT, h: 6 * PT, margin: 0.15 * PT, label: '4 x 6' },
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
/**
 * ⚠️ THE GEOMETRY IS PROPORTIONAL, AND IT USED TO BE ABSOLUTE. Every block was a fixed
 * point height — 92, 74, 78, 30 — written for the 5.5x8.5 half sheet and reused
 * unchanged on every stock. Nima, 2026-09-14, on the 4x6: "you made them 4x6 but were
 * no utiziling all the label size."
 *
 * He is right, and rendering them showed two separate faults:
 *
 *   · 274pt of fixed blocks is 51% of the half sheet's usable height and 71% of the
 *     4x6's, so the same design is half-empty on one stock and cramped on another.
 *   · `bcH = 58` was a HARDCODED GUESS at the barcode's drawn height while the real
 *     one follows the PNG's aspect: 78.6pt on the half sheet, 57.7 on the 4x6, 22.8
 *     on the 3x6. On the half sheet the human-readable line was therefore printed
 *     ON TOP OF THE BARS — and that line is precisely what a receiver keys when the
 *     symbol will not scan.
 *
 * Blocks are now fractions of the available height and the barcode's height is
 * measured from the image, never assumed.
 */
const BLOCKS = { fromTo: 0.21, ids: 0.17, contents: 0.19, carton: 0.08, sscc: 0.35 }

/** PNG width/height straight out of the IHDR, so placement uses the real aspect. */
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

export async function renderCartonLabel(doc, carton, layout = LAYOUTS['half-sheet']) {
  const p = labelProblems(carton)
  if (!p.printable) {
    throw new Error(`refusing to render a non-compliant carton label: ${
      [...p.missing.map((m) => `missing ${m.field}`), ...p.errors].join('; ')}`)
  }
  const { w, h, margin: M } = layout
  const inner = w - M * 2
  const avail = h - M * 2

  // ⚠️ Geometry is checked BEFORE anything is drawn, so a layout change cannot
  // silently shrink the symbol under the readable floor.
  const x = xDimensionFor(inner / PT)
  if (!x.meetsMinimum) {
    throw new Error(`${layout.label}: usable width ${(inner / PT).toFixed(2)}in gives ${x.mils} mil, under the ${X_MIN_IN * 1000} mil floor — the barcode will not read`)
  }

  const dc = DCS[String(carton.dc).replace(/^0+/, '')]
  const addr = dcAddressLines(carton.dc)

  const hFromTo = avail * BLOCKS.fromTo
  const hIds = avail * BLOCKS.ids
  const hContents = avail * BLOCKS.contents
  const hCarton = avail * BLOCKS.carton
  const hSscc = avail * BLOCKS.sscc
  // ⚠️ TYPE IS SIZED FROM ITS OWN BOX, NOT FROM A REFERENCE STOCK. The first version
  // scaled every font by `avail / half-sheet height`, which on the 4x6 comes to 0.72 —
  // so it SHRANK all the text by 28% against a page it is not printed on. Nima:
  // "the text was shrunk for no reason in the boxes makign it harder to read."
  //
  // A label is not a scaled-down page. Each field is a fraction of the height of the
  // block it lives in, so every stock fills its boxes and the type is as large as the
  // box allows. fitText then shrinks ONLY the fields that would not fit across.
  const fs = (px) => Math.max(5.5, px)

  let y = M

  // ── FROM / TO ──
  doc.lineWidth(1).rect(M, y, inner, hFromTo).stroke()
  // ⚠️ EVERY text() IS WIDTH-BOUNDED. Without a width pdfkit runs to the page edge,
  // so on the 3x6 "Entrelaced Holdings, LLC" printed straight through the centre
  // rule and over the consignee. It looked fine on the wider half sheet, which is how
  // a layout bug hides until the narrow stock is used.
  const colW = inner / 2 - 10
  const pad = 4
  const capH = fs(hFromTo * 0.085)          // the little "SHIP FROM" caps
  const nameH = fs(hFromTo * 0.135)         // the company line
  const addrH = fs(hFromTo * 0.105)         // address lines
  // ⚠️ fitText, NOT text(), FOR THE COMPANY LINES. Bounded text() WRAPS, and every
  // offset below it assumes one line — so "Entrelaced Holdings, LLC" became two lines
  // and the address printed straight through the second. A field with a fixed box
  // wants to get smaller, not taller; that is what fitText is for, and it was already
  // being used two blocks down for exactly this reason.
  doc.fontSize(capH).font('Helvetica').text('SHIP FROM', M + 5, y + pad, { width: colW })
  const nameY = y + pad + capH + 2
  fitText(doc, SHIP_FROM.name, M + 5, nameY, colW, { size: nameH, min: 6 })
  doc.font('Helvetica').fontSize(addrH)
    .text([...SHIP_FROM.lines, `${SHIP_FROM.city}, ${SHIP_FROM.state} ${SHIP_FROM.zip}`].join('\n'),
      M + 5, nameY + nameH + 3, { width: colW })
  const half = M + inner / 2
  doc.moveTo(half, y).lineTo(half, y + hFromTo).stroke()
  doc.fontSize(capH).font('Helvetica').text('SHIP TO', half + 5, y + pad, { width: colW })
  fitText(doc, carton.operatingCompany, half + 5, nameY, colW, { size: nameH, min: 6 })
  fitText(doc, dc.name, half + 5, nameY + nameH + 2, colW, { size: nameH * 0.9, min: 6 })
  doc.font('Helvetica').fontSize(addrH)
    .text(addr.join('\n'), half + 5, nameY + nameH * 2 + 5, { width: colW })
  y += hFromTo

  // ── PO / DEPT / STORE — the three §8 markings ShopBop's template omits ──
  doc.rect(M, y, inner, hIds).stroke()
  doc.fontSize(capH).font('Helvetica').text('PURCHASE ORDER', M + 5, y + pad)
  // The PO is the field a picker reads across a pallet — it gets 40% of its block.
  const poSize = fs(hIds * 0.40)
  fitText(doc, carton.po, M + 5, y + pad + capH + 1, inner - 10, { size: poSize, min: 9 })
  // ⚠️ THREE FIELDS ACROSS, SIZED FROM THE LABEL not from fixed offsets. At M+70 the
  // store ran into the vendor number on the 3x6 — the same class of bug as above.
  const fieldW = inner / 3
  // ⚠️ MEASURED, NOT A FRACTION. At hIds*0.48 the DEPT/STORE row sat ON TOP of the PO
  // number, because the PO's own height is 40% of the block and starts below a caption.
  const rowY = y + pad + capH + 1 + poSize + 3
  const field = (i, label, value, size) => {
    const fx = M + 5 + i * fieldW
    doc.fontSize(capH).font('Helvetica').text(label, fx, rowY, { width: fieldW - 6 })
    fitText(doc, value, fx, rowY + capH + 2, fieldW - 6, { size, min: 7 })
  }
  const idH = fs(hIds * 0.26)
  field(0, 'DEPT', carton.department, idH)
  field(1, 'STORE', `${carton.store} ${carton.storeAbbrev}`, idH)
  if (carton.vendorNumber) field(2, 'VENDOR', carton.vendorNumber, idH * 0.86)
  y += hIds

  // ── CONTENTS ──
  doc.rect(M, y, inner, hContents).stroke()
  doc.fontSize(capH).font('Helvetica').text('STYLE / COLOUR / SIZE', M + 5, y + pad)
  // ⚠️ IT MAY WRAP TO TWO LINES, AND THAT IS DELIBERATE. §8.5 requires "style, colour,
  // size details" on every carton, and a single ellipsised line drops the COLOUR —
  // "SN03011LD-MOCHA | St. Barths Petit Tote…" loses "Mocha", which is the half a
  // receiver checks the units against. Unlike the PO and the store, this field is read
  // close up, so height is the right thing to spend on it. The ellipsis stays as a
  // last resort for a style longer than two lines.
  // ⚠️ SIZED SO TWO LINES ACTUALLY FIT. At 0.145 the box came out about a point short
  // of a second line, so pdfkit ellipsised anyway and the fix changed nothing visible —
  // the kind of near-miss that looks like the code was never edited.
  const styleSize = fs(hContents * 0.125)
  doc.fontSize(styleSize).font('Helvetica-Bold')
    .text(String(carton.style), M + 5, y + pad + capH + 1,
      { width: inner - 10, height: styleSize * 2.5, ellipsis: true, lineGap: 0 })
  const cRow = y + hContents * 0.50
  doc.fontSize(capH).font('Helvetica').text('UPC', M + 5, cRow)
  doc.fontSize(fs(hContents * 0.17)).font('Helvetica-Bold').text(String(carton.upc), M + 5, cRow + capH + 2)
  doc.fontSize(capH).font('Helvetica').text('QTY', M + inner / 2, cRow)
  doc.fontSize(fs(hContents * 0.26)).font('Helvetica-Bold').text(String(carton.units), M + inner / 2, cRow + capH + 1)
  const totH = fs(hContents * 0.10)
  doc.fontSize(totH).font('Helvetica')
    .text(`STORE TOTAL  ${carton.totalUnits} units / ${carton.totalCartons} cartons`, M + 5, y + hContents - totH - 4)
  y += hContents

  fitText(doc, `CARTON ${carton.carton} OF ${carton.totalCartons}`, M, y + hCarton * 0.16,
    inner, { size: fs(hCarton * 0.62), min: 10 })
  y += hCarton

  // ── SSCC-18 ──
  // ⚠️ The human-readable (00) line is part of the GS1-128, not decoration: it is
  // what a receiver keys when the symbol will not scan — which is why printing it over
  // the bars, as the fixed bcH did on the half sheet, destroyed the fallback as well
  // as the symbol.
  doc.rect(M, y, inner, hSscc).stroke()
  doc.fontSize(capH).font('Helvetica').text('SSCC-18', M + 5, y + pad)
  const labelTop = y + pad + capH + 3
  const hrH = fs(hSscc * 0.13)
  const hrSpace = hrH + 8
  const barBox = hSscc - (labelTop - y) - hrSpace - pad
  // ⚠️ THE BAR HEIGHT IS REQUESTED, NOT INHERITED. GS1 puts the SSCC bar height on a
  // logistics label at 31.75mm / 1.25in, and this was calling gs1BarcodePng with
  // height: 16 (mm) on every stock — about half of it, and a quarter of it once the
  // 3x6 scaled the image down. Ask for the box we actually have, floored at the spec.
  const wantBarIn = Math.max(BAR_HEIGHT_MIN_IN, barBox / PT)
  const png = await gs1BarcodePng('00', carton.sscc, { scale: 4, height: wantBarIn * 25.4 })
  // ⚠️ 10pt of quiet zone each side, not 20 — the module width IS the X-dimension, and
  // width thrown away here is scanning margin thrown away.
  const bcW = inner - 20
  const size = pngSize(png)
  // ⚠️ MEASURED FROM THE IMAGE, NEVER ASSUMED — this is the constant that caused the
  // overlap. Height is clamped to the box so a tall symbol cannot push the
  // human-readable line off the label.
  const drawnH = Math.min(bcW * (size.h / size.w), barBox)
  doc.image(png, M + 10, labelTop, { width: bcW, height: drawnH })
  const hrSize = (() => { let s2 = hrH; doc.font('Helvetica-Bold')
    while (s2 > 6 && doc.fontSize(s2).widthOfString(`(00) ${carton.sscc}`) > inner - 10) s2 -= 0.5
    return s2 })()
  doc.fontSize(hrSize).font('Helvetica-Bold')
    .text(`(00) ${carton.sscc}`, M, labelTop + drawnH + 4, { width: inner, align: 'center', lineBreak: false })
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
export async function packingSlipPdf(shipment, { on } = {}) {
  checkStorefront(shipment, on)
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

  // ── ⚠️ NOTHING INTERNAL GOES ON THIS SHEET ─────────────────────────────────
  //
  // This page used to carry a "REQUIRED HANDLING - Manual §8.5 / §12.4 ($250)"
  // block: our own reminder of what to do with the slip, printed on the document we
  // hand to Exemplar. Nima: "we need it off the packing slip if we can".
  //
  // He is right, and for a stronger reason than the symbol. A packing slip is a
  // CUSTOMER document. That block quoted their section numbers and their fee amount
  // back at them, and told the receiver we needed reminding how to attach it.
  //
  // ("§" is the section sign — it just means "Section". It rendered fine; it was the
  // content behind it that did not belong.)
  //
  // The instructions still matter, so packingSlipPdf RETURNS them for the app to
  // show on screen, rather than printing them on the freight.
  doc.fillColor('black')
  return doc
}

/**
 * What to DO with the packing slip once it is printed — §8.5 / §12.4, $250.
 *
 * ⚠️ Kept OUT of the PDF deliberately (see above) and exported here so the app can
 * show it to whoever is packing. Printing it is the easy half of that requirement.
 */
export const PACKING_SLIP_HANDLING = [
  'Email this slip to Exemplar IN ADVANCE of the shipment — one per PO per store.',
  'Put a copy in a REMOVABLE POUCH on the carton, with the UNSIGNED BOL (non-trailer shipments).',
  'Mark "PACKING SLIP ATTACHED" on ALL SIX SIDES of that carton.',
  'Parcel (FedEx/UPS) instead of freight: a slip goes on EVERY carton, not just one.',
]
