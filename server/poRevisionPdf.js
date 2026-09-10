// server/poRevisionPdf.js — the revision pick ticket, on paper.
//
// ⚠️ IT PRINTS THE JOB, NOT THE TWO VERSIONS SIDE BY SIDE. A two-column "was / now"
// table is what the data looks like; "PUT BACK all 6" is what someone standing at a
// shelf needs. Both are on the sheet, but the action column is first and the widest.
//
// ⚠️ AND THE MISCODED WARNING GOES ABOVE THE TABLE. Same rule as the ordinary bulk
// pick ticket, which puts problem lines above the SKUs because they change what
// someone does before they start walking. Being told "this was sent as a Duplicate"
// after reading a page of changes is too late to matter.

import PDFDocument from 'pdfkit'
import { actionLine } from '../src/model/poRevisionPick.js'

const M = 36
const GREY = '#666'
const RED = '#b00'
// ⚠️ ASCII ONLY. pdfkit's built-in Helvetica is WinAnsi, so "⚠" renders as "&" and
// "→" vanishes — caught the hard way on the BOL cargo tag.
const WARN = '! '

// ⚠️ ISO, NOT toString().slice(). `receivedAt` is a Date, and slicing its string form
// yields "Fri Aug 28" — no year, on a sheet whose whole purpose is telling two
// transmissions apart. A printed date has to be unambiguous a month later.
const isoDay = (d) => {
  if (!d) return '(no date)'
  const x = d instanceof Date ? d : new Date(d)
  return Number.isNaN(x.getTime()) ? String(d) : x.toISOString().slice(0, 10)
}

export function buildPoRevisionPdf(ticket) {
  const doc = new PDFDocument({ size: 'LETTER', margin: M })
  render(doc, ticket)
  doc.end()
  return doc
}

export async function renderPoRevisionTo(res, ticket) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${revisionFilename(ticket)}"`)
  buildPoRevisionPdf(ticket).pipe(res)
}

export const revisionFilename = (t) => `PO${t.poNumber || 'unknown'}-revision-pick.pdf`

function render(doc, t) {
  const W = doc.page.width - M * 2
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text('REVISION PICK TICKET', M, M)
  doc.font('Helvetica-Bold').fontSize(11).text(`PO ${t.poNumber}`, M, M + 20)

  if (!t.comparable) {
    doc.font('Helvetica').fontSize(10).fillColor(RED).text(WARN + t.reason, M, M + 40, { width: W })
    return
  }

  // ── The two transmissions, named so the sheet is traceable to the EDI ──────
  let y = M + 40
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
  for (const [tag, v] of [['WAS', t.v1], ['NOW', t.v2]]) {
    doc.font('Helvetica-Bold').text(tag, M, y, { continued: true })
      .font('Helvetica')
      .text(`  ${isoDay(v.receivedAt)}  ${v.purposeLabel || '(no purpose code)'}`
        + `  ${v.units} units · ${v.skuCount} SKUs · ${v.storeCount} stores`
        + `  ·  Orderful ${v.transactionId}`)
    y = doc.y + 2
  }
  const stamp = t.fetchedAt ? new Date(t.fetchedAt) : null
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text(stamp ? `Read live from Orderful ${stamp.toLocaleString()}` : 'Read live from Orderful', M, y)
  y = doc.y + 8

  // ── Warnings, above the table ─────────────────────────────────────────────
  if (t.miscoded) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(RED).text(
      WARN + `SENT AS "${t.v2.purposeLabel}" BUT IT IS NOT ONE — ${t.changed.length} SKUs changed. `
      + 'Do not treat this transmission as a repeat.', M, y, { width: W })
    y = doc.y + 4
  }
  if (t.identical) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
      .text('Nothing changed between these two transmissions. This one really is a duplicate.', M, y, { width: W })
    return
  }

  // ⚠️ THE HEADLINE IS TWO NUMBERS, NOT ONE. Net is -9; the work is 13 back and 4
  // out, and a single figure hides half the walking.
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
    .text(`PUT BACK ${t.putBack} units      FETCH ${t.fetch} units`, M, y)
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text(`net ${t.netDelta > 0 ? '+' : ''}${t.netDelta} · ${t.v1.units} -> ${t.v2.units}`, M, doc.y + 1)
  y = doc.y + 10

  // ── What to do, per SKU ───────────────────────────────────────────────────
  const cols = [{ x: M, w: 132 }, { x: M + 136, w: 44 }, { x: M + 184, w: 44 }, { x: M + 232, w: W - 232 }]
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GREY)
  const head = ['SKU', 'WAS', 'NOW', 'ACTION']
  head.forEach((h, i) => doc.text(h, cols[i].x, y, { width: cols[i].w, align: i === 1 || i === 2 ? 'right' : 'left' }))
  y = doc.y + 3
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor('#ccc').stroke()
  y += 5

  for (const r of t.changed) {
    doc.font('Helvetica').fontSize(9).fillColor('#000').text(r.sku, cols[0].x, y, { width: cols[0].w })
    doc.text(String(r.was), cols[1].x, y, { width: cols[1].w, align: 'right' })
    doc.text(String(r.now), cols[2].x, y, { width: cols[2].w, align: 'right' })
    doc.fillColor(r.delta < 0 ? RED : '#000').fontSize(8)
      .text(actionLine(r), cols[3].x, y, { width: cols[3].w })
    y = Math.max(doc.y, y + 11) + 3
    if (y > doc.page.height - M - 90) { doc.addPage(); y = M }
  }

  // ⚠️ UNCHANGED SKUs ARE LISTED, NOT OMITTED. Someone holding the old sheet needs to
  // know which lines they can leave alone — a diff that only shows changes leaves the
  // rest ambiguous, and ambiguity gets re-picked.
  const same = t.rows.filter((r) => r.verdict === 'unchanged')
  if (same.length) {
    y += 6
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GREY).text('UNCHANGED — leave as picked', M, y)
    y = doc.y + 2
    doc.font('Helvetica').fontSize(8).fillColor('#000')
      .text(same.map((r) => `${r.sku} (${r.now})`).join('   ·   '), M, y, { width: W })
    y = doc.y + 8
  }

  // ── Stores whose total moved ──────────────────────────────────────────────
  if (t.storesMoved.length) {
    if (y > doc.page.height - M - 80) { doc.addPage(); y = M }
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('STORES WHOSE TOTAL MOVED', M, y)
    y = doc.y + 4
    doc.font('Helvetica').fontSize(9)
    for (const s of t.storesMoved) {
      doc.fillColor('#000').text(s.store, M, y, { width: 50 })
        .text(String(s.was), M + 52, y, { width: 34, align: 'right' })
        .text(String(s.now), M + 92, y, { width: 34, align: 'right' })
      doc.fillColor(s.delta < 0 ? RED : '#000')
        .text(`${s.delta > 0 ? '+' : ''}${s.delta}`, M + 132, y, { width: 34, align: 'right' })
      y = doc.y + 2
      if (y > doc.page.height - M - 20) { doc.addPage(); y = M }
    }
  }
}
