// server/slipMarkingPdf.js — the "PACKING SLIP ATTACHED" markings, six to a carton.
//
// Nima, 2026-09-14: "i need a packing slip enclosed for all sides of the carton label
// on the 4x6 printed page".
//
// ⚠️ THE WORDING IS THE GUIDE'S. Both source documents say ATTACHED, not ENCLOSED —
// see SLIP_MARKING in cartonPlacement.js, which is the single place it is written.
//
// ⚠️ SIX PAGES, ONE PER FACE, AND EACH ONE NAMES ITS FACE. Six identical labels in a
// stack is how five end up on the same carton; naming the face turns the stack into a
// checklist. The face names come from the computed plan, so the one sharing a side
// with the GS1-128 says so on the label itself.

import PDFDocument from 'pdfkit'
import { markingPlan, placementFor, parseBox, SLIP_MARKING } from '../src/model/cartonPlacement.js'
import { LABEL_PLACEMENT } from '../src/model/exemplarStandards.js'

const PT = 72
const WARN = '#b42318'

export async function slipMarkingPdf({ box = null, size = '4x6', po, carton } = {}) {
  // ⚠️ THE MUNBYN STOCK IS OFFERED HERE AND NOWHERE ELSE, and the asymmetry is the
  // point. Nima, 2026-09-14: "would our munbyn printer also be acceptable".
  //
  // For the GS1-128 carton label: NO. Its 2.25x1.25 stock gives an X-dimension of
  // 8.9 mil at 0.1in margins — over the 7.5 mil floor but UNDER the 9.8 mil conveyor
  // recommendation, and this PO is XDOCK. Worse, GS1 puts the SSCC bar height at
  // 1.25in and the whole label is 1.25in tall, so a compliant symbol would eat the
  // entire label leaving nothing for §8.5's seven required markings.
  //
  // For THIS marking: yes, and it is the better stock. It is text with no barcode and
  // no size specified in the guide, and it fits all six faces of every box on the
  // shipment with room to spare — including the 24x14x4 cartons, where a 4x6 marking
  // has ZERO clearance on four of the six faces.
  const dims = {
    '4x6': { w: 4, h: 6 }, '3x6': { w: 3, h: 6 }, 'half-sheet': { w: 5.5, h: 8.5 },
    '2.25x1.25': { w: 2.25, h: 1.25 },
  }[size]
  if (!dims) throw new Error(`unknown label size "${size}"`)

  const boxDims = box ? parseBox(box) : null
  const plan = boxDims
    ? markingPlan(boxDims, dims, placementFor(boxDims, dims, LABEL_PLACEMENT))
    : null

  const W = dims.w * PT
  const H = dims.h * PT
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false })

  const faceList = plan ? plan.faces : [
    { face: 'long side (with the GS1-128)' }, { face: 'long side (opposite)' },
    { face: 'end' }, { face: 'end (opposite)' }, { face: 'top' }, { face: 'bottom' },
  ]

  for (const f of faceList) {
    doc.addPage({ size: [W, H], margin: 0 })
    const M = 0.15 * PT
    doc.lineWidth(2).rect(M, M, W - M * 2, H - M * 2).stroke()

    // ⚠️ Rotated so the words run along the LONG axis of the stock. A 4x6 read
    // portrait gives "PACKING SLIP" two cramped lines; turned, it is one legible line
    // across six inches, which is what someone reads walking past a pallet.
    // ⚠️ ROTATE ONLY WHEN THE STOCK IS TALLER THAN IT IS WIDE. The 2.25x1.25 already
    // has its long axis horizontal, so turning it would set the words vertically on a
    // label barely an inch tall — unreadable, and the opposite of why we rotate.
    const turn = H > W
    doc.save()
    if (turn) doc.rotate(-90, { origin: [W / 2, H / 2] })
    const tw = (turn ? H : W) - M * 2
    const th = (turn ? W : H) - M * 2

    // ⚠️ THE LINES ARE STACKED FROM THEIR MEASURED HEIGHTS, NOT FROM MULTIPLES OF THE
    // HEADLINE SIZE. Offsets of fs*0.45 / fs*0.85 / fs*1.25 are fine when fs is 44pt on
    // a 4x6 and pile straight on top of each other when the 2.25x1.25 shrinks fs to
    // about 14 — which is exactly what they did: three lines in one place, unreadable.
    let fs = 44
    doc.font('Helvetica-Bold')
    while (fs > 9 && doc.fontSize(fs).widthOfString(SLIP_MARKING) > tw - 16) fs -= 1

    const lines = [{ text: SLIP_MARKING, size: fs, font: 'Helvetica-Bold', color: 'black', gap: 4 }]
    if (f.tight) {
      lines.unshift({ text: 'TIGHT FIT - LAND IT SQUARE', size: Math.max(6, fs * 0.2), font: 'Helvetica-Bold', color: WARN, gap: 3 })
    }
    lines.push({ text: f.face, size: Math.max(6.5, fs * 0.24), font: 'Helvetica', color: '#333', gap: 2 })
    const sub = [po ? `PO ${po}` : null, carton ? `carton ${carton}` : null].filter(Boolean).join('   ·   ')
    if (sub) lines.push({ text: sub, size: Math.max(6, fs * 0.19), font: 'Helvetica', color: '#666', gap: 2 })
    if (/GS1/.test(f.face)) {
      lines.push({ text: 'DO NOT COVER THE BARCODE', size: Math.max(6.5, fs * 0.21), font: 'Helvetica-Bold', color: WARN, gap: 0 })
    }

    // Shrink the whole stack if it is taller than the label, rather than letting the
    // last line run off the edge.
    const stackH = () => lines.reduce((a, l) => a + l.size * 1.12 + l.gap, 0)
    let guard = 0
    while (stackH() > th && guard++ < 60) for (const l of lines) l.size = Math.max(5, l.size * 0.94)

    let ly = -stackH() / 2
    for (const l of lines) {
      doc.font(l.font).fontSize(l.size).fillColor(l.color)
        .text(l.text, W / 2 - tw / 2, H / 2 + ly, { width: tw, align: 'center', lineBreak: false })
      ly += l.size * 1.12 + l.gap
    }
    doc.fillColor('black')
    doc.restore()
  }
  return { doc, plan }
}
