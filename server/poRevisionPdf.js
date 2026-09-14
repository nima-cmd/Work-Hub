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
  // ⚠️ THE GRID IS A SECOND PAGE, LANDSCAPE, IN THE SAME DOCUMENT. 24 stores against
  // 10 SKUs does not fit portrait, and splitting it into two prints is how one half
  // ends up on a bench without the other. Page 1 is what to DO; page 2 is what they
  // WANT — Nima, 2026-09-10: "what thye want in total is the important number".
  if (ticket.comparable && ticket.grid?.stores?.length) {
    doc.addPage({ size: 'LETTER', layout: 'landscape', margin: M })
    renderGrid(doc, ticket)
  }
  doc.end()
  return doc
}

/** A short column head. SN03012LD-CASHMERE -> "3012 CASH" in a 60pt column. */
export function shortSku(sku) {
  const m = String(sku).match(/^SN0?(\d+)[A-Z]{2}-(.+)$/)
  if (!m) return String(sku).slice(0, 10)
  return `${m[1]} ${m[2].replace(/[^A-Z]/gi, '').slice(0, 5)}`
}

function renderGrid(doc, t) {
  const g = t.grid
  const W = doc.page.width - M * 2
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text('WHAT THEY WANT — BY STORE', M, M)
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text(`PO ${t.poNumber}  ·  ${isoDay(t.v2.receivedAt)} version, Orderful ${t.v2.transactionId}`
      + `  ·  ${t.v2.units} units across ${g.stores.length} stores`
      + `  ·  a red cell changed from the ${isoDay(t.v1.receivedAt)} version`, M, M + 18)

  // ⚠️ Reported, not assumed away: a line whose store split does not sum to its own
  // declared quantity means a store is short and the grid cannot show which.
  let y = M + 32
  if (g.sdqMismatch.length) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(RED).text(
      WARN + `${g.sdqMismatch.length} line(s) whose store split does not add up to the PO quantity: `
      + g.sdqMismatch.map((x) => `${x.sku} declares ${x.declared}, stores sum ${x.fromStores}`).join('; '),
      M, y, { width: W })
    y = doc.y + 4
  }

  const storeW = 40
  const totW = 42
  const n = g.skus.length
  const colW = Math.max(34, Math.floor((W - storeW - totW) / n))

  // ── Head ──────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(7).fillColor(GREY).text('STORE', M, y, { width: storeW })
  g.skus.forEach((sku, i) => doc.text(shortSku(sku), M + storeW + i * colW, y, { width: colW - 2, align: 'right' }))
  doc.text('TOTAL', M + storeW + n * colW, y, { width: totW, align: 'right' })
  y = doc.y + 3
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor('#999').stroke()
  y += 4

  // ── One row per store ─────────────────────────────────────────────────────
  doc.fontSize(8)
  for (const store of g.stores) {
    const st = g.storeTotals[store]
    doc.font('Helvetica-Bold').fillColor('#000').text(store, M, y, { width: storeW })
    g.skus.forEach((sku, i) => {
      const cell = g.cell[sku][store]
      const x = M + storeW + i * colW
      if (cell.was === cell.now) {
        // ⚠️ A ZERO IS BLANK, not "0". Twenty-four rows of zeros is a wall someone
        // has to read past to find the seven numbers that matter.
        doc.font('Helvetica').fillColor('#000').text(cell.now ? String(cell.now) : '', x, y, { width: colW - 2, align: 'right' })
      } else {
        doc.font('Helvetica-Bold').fillColor(RED)
          .text(`${cell.was}>${cell.now}`, x, y, { width: colW - 2, align: 'right' })
      }
    })
    doc.font('Helvetica-Bold').fillColor(st.was === st.now ? '#000' : RED)
      .text(st.was === st.now ? String(st.now) : `${st.was}>${st.now}`,
        M + storeW + n * colW, y, { width: totW, align: 'right' })
    y = doc.y + 2
    if (y > doc.page.height - M - 40) {
      doc.addPage({ size: 'LETTER', layout: 'landscape', margin: M })
      y = M
    }
  }

  // ── The number that matters ───────────────────────────────────────────────
  doc.moveTo(M, y + 1).lineTo(M + W, y + 1).lineWidth(1).strokeColor('#000').stroke()
  y += 5
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('WANT', M, y, { width: storeW })
  g.skus.forEach((sku, i) => {
    const tot = g.skuTotals[sku]
    doc.fillColor(tot.was === tot.now ? '#000' : RED)
      .text(String(tot.now), M + storeW + i * colW, y, { width: colW - 2, align: 'right' })
  })
  doc.fillColor('#000').text(String(t.v2.units), M + storeW + n * colW, y, { width: totW, align: 'right' })
  y = doc.y + 1

  // The previous ask, small, underneath — for checking against the sheet on the bench.
  doc.font('Helvetica').fontSize(7).fillColor(GREY).text('was', M, y, { width: storeW })
  g.skus.forEach((sku, i) => {
    const tot = g.skuTotals[sku]
    doc.text(tot.was === tot.now ? '' : String(tot.was), M + storeW + i * colW, y, { width: colW - 2, align: 'right' })
  })
  doc.text(String(t.v1.units), M + storeW + n * colW, y, { width: totW, align: 'right' })
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
