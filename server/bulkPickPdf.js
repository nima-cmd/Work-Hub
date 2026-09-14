// server/bulkPickPdf.js — one pick ticket across several POs that share SKUs.
//
// Nima, 2026-09-11: "we would like to be able to do a multi bulk pick ticket when sku
// match like this and are pulled from stock breakign down her PO giving us our total."
//
// ── WHY THIS IS NOT JUST TWO PICK TICKETS STAPLED TOGETHER ──────────────────
//
// POs 1236143 and 1236132 share all seven SKUs. Picked separately, someone walks to
// the SN03012LD-CASHMERE location twice, counts twice, and — the part that actually
// costs money — discovers the shortage on the SECOND trip, after the first PO has
// already taken what it wanted.
//
// So the ticket is organised the way the floor works: ONE line per SKU with the total
// to pull, then the split underneath. Pull 137, then divide.
//
// ⚠️ AND IT SHOWS THE SPLIT AS AN ALLOCATION, NOT AS THE ORDER QUANTITY. When stock
// is short the two are different numbers, and a pick ticket printing what was ORDERED
// sends someone to find units that do not exist. The allocation comes from
// src/model/allocationPlan.js under an explicitly chosen rule.

import PDFDocument from 'pdfkit'
import { shortfall, allocate, invoiceAdjustments, readyToFulfil } from '../src/model/allocationPlan.js'

const PAGE = { w: 792, h: 612 }   // landscape letter — the split needs width
const M = 36

const rule = (doc, y, x = M, w = PAGE.w - M * 2) => doc.moveTo(x, y).lineTo(x + w, y).stroke()

/**
 * @param demand    [{ po, order, store, sku, qty }]
 * @param available { sku: units } — the only pool that may be used
 * @param opts.rule which allocation rule; REQUIRED, see allocationPlan.js
 */
export function bulkPickPdf(demand, available, { rule: ruleName, ruleOptions = {}, title = 'BULK PICK TICKET', pool = 'stock' } = {}) {
  const short = shortfall(demand, available)
  const plan = allocate(demand, available, { rule: ruleName, ruleOptions })
  const adjustments = invoiceAdjustments(plan)
  const ready = readyToFulfil(plan, available)

  const byOrder = new Map(plan.lines.map((l) => [`${l.order}|${l.sku}`, l]))
  const pos = [...new Set(demand.map((d) => String(d.po)))].sort()

  // ⚠️ autoFirstPage MUST be false when you addPage() yourself, or page 1 is the
  // blank automatic one and every reader sees an empty sheet. Caught by rasterising
  // the output; nothing in the code or the tests would have shown it.
  const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: 0, autoFirstPage: false })
  doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 })

  doc.fontSize(16).font('Helvetica-Bold').text(title, M, M)
  doc.fontSize(8.5).font('Helvetica').fillColor('#555')
    .text(`POs ${pos.join(' + ')}   ·   pulling from ${pool}   ·   allocation rule: ${plan.rule}`, M, M + 20)
  doc.fillColor('black')

  // ⚠️ THE HEADLINE IS THE SHORTAGE, because it is the only thing that changes what
  // anyone does. A pick ticket that opens with a unit count buries it.
  let y = M + 40
  if (short.totalShort > 0) {
    doc.rect(M, y, PAGE.w - M * 2, 26).fillAndStroke('#fff4e5', '#d08a00')
    doc.fillColor('#8a5a00').fontSize(10).font('Helvetica-Bold')
      .text(`SHORT ${short.totalShort} units — ${short.shortSkus.map((s) => `${s.sku} (${s.available} of ${s.demand})`).join(', ')}`,
        M + 8, y + 8, { width: PAGE.w - M * 2 - 16 })
    doc.fillColor('black')
    y += 34
  } else {
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#2a7').text('Full quantity available for every SKU.', M, y)
    doc.fillColor('black'); y += 22
  }

  // ── The pick lines ──
  const cols = { sku: M, pull: 200, have: 260, short: 320, po1: 390, po2: 500, note: 610 }
  doc.fontSize(8).font('Helvetica-Bold')
  doc.text('SKU', cols.sku, y)
  doc.text('PULL', cols.pull, y)
  doc.text('ON HAND', cols.have, y)
  doc.text('SHORT', cols.short, y)
  pos.forEach((p, i) => doc.text(`PO ${p}`, i === 0 ? cols.po1 : cols.po2, y))
  doc.text('', cols.note, y)
  y += 12
  rule(doc, y); y += 6

  for (const row of short.rows) {
    const allocatedForSku = plan.lines.filter((l) => l.sku === row.sku)
    const pull = allocatedForSku.reduce((a, l) => a + l.allocated, 0)
    doc.fontSize(9).font('Helvetica-Bold').text(row.sku, cols.sku, y)
    doc.fontSize(11).text(String(pull), cols.pull, y - 1)
    doc.fontSize(9).font('Helvetica').text(String(row.available), cols.have, y)
    if (row.short > 0) {
      doc.fillColor('#c33').font('Helvetica-Bold').text(`-${row.short}`, cols.short, y).fillColor('black')
    } else doc.text('-', cols.short, y)
    doc.font('Helvetica')
    pos.forEach((p, i) => {
      const ordered = row.byPo[p] || 0
      const alloc = allocatedForSku.filter((l) => String(l.po) === p).reduce((a, l) => a + l.allocated, 0)
      const txt = ordered === alloc ? `${alloc}` : `${alloc}  (of ${ordered})`
      doc.text(txt, i === 0 ? cols.po1 : cols.po2, y)
    })
    y += 16
    if (y > PAGE.h - 90) { doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = M }
  }
  rule(doc, y); y += 8
  const totalPull = plan.lines.reduce((a, l) => a + l.allocated, 0)
  doc.fontSize(10).font('Helvetica-Bold')
    .text(`TOTAL TO PULL   ${totalPull} units`, cols.sku, y)
  pos.forEach((p, i) => {
    const t = plan.totals.find((t2) => String(t2.po) === p)
    doc.text(`${t.allocated}`, i === 0 ? cols.po1 : cols.po2, y)
  })
  y += 24

  // ── ⚠️ THE GO / NO-GO, above the cut list ──
  //
  // "let me know when im gond to fulfille them". It sits before the cut list because
  // it is the sentence that decides whether anyone reads the rest today.
  if (y > PAGE.h - 120) { doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = M }
  const ok = ready.ready && ready.warnings.length === 0
  const bg = ready.ready ? (ready.warnings.length ? '#fff4e5' : '#eefaf0') : '#fdecec'
  const fg = ready.ready ? (ready.warnings.length ? '#8a5a00' : '#1c6b3a') : '#a11'
  const boxH = 20 + (ready.blocks.length + ready.warnings.length) * 11
  doc.rect(M, y, PAGE.w - M * 2, boxH).fillAndStroke(bg, fg)
  doc.fillColor(fg).fontSize(11).font('Helvetica-Bold').text(ready.verdict, M + 8, y + 6)
  doc.fontSize(7.5).font('Helvetica')
  let ly = y + 19
  for (const b of ready.blocks) { doc.text('BLOCKED: ' + b, M + 8, ly, { width: PAGE.w - M * 2 - 16 }); ly += 11 }
  for (const w of ready.warnings) { doc.text('- ' + w, M + 8, ly, { width: PAGE.w - M * 2 - 16 }); ly += 11 }
  doc.fillColor('black')
  y += boxH + 8
  doc.fontSize(7.5).font('Helvetica').fillColor('#555')
    .text(`${ready.shipping} units across ${ready.ordersShipping} orders · ${ready.ordersAdjusted} orders adjusted · ${ready.note}`, M, y, { width: PAGE.w - M * 2 })
  doc.fillColor('black'); y += 22

  // ── ⚠️ The cut list, on the same sheet ──
  //
  // "make sure we know where we cut our units so we can adjust when we make our
  // invoice". Kept here rather than on a separate report because the person who
  // discovers the shortage is the person holding this piece of paper.
  if (adjustments.length) {
    if (y > PAGE.h - 140) { doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = M }
    doc.fontSize(11).font('Helvetica-Bold').text('SHORT — remember these when you invoice', M, y); y += 4
    doc.fontSize(7.5).font('Helvetica').fillColor('#555')
      .text('The SKU is absent from these fulfilments entirely, not reduced. Invoicing the ORDERED quantity on any of them is an overbill the partner will dispute.', M, y + 10)
    doc.fillColor('black'); y += 26
    doc.fontSize(8).font('Helvetica-Bold')
    doc.text('ORDER', M, y); doc.text('IF', M + 62, y); doc.text('PO', M + 124, y); doc.text('STORE', M + 180, y)
    doc.text('SKU', M + 270, y); doc.text('ORDERED', M + 420, y); doc.text('SHIPPING', M + 490, y); doc.text('CUT', M + 560, y)
    y += 11; rule(doc, y); y += 5
    doc.font('Helvetica').fontSize(8)
    for (const o of adjustments) {
      for (const l of o.lines) {
        doc.text(o.order, M, y)
        // ⚠️ THE IF NUMBER IS THE ONE THAT MATTERS ONCE FULFILMENTS EXIST. The
        // invoice and the ASN are raised against the fulfilment, not the sales
        // order, so a short list keyed only on SO numbers makes someone look it up.
        doc.font('Helvetica-Bold').text(o.iff || '-', M + 62, y).font('Helvetica')
        doc.text(String(o.po), M + 124, y)
        doc.text(String(o.store).slice(0, 30), M + 180, y)
        doc.text(l.sku, M + 270, y)
        doc.text(String(l.ordered), M + 420, y); doc.text(String(l.shipping), M + 490, y)
        doc.fillColor('#c33').font('Helvetica-Bold').text(`-${l.cut}`, M + 560, y).fillColor('black').font('Helvetica')
        if (l.shipping === 0) doc.fillColor('#c33').fontSize(7).text('SKU NOT ON THE IF', M + 600, y).fontSize(8).fillColor('black')
        y += 11
        if (y > PAGE.h - 40) { doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = M }
      }
    }
  }
  return { doc, shortfall: short, plan, adjustments, ready }
}
