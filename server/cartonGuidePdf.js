// server/cartonGuidePdf.js — the sheet that says WHERE to stick everything.
//
// Nima, 2026-09-14: "can we have a print out of what the box would look like with all
// labels indicated where they should be clear instruction for applying the label".
//
// ⚠️ IT DRAWS THE ACTUAL BOXES ON THIS SHIPMENT, NOT A GENERIC CARTON. That is the
// whole value: a generic diagram would have shown a happy 1.38-12in band and hidden
// the fact that three of PO 8928906's cartons are 4in tall and cannot take any label
// stock we own on a side face. The drawing is to scale, per box size, with the legal
// band shaded and the label drawn where it should go.
//
// ⚠️ AND IT IS AN INTERNAL SHEET. Unlike the packing slip and the manifest, this one
// never leaves the building, so it CAN carry section numbers and fees — that is what
// makes a rule stick on a floor under time pressure.

import PDFDocument from 'pdfkit'
import { placementPlan } from '../src/model/cartonPlacement.js'
import { LABEL_PLACEMENT, CARTON_MARKINGS, feeFor } from '../src/model/exemplarStandards.js'
import { PORTALS, CONTACTS, DEADLINES } from '../src/model/saksRouting.js'
import { PACKING_SLIP_HANDLING } from './exemplarDocsPdf.js'

const PT = 72
const INK = '#111'
const BAND = '#cfe3ff'
const WARN = '#b42318'

export async function cartonGuidePdf(cartons, { label = { w: 4, h: 6 }, po, store, dc, slipCarton = 1 } = {}) {
  const plan = placementPlan(cartons, label, LABEL_PLACEMENT)
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 })
  const W = 612 - 80

  doc.fontSize(16).font('Helvetica-Bold').fillColor(INK).text('CARTON LABELLING — WHERE EVERYTHING GOES')
  doc.fontSize(9).font('Helvetica').fillColor('#555')
    .text(`PO ${po}   ·   Store ${store}   ·   DC ${dc}   ·   ${cartons.length} cartons   ·   ${label.w}x${label.h}in label stock`)
  doc.fillColor(INK).moveDown(0.8)

  // ── The rules, with their price. Internal sheet, so the fees stay on. ──
  doc.fontSize(10).font('Helvetica-Bold').text('Every carton')
  doc.fontSize(8.5).font('Helvetica')
  // ⚠️ THE MINIMUM IS THE REAL NUMBER, not the per-carton rate — §12 prices almost
  // every carton violation as "$10.00 per carton, $250.00 minimum", so one mislabelled
  // carton costs $250. Printing "10" was reading the left-hand column alone, which
  // understates a single slip by 25x — the exact mistake FEES' own docblock warns about.
  const placementFee = feeFor('gs1Placement', { cartons: cartons.length })
  bullet(doc, `A GS1-128 label on EVERY carton — all ${cartons.length} of them.`)
  bullet(doc, `${LABEL_PLACEMENT.orientation}.`)
  bullet(doc, `Bottom edge ${LABEL_PLACEMENT.minHeightIn}in to ${LABEL_PLACEMENT.maxHeightIn}in from the base of the carton, on ${LABEL_PLACEMENT.side}.`)
  bullet(doc, `${LABEL_PLACEMENT.fedexRule}.`)
  bullet(doc, `Carton markings required (§8.5): ${CARTON_MARKINGS.join(' · ')}.`)
  if (placementFee?.estimate != null) {
    bullet(doc, `Getting placement wrong (§${placementFee.section}): $${placementFee.amount} per carton, `
      + `$${placementFee.min} minimum — so $${placementFee.estimate.toLocaleString()} whether it is one carton or all ${cartons.length}.`)
  }
  doc.moveDown(0.5)

  // ── The packing slip: ONE carton, not all of them. ──
  doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(`ONE carton only — carton ${slipCarton}`)
  doc.fontSize(8.5).font('Helvetica')
  // ⚠️ THE COMMONEST MISREADING, AND THE ONE NIMA ASKED ABOUT TWICE. The slip is one
  // per PO per store, in a pouch on ONE carton, and "PACKING SLIP ATTACHED" goes on the
  // six sides of THAT carton — not on all of them. The every-carton rule is the PARCEL
  // exception, and this is LTL.
  bullet(doc, 'The packing slip is ONE per PO per store — it does NOT go on every box.')
  for (const h of PACKING_SLIP_HANDLING) bullet(doc, h)
  bullet(doc, 'This shipment is LTL/palletised, so the every-carton slip rule (FedEx/UPS) does not apply.')
  doc.moveDown(0.8)

  // ── Before it ships: where to route it, and where the slip is emailed ──
  //
  // ⚠️ BOTH OF THESE ARE PRINTED AS GAPS, NOT GUESSES. Nima asked for a portal link and
  // the packing-slip email on 2026-09-14 and we hold neither. The Routing Guide gives
  // CONTACTS, not addresses; the nearest thing to a TMS URL is the domain of its
  // support mailbox. A plausible link on a routing instruction sends someone to the
  // wrong system to book real freight, and "emailed IN ADVANCE to the DC contact
  // office" is not an address. So the sheet names what we have and says what is
  // missing, which is the thing that actually gets it filled in.
  doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text('Before it ships', 40, doc.y)
  doc.fontSize(8.5).font('Helvetica')
  const tms = PORTALS.tms
  bullet(doc, `${tms.name} — ${tms.what}`)
  bullet(doc, tms.url
    ? `Route it at: ${tms.url}   (support ${tms.support})`
    : `Portal link: NOT ON FILE. Support ${tms.support}. Paste the bookmark you use and this sheet will carry it.`)
  bullet(doc, `Routing must be booked at least ${DEADLINES.tmsRouting.businessDaysBeforeCancel} business days before the cancel date (p${DEADLINES.tmsRouting.page}).`)
  bullet(doc, 'Packing-slip email: NOT ON FILE. The guide says "emailed IN ADVANCE to the DC contact office" '
    + `and gives no address for ${dc}. The nearest contact we hold is ${CONTACTS.shippingAndRouting} — confirm with them before relying on it.`)
  doc.moveDown(0.8)

  // ── A drawing per box size ──
  for (const g of plan.groups) {
    if (doc.y > 560) { doc.addPage(); doc.y = 40 }
    drawGroup(doc, g, label, W, slipCarton)
  }

  if (plan.blocked.length) {
    if (doc.y > 600) { doc.addPage(); doc.y = 40 }
    doc.moveDown(0.5)
    // ⚠️ ASCII ONLY IN THE DRAWN TEXT. pdfkit's standard fonts are WinAnsi, so the
    // warning sign rendered as "&" — the same class as the em dash that came out as
    // garbage on the ZPL label. The symbol is in the comments, not on the page.
    doc.fontSize(11).font('Helvetica-Bold').fillColor(WARN).text('ASK EXEMPLAR BEFORE THESE SHIP', 40, doc.y, { width: W })
    doc.fontSize(8.5).font('Helvetica').fillColor(INK)
    for (const b of plan.blocked) {
      bullet(doc, `${b.box} (${b.count} carton${b.count === 1 ? '' : 's'}: ${b.cartons.join(', ')}) — ${b.placement.why}.`)
    }
    bullet(doc, 'No label stock we hold fits a side face on these. The guide does not cover a carton this shallow, so it is a question for Exemplar rather than something to improvise.')
  }
  return doc
}

// ⚠️ BOUNDED AND POSITIONED. Without an explicit x the indent compounds against
// whatever the previous block left doc.x at, so the ASK EXEMPLAR bullets ran off the
// right edge and lost the end of every line — "4in of l".
function bullet(doc, text) {
  doc.text(`-  ${text}`, 46, doc.y, { width: 612 - 92 })
}

function drawGroup(doc, g, label, W, slipCarton) {
  const top = doc.y
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(`${g.box}   ·   ${g.count} carton${g.count === 1 ? '' : 's'}`, 40, top)
  doc.fontSize(8).font('Helvetica').fillColor('#555')
    .text(`carton ${g.cartons.join(', ')}`, 40, doc.y, { width: W })
  doc.fillColor(INK)
  const y0 = doc.y + 6

  if (!g.placement.ok) {
    doc.rect(40, y0, W, 34).lineWidth(1).strokeColor(WARN).stroke()
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WARN)
      .text('NO VALID PLACEMENT', 48, y0 + 7, { width: W - 16 })
    doc.fontSize(8).font('Helvetica').text(g.placement.why, 48, y0 + 19, { width: W - 16 })
    doc.fillColor(INK).strokeColor(INK)
    doc.y = y0 + 44
    return
  }

  // Draw the LONG SIDE to scale. The option actually recommended is the first one on
  // the long side — upright when it fits, else on its side.
  const opt = g.placement.options.find((o) => o.face === 'long side') || g.placement.options[0]
  const dims = g.dims
  const maxDrawW = 300
  const scale = Math.min(maxDrawW / dims.length, 96 / dims.height, 6)
  const bw = dims.length * scale
  const bh = dims.height * scale
  const bx = 48
  const by = y0 + 6

  // the carton
  doc.lineWidth(1.2).strokeColor(INK).rect(bx, by, bw, bh).stroke()

  // ⚠️ THE BAND IS DRAWN FROM THE COMPUTED NUMBERS, not sketched. It is the range the
  // label's BOTTOM EDGE may sit in, measured from the base of the carton — which is why
  // it is drawn upward from the bottom rule and not centred.
  const bandBottomY = by + bh - opt.bottomTo * scale
  const bandTopY = by + bh - opt.bottomFrom * scale
  doc.rect(bx, bandBottomY, bw, bandTopY - bandBottomY).fillOpacity(0.35).fill(BAND).fillOpacity(1)
  doc.fillColor(INK)

  // the label where it should sit — at the bottom of the legal band
  const lw = opt.labelW * scale
  const lh = opt.labelH * scale
  const lx = bx + 12
  const ly = by + bh - opt.bottomFrom * scale - lh
  doc.lineWidth(1).strokeColor(INK).rect(lx, ly, lw, lh).stroke()
  // picket-fence bars, so the orientation is unmistakable at a glance
  doc.lineWidth(0.8).strokeColor(INK)
  for (let i = 0; i < 14; i++) {
    const x = lx + 4 + i * ((lw - 8) / 14)
    doc.moveTo(x, ly + lh * 0.45).lineTo(x, ly + lh * 0.85).stroke()
  }
  doc.fontSize(5).font('Helvetica-Bold').text('GS1-128', lx + 3, ly + 3, { width: lw - 6 })

  // dimension callouts
  doc.fontSize(7.5).font('Helvetica').fillColor('#444')
  doc.text(`${dims.length}in`, bx, by + bh + 3, { width: bw, align: 'center' })
  doc.text(`${dims.height}in`, bx - 6 - 22, by + bh / 2 - 4, { width: 22, align: 'right' })
  doc.fillColor(INK)

  const tx = bx + bw + 16
  doc.fontSize(8.5).font('Helvetica-Bold').text(`Label ${opt.orientation}`, tx, by, { width: W - bw - 40 })
  doc.font('Helvetica').fontSize(8)
    .text(`${opt.labelW}in wide x ${opt.labelH}in tall, on the ${opt.face} (${opt.faceW}in x ${opt.faceH}in).`, tx, doc.y, { width: W - bw - 40 })
    .text(`Bottom edge ${opt.bottomFrom}in to ${opt.bottomTo}in from the base — the shaded band.`, tx, doc.y, { width: W - bw - 40 })
    .text(`Bars run vertically (picket fence), reading toward the base.`, tx, doc.y, { width: W - bw - 40 })
  if (g.cartons.includes(slipCarton)) {
    doc.font('Helvetica-Bold').fillColor(WARN)
      .text(`Carton ${slipCarton} is in this group — it also carries the packing-slip pouch and "PACKING SLIP ATTACHED" on all six sides.`,
        tx, doc.y + 2, { width: W - bw - 40 })
    doc.fillColor(INK)
  }
  doc.y = Math.max(doc.y, by + bh + 20)
}
