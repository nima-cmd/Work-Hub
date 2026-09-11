// server/pickTicketPdf.js — the bulk pick ticket as a document you can actually hold.
//
// ⚠️ THE PRINT BUTTON USED TO CALL `window.print()` AND PRODUCE NOTHING USABLE. The app
// has no print stylesheet at all, so the browser sent the whole dark UI to the printer —
// top bar, EDI arrival banner, court strip — and dropped the background, leaving pale
// grey text on white. Nima, 2026-09-01: "the print doesn't generate any document."
//
// The fix is not a stylesheet. A pick ticket is a DOCUMENT: it gets carried, marked up,
// and left on a pallet, and it must look the same whoever prints it. The repo already
// makes documents this way — bolPdf.js for VICS BOLs, printLabel.js for hang tags — so
// this is the third of the same shape, not a new mechanism.
//
// ⚠️ IT RENDERS FROM THE SAME TICKET OBJECT THE SCREEN SHOWS, never from a second query.
// A printed sheet that disagrees with the screen is worse than no sheet, and re-querying
// to print would guarantee it eventually does.

import PDFDocument from 'pdfkit'

const M = 36
const RED = '#c00'
const GREY = '#666'

// ⚠️ NO "⚠" ON THE PAGE. pdfkit's built-in Helvetica is WinAnsi-encoded and U+26A0 is
// not in it — the first render printed every warning as "&", turning "⚠ PO 40847685 —
// all closed" into "& PO 40847685". Caught by rasterising the PDF and LOOKING at it,
// which is the only way this class of fault shows up. The word carries itself.
const WARN = 'WARNING: '

// Letter portrait, unless the table needs more width than that allows. A per-PO column
// set of 4+ on top of the stock columns stops fitting; landscape buys 200pt.
export const needsLandscape = (ticket) =>
  (ticket.poColumns?.length > 1 ? ticket.poColumns.length : 0) + (ticket.stockColumns?.length || 0) > 5

export function buildPickTicketPdf(ticket) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER', margin: M,
        layout: needsLandscape(ticket) ? 'landscape' : 'portrait',
      })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      render(doc, ticket)
      doc.end()
    } catch (e) { reject(e) }
  })
}

export async function renderPickTicketTo(res, ticket) {
  const pdf = await buildPickTicketPdf(ticket)
  res.setHeader('Content-Type', 'application/pdf')
  // ⚠️ `inline`, so it opens in the browser's own PDF viewer with a print button, rather
  // than landing in Downloads for someone to go find. Naming it after the POs means two
  // tickets open at once are still tellable apart.
  res.setHeader('Content-Disposition', `inline; filename="${pickTicketFilename(ticket)}"`)
  res.send(pdf)
}

export function pickTicketFilename(ticket) {
  const pos = (ticket.asked || []).join('_').replace(/[^A-Za-z0-9_-]/g, '') || 'ticket'
  return `PickTicket_${pos.slice(0, 60)}.pdf`
}

// The columns of the SKU table, in print order, each with its width and how to read a
// row. Built once so the header and the body can never disagree about what a column is.
export function columnPlan(ticket, width) {
  const perPo = ticket.poColumns?.length > 1 ? ticket.poColumns : []
  const stock = ticket.stockColumns || []
  const cols = [
    { key: 'sku', label: 'SKU', w: 150, align: 'left', get: (s) => s.sku },
    ...perPo.map((po) => ({ key: 'po:' + po, label: 'PO ' + po, w: 52, align: 'right', get: (s) => s.byPo[po] || '' })),
    { key: 'need', label: 'PICK', w: 46, align: 'right', bold: true, get: (s) => s.total },
    ...stock.map((c) => ({
      key: 'loc:' + c.id,
      // The order's own location is marked, because it is the one that is routinely
      // empty and a picker needs to know that is expected rather than alarming.
      label: shortLoc(c.name) + (c.isOrderLocation ? ' *' : ''),
      w: 62, align: 'right',
      get: (s) => (ticket.stockKnown ? fmtQty(s.onHand?.[c.id]) : '?'),
    })),
    {
      key: 'short', label: 'SHORT', w: 50, align: 'right',
      get: (s) => (ticket.stockKnown && s.short > 0 ? s.short : ''),
    },
  ]
  // The SKU column absorbs whatever is left, so the table always fills the page.
  const fixed = cols.slice(1).reduce((a, c) => a + c.w, 0)
  cols[0].w = Math.max(110, width - fixed)
  return cols
}

// "Warehouse Bulk : Bloomingdale's" is 31 characters and will not fit a 62pt column.
// ⚠️ The LEAF is kept, not the parent — "Warehouse Bulk" would be identical for all
// seven partner buckets, which is the fullname-vs-leaf trap in the other direction.
export function shortLoc(name) {
  const raw = String(name || '').trim()
  const leaf = raw.includes(' : ') ? raw.split(' : ').pop().trim() : raw
  if (leaf === 'Virtual Warehouse') return 'Virtual WH'
  // ⚠️ NINE, not twelve. A 62pt column at 8pt bold fits about 13 characters, and the
  // order-location marker (" *") plus an ellipsis eat three of them — the first render
  // printed "Bloomingdal… *" with the marker sheared off the page, which is exactly the
  // column a picker needs to identify.
  return leaf.length > 10 ? leaf.slice(0, 9) + '.' : leaf
}

// A zero is printed as "0", not blank — blank reads as "not looked at".
const fmtQty = (v) => (v === null || v === undefined ? '?' : String(v))

function render(doc, ticket) {
  const W = doc.page.width - M * 2
  const cols = columnPlan(ticket, W)

  // ── Header ────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text('BULK PICK TICKET', M, M)
  doc.font('Helvetica-Bold').fontSize(11)
    .text(`PO ${(ticket.asked || []).join('   PO ')}`, M, M + 20)

  const stamp = ticket.fetchedAt ? new Date(ticket.fetchedAt) : null
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text(`${ticket.totalUnits} units · ${ticket.skuCount} SKUs · ${ticket.salesOrders} sales orders · ${ticket.stores} stores`, M, M + 38)
    // ⚠️ WHEN IT WAS READ, ON THE PAPER. The ticket is live at the moment it is built and
    // stale the moment it is printed; a sheet found on a bench next week must say so.
    .text(stamp ? `Read live from NetSuite ${stamp.toLocaleString()}` : 'Read live from NetSuite', M, M + 49)

  let y = M + 66

  // ── The problems, before the table ────────────────────────────────────────
  // ⚠️ ABOVE the SKUs, not below. A PO that contributed nothing, or a SKU there is not
  // enough stock for, changes what someone does before they start walking.
  for (const p of (ticket.pos || []).filter((p) => p.verdict !== 'ok')) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(RED)
      .text(WARN + problemLine(p), M, y, { width: W })
    y = doc.y + 3
  }
  if (!ticket.stockKnown) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(RED)
      .text(WARN + 'stock could not be read from NetSuite — the on-hand columns are UNKNOWN, not zero. Nothing here is called short.', M, y, { width: W })
    y = doc.y + 3
  }
  // ⚠️ A TRANSFER AND A SHORTAGE READ DIFFERENTLY, because they are different jobs.
  // Before Offsite Storage was a column, PO 50203208 printed "419 units short" on
  // stock we own — the sheet said buy, when the answer was fetch. Split so the red
  // line only ever means "we do not have these".
  const transfers = (ticket.shortSkus || []).filter((s) => s.coveredByOffsite)
  const shortages = (ticket.shortSkus || []).filter((s) => !s.coveredByOffsite)
  if (shortages.length) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(RED)
      .text(`${WARN}${shortages.length} SKU${shortages.length === 1 ? '' : 's'} short on hand: ${shortages.map((s) => `${s.sku} need ${s.need}, have ${s.have}${s.offsite ? ` (+${s.offsite} offsite)` : ''}`).join(' · ')}`, M, y, { width: W })
    y = doc.y + 3
  }
  if (transfers.length) {
    // Not red, and not a warning word: nothing is missing, something needs moving.
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
      .text(`TRANSFER FROM OFFSITE: ${transfers.length} SKU${transfers.length === 1 ? '' : 's'}, ${transfers.reduce((n, s) => n + s.offsiteCovers, 0)} units — ${transfers.map((s) => `${s.sku} ${s.offsiteCovers}`).join(' · ')}`, M, y, { width: W })
    y = doc.y + 3
  }
  if (y > M + 66) y += 6

  // ── The table ─────────────────────────────────────────────────────────────
  y = header(doc, cols, y, M)
  for (const s of ticket.skus || []) {
    if (y > doc.page.height - M - 40) {
      doc.addPage()
      y = header(doc, cols, M, M)
    }
    y = row(doc, cols, s, y, M, ticket)
  }
  totals(doc, cols, ticket, y, M)
  // ⚠️ totals() draws but returns nothing, so the next section is positioned from the
  // row we just placed rather than from doc.y — which pdfkit leaves wherever the last
  // text() landed, not after the table.
  y += 22

  // ── ⚠️ THE SHORTAGE HALF, only when one was asked for ──────────────────────
  //
  // Nima, 2026-09-11: "i need that bulk pick ticket before teh UI if we can do that."
  // The allocation arrives on the ticket when /api/bulk-pick is called with a rule
  // and a pool; without them this whole block is skipped and the sheet is exactly
  // what it has always been.
  //
  // It prints AFTER the totals because the pull is the same either way — the shortage
  // changes who gets what, not what leaves the shelf.
  if (ticket.allocation) allocationSection(doc, ticket.allocation, M, y)

  // ── Footer ────────────────────────────────────────────────────────────────
  // Two lines of room. The first render clipped the on-hand explanation mid-sentence.
  const foot = doc.page.height - M - 24
  doc.font('Helvetica').fontSize(7).fillColor(GREY)
  const star = (ticket.stockColumns || []).find((c) => c.isOrderLocation)
  doc.text(
    [
      star ? `* ${star.name} is this order's own location.` : '',
      'Quantities are ON HAND — the physical count, not availability, because the orders being picked have already been deducted from available.',
    ].filter(Boolean).join('  '),
    M, foot, { width: doc.page.width - M * 2 },
  )
}

/**
 * ⚠️ THE CUT LIST IS THE POINT OF THIS SECTION, not the verdict banner. The verdict
 * says whether to proceed; the cut list is what someone has to still be holding when
 * they raise the invoice, and it is keyed on the FULFILMENT number because that is
 * what an invoice and an ASN are raised against.
 */
export function allocationSection(doc, a, M, startY) {
  const W = doc.page.width - M * 2
  let y = (startY ?? doc.y ?? M) + 14
  const page = (need) => { if (y > doc.page.height - M - need) { doc.addPage(); y = M } }

  page(70)
  const r = a.ready || {}
  const fg = r.ready === false ? '#a11' : (r.warnings || []).length ? '#8a5a00' : '#1c6b3a'
  const bg = r.ready === false ? '#fdecec' : (r.warnings || []).length ? '#fff4e5' : '#eefaf0'
  const boxH = 20 + ((r.blocks || []).length + (r.warnings || []).length) * 10
  doc.rect(M, y, W, boxH).fillAndStroke(bg, fg)
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(10).text(r.verdict || '', M + 8, y + 6)
  doc.font('Helvetica').fontSize(7)
  let ly = y + 18
  for (const b of r.blocks || []) { doc.text('BLOCKED: ' + b, M + 8, ly, { width: W - 16 }); ly += 10 }
  for (const w of r.warnings || []) { doc.text('- ' + w, M + 8, ly, { width: W - 16 }); ly += 10 }
  doc.fillColor('black')
  y += boxH + 6

  doc.font('Helvetica').fontSize(7).fillColor(GREY)
    .text(`Allocation rule: ${a.rule} · pool: ${a.pool}`
      + (a.strandedUnits ? ` · ${a.strandedUnits} units stranded (too few for any unfilled line)` : ''),
      M, y, { width: W })
  doc.fillColor('black'); y += 14

  const cuts = a.invoiceAdjustments || []
  if (!cuts.length) return
  page(60)
  doc.font('Helvetica-Bold').fontSize(10).text('SHORT — remember these when you invoice', M, y); y += 12
  doc.font('Helvetica').fontSize(7).fillColor(GREY)
    .text('Invoicing the ORDERED quantity on any of these is an overbill the partner will dispute.', M, y, { width: W })
  doc.fillColor('black'); y += 12

  // ⚠️ COLUMNS ARE COMPUTED FROM THE PAGE, NOT HARD-CODED. My first version used
  // landscape offsets on what is usually a PORTRAIT sheet: the SKU ran into ORDERED,
  // and "SKU NOT ON THE IF" started past the right margin and wrapped one letter per
  // line down the edge. Every cell now has an explicit width so nothing can bleed.
  const widths = [0.10, 0.10, 0.10, 0.22, 0.26, 0.08, 0.08, 0.06].map((f) => f * W)
  const c = widths.reduce((acc, w, i) => { acc.push(i === 0 ? M : acc[i - 1] + widths[i - 1]); return acc }, [])
  // ⚠️ TRUNCATED IN CODE, NOT BY pdfkit. `lineBreak: false, ellipsis: true` still
  // wrapped the CFC's 84-character store name onto a second line, which printed over
  // the row beneath it. Measuring and cutting the string is the only reliable way.
  const cell = (i, text, opts = {}) => {
    let t = String(text ?? '')
    const max = widths[i] - 4
    if (doc.widthOfString(t) > max) {
      while (t.length > 1 && doc.widthOfString(t + '\u2026') > max) t = t.slice(0, -1)
      t += '\u2026'
    }
    doc.text(t, c[i], y, { width: max, lineBreak: false, ...opts })
  }

  doc.font('Helvetica-Bold').fontSize(7)
  ;['ORDER', 'IF', 'PO', 'STORE', 'SKU', 'ORD', 'SHIP', 'CUT'].forEach((h, i) => cell(i, h))
  y += 9
  doc.moveTo(M, y).lineTo(M + W, y).stroke(); y += 4
  doc.font('Helvetica').fontSize(7)
  for (const o of cuts) {
    for (const l of o.lines) {
      page(20)
      cell(0, o.order)
      doc.font('Helvetica-Bold'); cell(1, o.iff || '-'); doc.font('Helvetica')
      cell(2, o.po)
      cell(3, o.store)
      cell(4, l.sku)
      cell(5, l.ordered)
      // ⚠️ SHIPPING 0 IS ITSELF THE "whole SKU dropped" signal. A separate marker
      // column said the same thing and was what overflowed the page.
      cell(6, l.shipping)
      doc.fillColor('#c33').font('Helvetica-Bold'); cell(7, `-${l.cut}`)
      doc.fillColor('black').font('Helvetica')
      y += 10
    }
  }
  doc.y = y
}

export function problemLine(p) {
  if (p.verdict === 'missing') return `PO ${p.po} — no sales order in NetSuite carries this number. Check the digits.`
  if (p.verdict === 'allClosed') return `PO ${p.po} — ${p.salesOrders} sales order${p.salesOrders === 1 ? '' : 's'}, all closed. ${p.cancelledUnits} units of cancelled demand, nothing to pick.`
  if (p.verdict === 'empty') return `PO ${p.po} — ${p.salesOrders} open sales order${p.salesOrders === 1 ? '' : 's'}, but no goods lines on them.`
  return ''
}

function header(doc, cols, y, M) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
  let x = M
  for (const c of cols) {
    doc.text(c.label, x, y, { width: c.w - 4, align: c.align })
    x += c.w
  }
  const b = y + 11
  doc.moveTo(M, b).lineTo(x, b).lineWidth(0.8).strokeColor('#000').stroke()
  return b + 4
}

function row(doc, cols, s, y, M, ticket) {
  const short = ticket.stockKnown && s.short > 0
  let x = M
  doc.fontSize(9)
  for (const c of cols) {
    // ⚠️ A short row is red AND carries its number in the SHORT column. Colour alone is
    // not a signal on a sheet that gets photocopied in black and white.
    doc.font(c.bold || (short && c.key === 'short') ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(short && (c.key === 'sku' || c.key === 'short') ? RED : '#000')
      .text(String(c.get(s) ?? ''), x, y, { width: c.w - 4, align: c.align })
    x += c.w
  }
  const b = y + 13
  doc.moveTo(M, b - 2).lineTo(x, b - 2).lineWidth(0.2).strokeColor('#ccc').stroke()
  return b
}

function totals(doc, cols, ticket, y, M) {
  let x = M
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
  for (const c of cols) {
    let v = ''
    if (c.key === 'sku') v = 'TOTAL'
    else if (c.key === 'need') v = ticket.totalUnits
    else if (c.key.startsWith('po:')) v = ticket.pos.find((p) => p.po === c.key.slice(3))?.units || 0
    doc.text(String(v), x, y + 2, { width: c.w - 4, align: c.align })
    x += c.w
  }
}
