// server/palletLabelPdf.js — the pallet placard as a 4x6, for the warehouse Zebra.
//
// ⚠️ NO BARCODE, DELIBERATELY. The cartons carry the SSCCs; a pallet has no GS1
// identity in this programme. A barcode here would give a receiver a second thing that
// looks like the unit's identity — the same reasoning that keeps an SSCC off the
// packing slip.
//
// ⚠️ IT IS READ ACROSS A WAREHOUSE, not in the hand like a carton label. So it carries
// five fields at the largest size each will take rather than the carton label's twelve,
// and the store number — the thing a floor sorts by — is the biggest thing on it.

import PDFDocument from 'pdfkit'
import { palletLabel } from '../src/model/palletLabel.js'
import { LABELS } from './printLabel.js'

const PT = 72

/** Same three stocks the carton labels offer, plus the MUNBYN for completeness. */
export const SIZES = {
  '4x6': { w: 4 * PT, h: 6 * PT, margin: 0.15 * PT },
  '3x6': { w: 3 * PT, h: 6 * PT, margin: 0.25 * PT },
  'half-sheet': { w: 5.5 * PT, h: 8.5 * PT, margin: 0.5 * PT },
}

function fit(doc, text, x, y, width, size, { font = 'Helvetica-Bold', min = 6 } = {}) {
  let s = size
  doc.font(font)
  while (s > min && doc.fontSize(s).widthOfString(String(text)) > width) s -= 0.5
  doc.fontSize(s).text(String(text), x, y, { width, lineBreak: false, ellipsis: true })
  return s
}

export async function palletLabelPdf(labels, { size = '4x6', copies = 1 } = {}) {
  const layout = SIZES[size]
  if (!layout) throw new Error(`unknown label size "${size}" — have ${Object.keys(SIZES).join(', ')}`)
  const bad = labels.filter((l) => !l.printable)
  if (bad.length) {
    throw new Error(`refusing to print a non-compliant pallet placard: ${
      bad.flatMap((l) => [...l.missing.map((m) => `missing ${m.requirement}`), ...l.errors]).join('; ')}`)
  }
  const { w: W, h: H, margin: M } = layout
  const inner = W - M * 2
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false })
  const cfg = LABELS[size]

  for (const l of labels) {
    for (let c = 0; c < Math.max(1, copies); c++) {
      doc.addPage({ size: [W, H], margin: 0 })
      // The Zebra's 4x6 has wash: null and stays clean white; only the MUNBYN stock is
      // washed, and only because its gap sensor needs it.
      if (cfg?.wash) doc.rect(0, 0, W, H).fill(cfg.wash)
      doc.fillColor('black')

      let y = M
      doc.lineWidth(2).rect(M, y, inner, H - M * 2).stroke()
      y += 8

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#555')
        .text('PALLET', M + 6, y, { width: inner - 12, align: 'center' })
      doc.fillColor('black')
      y += 14

      fit(doc, `${l.pallet} OF ${l.ofPallets}`, M + 6, y, inner - 12, 42)
      y += 48

      const rule = () => { doc.lineWidth(0.8).moveTo(M + 6, y).lineTo(M + inner - 6, y).stroke(); y += 6 }
      rule()

      const field = (label, value, size2) => {
        doc.fontSize(7).font('Helvetica').fillColor('#444').text(label, M + 8, y)
        doc.fillColor('black')
        y += 9
        fit(doc, value, M + 8, y, inner - 16, size2)
        y += size2 + 4
      }

      field('SHIP TO', l.operatingCompany, 16)
      if (l.dcName) { fit(doc, `${l.dcName}${l.dc ? ` (${l.dc})` : ''}`, M + 8, y, inner - 16, 15); y += 20 }
      rule()
      field('PURCHASE ORDER', l.po, 30)
      rule()

      // Two across: department and store. The store is what a floor sorts by, so it
      // gets the larger of the two.
      const halfW = (inner - 20) / 2
      doc.fontSize(7).font('Helvetica').fillColor('#444').text('DEPT', M + 8, y)
      doc.text('STORE', M + 8 + halfW + 4, y)
      doc.fillColor('black')
      y += 9
      fit(doc, l.department, M + 8, y, halfW - 4, 26)
      fit(doc, `${l.store}${l.storeAbbrev ? ` ${l.storeAbbrev}` : ''}`, M + 8 + halfW + 4, y, halfW - 4, 26)
      y += 34
      rule()

      // ── The count. The one number §12.6 is really about. ──
      doc.fontSize(8).font('Helvetica').fillColor('#444')
        .text('CARTONS ON THIS PALLET', M + 8, y)
      doc.fillColor('black')
      y += 11
      // ⚠️ THE BIGGEST THING ON THE PLACARD, and it fills what is left rather than
      // leaving a third of the label blank — the same waste Nima caught on the carton
      // label. A placard is read across a warehouse; unused height is unused legibility.
      //
      // ⚠️ BOUNDED BY HEIGHT AS WELL AS WIDTH. fit() only shrinks to fit ACROSS, so
      // asking for "all the remaining height" as a point size rendered "22" at about
      // 200pt — narrow enough to pass the width check and far taller than the space
      // left, so it drew off the bottom of the label and vanished. A number that
      // disappears is worse than a small one: the field §12.6 is really about.
      const room = H - M - y - 10
      const countSize = l.placards?.length ? 56 : Math.max(24, Math.min(room * 0.78, 110))
      fit(doc, String(l.cartons), M + 6, y, inner - 12, countSize)
      y += countSize + 6

      // ⚠️ PER-PO PLACARD LINES, when the pallet carries more than one order. The
      // Manual's format is "PO number - carton count", and it is per PO for a reason:
      // a lumped total tells a receiver nothing about which carton is whose.
      if (l.placards?.length) {
        rule()
        doc.fontSize(7).font('Helvetica').fillColor('#444').text('BY PO', M + 8, y)
        doc.fillColor('black')
        y += 9
        for (const p of l.placards) {
          if (y > H - M - 12) break
          fit(doc, p, M + 8, y, inner - 16, 12)
          y += 14
        }
      }
    }
  }
  return doc
}

/** Build the placards for a shipment, ready to render. */
export { palletLabel }
