// server/printLabel.js — cargo tags printed STRAIGHT to their printer via `lp`,
// no browser dialog (selecting printer + paper size is the thing that kept
// breaking it). Two sizes, two printers:
//   • '4x6'       → the warehouse Zebra ("Thermal Printer", ZebraZT411),
//                   4×6 thermal stock, media w288h432 (its native default);
//   • '2.25x1.25' → the MUNBYN (MUNBYN_RW401AP_2), 2.25×1.25 paper labels.
// Both queues live on the warehouse iMac; the cloud deploy has neither, so the
// availability check reports which sizes are printable and the UI hides the rest.
//
// MUNBYN quirk baked in (proven in the sibling munbyn-label-printer repo): a
// pure-white background makes its gap sensor cut the job short, so the 2.25
// label gets a faint gray wash + inset. The Zebra has no such issue, so 4×6
// stays clean white.
import PDFDocument from 'pdfkit'
import qrcode from 'qrcode-generator'
import { upcBars } from '../src/model/upcBarcode.js'
import { execFile } from 'node:child_process'
import { mkdtempSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PT = 72
export const LABELS = {
  '4x6': {
    queue: process.env.THERMAL_QUEUE || 'ZebraZT411',
    media: process.env.THERMAL_MEDIA || 'PageSize=w288h432',
    w: 4 * PT, h: 6 * PT, wash: null, layout: 'full',
  },
  '2.25x1.25': {
    queue: process.env.MUNBYN_QUEUE || 'MUNBYN_RW401AP_2',
    media: 'PageSize=2.25x1.25',
    w: 2.25 * PT, h: 1.25 * PT, wash: '#F2F2F2', layout: 'compact',
  },
}
const MARGIN = 10

function queueExists(queue) {
  return new Promise((resolve) => execFile('lpstat', ['-p', queue], (err) => resolve(!err)))
}

// Which sizes can actually print from this host right now.
export async function availableSizes() {
  const out = {}
  for (const [size, cfg] of Object.entries(LABELS)) out[size] = await queueExists(cfg.queue)
  return out
}

function drawQr(doc, text, x, y, size) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const cell = size / count
  doc.fillColor('black')
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) doc.rect(x + c * cell, y + r * cell, cell, cell).fill()
    }
  }
}

// EDI outbound carton label (Nima, 2026-07-21): ONE label per customer PO on
// the way out — the PO number, how many stores it splits into (the SO fan-out
// count), and where the goods came from (from-stock or the inbound supply PO).
function buildEdiPdf(path, cfg, { poNumber, partner, storeCount, supplyPo, fromStock }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    if (cfg.wash) doc.rect(0, 0, cfg.w, cfg.h).fill(cfg.wash)
    doc.fillColor('black')

    const PO = String(poNumber || '')
    const stores = Number(storeCount) || 0
    const supply = fromStock ? 'FROM STOCK' : (supplyPo ? `SUPPLY PO ${supplyPo}` : null)

    if (cfg.layout === 'compact') {
      // 2.25×1.25 MUNBYN: QR left (encodes the PO), tight text column right.
      const qrSize = 62
      const top = (cfg.h - qrSize) / 2
      drawQr(doc, PO, MARGIN, top, qrSize)
      const tx = MARGIN + qrSize + 7
      const tw = cfg.w - tx - MARGIN
      let y = MARGIN
      doc.font('Helvetica-Bold').fontSize(6).text('◆ NAGHEDI · EDI OUT', tx, y, { width: tw }); y += 9
      doc.font('Helvetica-Bold').fontSize(13).text(PO, tx, y, { width: tw, lineBreak: false }); y += 16
      if (partner) { doc.font('Helvetica').fontSize(7).text(partner, tx, y, { width: tw, lineBreak: false }); y += 10 }
      doc.font('Helvetica-Bold').fontSize(11).text(`${stores} ${stores === 1 ? 'STORE' : 'STORES'}`, tx, y, { width: tw }); y += 13
      if (supply) doc.font('Helvetica').fontSize(7).text(supply, tx, y, { width: tw, lineBreak: false })
    } else {
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('◆ NAGHEDI', 0, 28, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(9).text('EDI OUTBOUND · CUSTOMER PO', 0, 52, { width: cfg.w, align: 'center', characterSpacing: 2 })
      const qrSize = 180
      drawQr(doc, PO, cx - qrSize / 2, 78, qrSize)
      doc.font('Helvetica-Bold').fontSize(30).text(`PO ${PO}`, 0, 270, { width: cfg.w, align: 'center' })
      if (partner) doc.font('Helvetica').fontSize(14).text(partner, 0, 308, { width: cfg.w, align: 'center' })
      doc.font('Helvetica-Bold').fontSize(40).text(`${stores}`, 0, 336, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(11).text(stores === 1 ? 'STORE' : 'STORES', 0, 382, { width: cfg.w, align: 'center', characterSpacing: 3 })
      doc.moveTo(24, cfg.h - 44).lineTo(cfg.w - 24, cfg.h - 44).lineWidth(2).stroke()
      doc.font('Helvetica-Bold').fontSize(12).text(supply || 'SUPPLY: —', 0, cfg.h - 34, { width: cfg.w, align: 'center', characterSpacing: 1 })
    }
    doc.end()
  })
}

// Per-DC consolidation tag (Nima, 2026-07-21): one label per distribution
// center per customer PO — PO number, the DC abbreviation, and how many stores
// route through that DC. References the PO only (no IF); QR encodes the PO.
function buildDcPdf(path, cfg, { poNumber, dc, storeCount, customer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    if (cfg.wash) doc.rect(0, 0, cfg.w, cfg.h).fill(cfg.wash)
    doc.fillColor('black')

    const PO = String(poNumber || '')
    const stores = Number(storeCount) || 0
    // Store count is only shown when we actually know it (member-parsed tags);
    // routing-feed/scan-derived DCs have no store count, so the line is omitted
    // rather than printing a misleading "0 STORES".
    const storeLine = stores > 0 ? `${stores} ${stores === 1 ? 'STORE' : 'STORES'}` : ''
    // QR carries PO + DC so the Scan Bay resolves both (dcToken format).
    const qrData = `DC:${PO}:${dc || ''}`

    if (cfg.layout === 'compact') {
      const qrSize = cfg.h - MARGIN * 2
      drawQr(doc, qrData, MARGIN, MARGIN, qrSize)
      const tx = MARGIN + qrSize + 8
      const tw = cfg.w - tx - MARGIN
      doc.font('Helvetica-Bold').fontSize(6).text('◆ NAGHEDI · EDI OUT', tx, MARGIN, { width: tw })
      if (customer) doc.font('Helvetica-Bold').fontSize(7).text(customer, tx, MARGIN + 8, { width: tw, lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(11).text(`PO ${PO}`, tx, MARGIN + 17, { width: tw, lineBreak: false })
      if (dc) doc.font('Helvetica-Bold').fontSize(24).text(dc, tx, MARGIN + 30, { width: tw, lineBreak: false })
      if (storeLine) doc.font('Helvetica').fontSize(8).text(storeLine, tx, MARGIN + (dc ? 58 : 32), { width: tw })
    } else {
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('◆ NAGHEDI', 0, 26, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(9).text('EDI OUTBOUND · BY DC', 0, 50, { width: cfg.w, align: 'center', characterSpacing: 2 })
      if (customer) doc.font('Helvetica-Bold').fontSize(13).text(customer, 0, 62, { width: cfg.w, align: 'center' })
      const qrSize = 168
      drawQr(doc, qrData, cx - qrSize / 2, 82, qrSize)
      doc.font('Helvetica-Bold').fontSize(26).text(`PO ${PO}`, 0, 262, { width: cfg.w, align: 'center' })
      if (dc) doc.font('Helvetica-Bold').fontSize(68).text(dc, 0, 296, { width: cfg.w, align: 'center' })
      if (storeLine) doc.font('Helvetica-Bold').fontSize(20).text(storeLine, 0, dc ? 392 : 324, { width: cfg.w, align: 'center', characterSpacing: 2 })
    }
    doc.end()
  })
}

// ── The BOL tag ─────────────────────────────────────────────────────────────
//
// ⚠️ THE PAYLOAD IS THE BOL NUMBER AND NOTHING ELSE (Nima, 2026-09-03: "the cargo
// tag doesn't tell you its a bol though does it"). Three jobs, one symbol:
//   1. it SAYS the page is a bill of lading — a `DC:<po>:<dc>` cargo tag cannot
//   2. the scan pipeline resolves PO/DC from `bol_registry`, a lookup not a parse
//   3. it wedge-scans straight into NetSuite's BOL field for the ASN, which is the
//      typing this was built to remove
//
// The PO and DC are still PRINTED, because a human holding the page needs them and
// the number alone means nothing across a desk.
function buildBolTagPdf(path, cfg, { bolNumber, poNumber, dc, partner }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    if (cfg.wash) doc.rect(0, 0, cfg.w, cfg.h).fill(cfg.wash)
    doc.fillColor('black')

    const BOL = String(bolNumber || '')
    const PO = String(poNumber || '')

    if (cfg.layout === 'compact') {
      // ⚠️ THE QR IS DELIBERATELY SMALLER THAN THE LABEL IS TALL. At the obvious
      // `h - 2*MARGIN` it left a 64pt text column, and `NB1731277` at 13pt needs
      // ~70pt — so the number WRAPPED and its last digit landed on top of the PO
      // line. A BOL tag whose BOL number is unreadable is worse than no tag. The
      // payload is 9 characters (a 21-module symbol), so the smaller code still has
      // ample module size on a 2.25in label; the text is what was starved.
      const qrSize = cfg.h - MARGIN * 2 - 16
      drawQr(doc, BOL, MARGIN, MARGIN + 8, qrSize)
      const tx = MARGIN + qrSize + 7
      const tw = cfg.w - tx - MARGIN + 4
      doc.font('Helvetica-Bold').fontSize(5.5).text('BILL OF LADING', tx, MARGIN, { width: tw, characterSpacing: 1 })
      if (partner) doc.font('Helvetica').fontSize(7).text(partner, tx, MARGIN + 8, { width: tw, lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(12).text(BOL, tx, MARGIN + 17, { width: tw, lineBreak: false })
      doc.font('Helvetica').fontSize(7.5).text(`PO ${PO}`, tx, MARGIN + 32, { width: tw, lineBreak: false })
      if (dc) doc.font('Helvetica-Bold').fontSize(9).text(`DC ${dc}`, tx, MARGIN + 42, { width: tw, lineBreak: false })
    } else {
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('BILL OF LADING', 0, 26, { width: cfg.w, align: 'center', characterSpacing: 2 })
      if (partner) doc.font('Helvetica').fontSize(13).text(partner, 0, 50, { width: cfg.w, align: 'center' })
      const qrSize = 168
      drawQr(doc, BOL, cx - qrSize / 2, 72, qrSize)
      doc.font('Helvetica-Bold').fontSize(30).text(BOL, 0, 252, { width: cfg.w, align: 'center' })
      doc.font('Helvetica-Bold').fontSize(22).text(`PO ${PO}`, 0, 292, { width: cfg.w, align: 'center' })
      if (dc) doc.font('Helvetica-Bold').fontSize(46).text(`DC ${dc}`, 0, 322, { width: cfg.w, align: 'center' })
    }
    doc.end()
  })
}

function buildPdf(path, cfg, info) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    drawTag(doc, cfg, info)
    doc.end()
  })
}

// The tag itself, drawn onto a page that already exists — so one label and a
// fifty-label sheet share ONE implementation and cannot drift apart.
function drawTag(doc, cfg, { ifNumber, soNumber, customer, poNumber, refByPo, shippedOn, cartons }) {
  {
    if (cfg.wash) doc.rect(0, 0, cfg.w, cfg.h).fill(cfg.wash)
    doc.fillColor('black')

    const IF = String(ifNumber || '')
    // EDI cargo tags reference the customer PO, never the sales order (Nima,
    // 2026-07-21); boutique/ecom tags keep the SO. The QR always encodes the
    // IF — that's the custody scan identity regardless.
    const refLines = (refByPo && poNumber
      ? [`PO ${poNumber}`, customer]
      : [soNumber, customer, poNumber ? `PO ${poNumber}` : '']).filter(Boolean)
    if (cfg.layout === 'compact') {
      // 2.25×1.25: QR left, text column right.
      const qrSize = cfg.h - MARGIN * 2
      drawQr(doc, IF, MARGIN, MARGIN, qrSize)
      const tx = MARGIN + qrSize + 8
      const tw = cfg.w - tx - MARGIN
      doc.font('Helvetica-Bold').fontSize(7).text('◆ NAGHEDI', tx, MARGIN, { width: tw })
      doc.font('Helvetica-Bold').fontSize(18).text(IF, tx, MARGIN + 10, { width: tw })
      doc.font('Helvetica').fontSize(8)
        .text(refLines.join('\n'), tx, MARGIN + 32, { width: tw, lineGap: 1 })
      // ⚠️ The ship date is the whole point of a retro tag: it is how Nima finds the
      // matching paperwork in the pile. Bottom-right so it never collides with the
      // reference block, which is variable height.
      if (shippedOn) {
        doc.font('Helvetica-Bold').fontSize(7)
          .text(`SHIPPED ${shippedOn}${cartons ? ` · ${cartons} ctn` : ''}`,
            tx, cfg.h - MARGIN - 8, { width: tw })
      }
    } else {
      // 4×6: centred, big QR — the full cargo tag.
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('◆ NAGHEDI', 0, 28, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(9).text('CARGO TAG · WAREHOUSE CUSTODY', 0, 52, { width: cfg.w, align: 'center', characterSpacing: 2 })
      const qrSize = 200
      drawQr(doc, IF, cx - qrSize / 2, 78, qrSize)
      doc.font('Helvetica-Bold').fontSize(34).text(IF, 0, 292, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(13)
        .text(refLines.join('\n'), 0, 336, { width: cfg.w, align: 'center', lineGap: 3 })
      doc.moveTo(24, cfg.h - 34).lineTo(cfg.w - 24, cfg.h - 34).lineWidth(2).stroke()
      doc.font('Helvetica').fontSize(8)
        .text('SCAN OUT → WAREHOUSE', 24, cfg.h - 26, { width: cfg.w - 48, align: 'left', characterSpacing: 1, continued: false })
      doc.text('SCAN IN → RETURNED', 24, cfg.h - 26, { width: cfg.w - 48, align: 'right', characterSpacing: 1 })
      if (shippedOn) {
        doc.font('Helvetica-Bold').fontSize(12)
          .text(`SHIPPED ${shippedOn}${cartons ? `  ·  ${cartons} carton${cartons === 1 ? '' : 's'}` : ''}`,
            0, 380, { width: cfg.w, align: 'center' })
      }
    }
  }
}

// ── A sheet of tags, one per page, for a whole ship date ────────────────────
//
// Nima, 2026-08-14: "if i wanted to print a qr code for everything on july 31. This
// would both give me the code i need for the scan and also help me find the paper
// work and organize them in the correct method."
//
// ⚠️ ONE multi-page PDF and ONE `lp` job, not N jobs. A busy day is 50 fulfilments
// (2026-07-30 was exactly that), and fifty separate spool jobs is fifty chances for
// the queue to jam — which has already silently killed printing here for three days
// once. One job also keeps the tags in a single predictable order to match against
// the paperwork.
export async function buildTagSheet(path, cfg, items = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0, autoFirstPage: false })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    for (const it of items) {
      doc.addPage({ size: [cfg.w, cfg.h], margin: 0 })
      drawTag(doc, cfg, it)
    }
    doc.end()
  })
}

export async function makeTagSheet(items = [], size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size: ${size}`)
  if (!items.length) throw new Error('no fulfilments to print')
  const dir = mkdtempSync(join(tmpdir(), 'tag-sheet-'))
  const path = join(dir, `tags-${size}.pdf`)
  await buildTagSheet(path, cfg, items)
  return { path, cfg, count: items.length }
}

export async function printTagSheet(items = [], size = '2.25x1.25') {
  const { path, cfg, count } = await makeTagSheet(items, size)
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', cfg.queue, '-o', cfg.media, '-o', 'print-scaling=none', path], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message))
      resolve({ ok: true, size, count, printer: cfg.queue, detail: stdout.trim() })
    })
  })
}

// Build a BOL tag to a temp file WITHOUT printing — so it can be looked at before
// it reaches a roll of adhesive labels that then go on freight paperwork.
export async function makeBolTag(info, size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size: ${size}`)
  if (!info?.bolNumber) throw new Error('bolNumber required')
  const dir = mkdtempSync(join(tmpdir(), 'bol-tag-'))
  const path = join(dir, `${String(info.bolNumber).replace(/[^\w-]/g, '_')}-${size}.pdf`)
  await buildBolTagPdf(path, cfg, info)
  return path
}

export async function printCargoTag(info, size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size: ${size}`)
  const kind = info?.kind === 'edi' ? 'edi' : info?.kind === 'dc' ? 'dc' : info?.kind === 'bol' ? 'bol' : 'if'
  if (kind === 'bol' && !info?.bolNumber) throw new Error('bolNumber required')
  if (kind !== 'bol' && (kind === 'if' ? !info?.ifNumber : !info?.poNumber)) throw new Error(kind === 'if' ? 'ifNumber required' : 'poNumber required')
  const dir = mkdtempSync(join(tmpdir(), 'cargo-tag-'))
  const stem = String(
    kind === 'edi' ? `edi-${info.poNumber}` :
    kind === 'dc' ? `dc-${info.poNumber}-${info.dc || 'all'}` :
    kind === 'bol' ? `bol-${info.bolNumber}` :
    info.ifNumber,
  ).replace(/[^\w-]/g, '_')
  const path = join(dir, `${stem}-${size}.pdf`)
  const builder = kind === 'edi' ? buildEdiPdf : kind === 'dc' ? buildDcPdf : kind === 'bol' ? buildBolTagPdf : buildPdf
  await builder(path, cfg, info)
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', cfg.queue, '-o', cfg.media, '-o', 'print-scaling=none', path], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message))
      resolve({ ok: true, size, printer: cfg.queue, detail: stdout.trim() })
    })
  })
}

// ── The hang tag ────────────────────────────────────────────────────────────
//
// ⚠️ THE PHOTO WAS THE INFORMATION, NOT THE SIZE — Nima, 2026-08-31: "we need it to fit
// on the label pritner per what we have for qr codeds that was a picture to show you
// information on the tags." My first cut invented a 2.25in SQUARE stock from the shape of
// the tag in the photograph. It prints on the SAME 2.25x1.25 roll as the QR cargo tags.
//
// Five fields, in the order the photographed tag carries them: product name, style
// number, colour, the UPC-A symbol with its human-readable digits, then the retail
// price. src/model/hangTag.js holds which database column each comes from.
//
// ── ⚠️ WHAT FITTING 1.25in HIGH ACTUALLY COSTS ──────────────────────────────
//
// WIDTH IS FINE. A nominal UPC-A is 1.469in including its quiet zones, against 2.11in of
// usable width — so the symbol prints at full nominal size (X-dimension 0.013in, dead
// centre of the 0.0104–0.0260 GS1 range) and is centred with room to spare.
//
// HEIGHT IS THE COMPROMISE, and it is worth saying out loud. A nominal UPC-A is 0.816in
// tall. Four lines of text plus bars do not fit in 1.25in at that height, so the bars are
// TRUNCATED to about 0.47in — roughly 58% of nominal. Truncation is normal on small
// retail tags and scans fine on a handheld at the till, but it is formally out of GS1
// height spec and it degrades OMNIDIRECTIONAL scanning (the kind a fixed slot scanner
// does). If a partner ever rejects the tag on height, the fix is a taller label, not a
// change here.

/** GS1 nominal X-dimension for UPC-A, in points. 0.013in x 72. */
const UPC_X_PT = 0.013 * PT

/**
 * Draw a UPC-A symbol, centred in the width given.
 *
 * ⚠️ BAR WIDTHS ARE NOT ROUNDED. Rounding each of 95 modules to a whole point
 * independently makes the symbol drift narrower than its guard spacing implies, and
 * scanners read the RATIOS between bars, not their absolute widths. The module width
 * stays fractional and every bar is placed from its module offset.
 *
 * ⚠️ Quiet zones are inside the returned block width. A barcode butted against text or
 * the label edge is the commonest reason a correctly-encoded tag will not read.
 *
 * Returns the geometry (so the caller can put the lead and check digits in the quiet
 * zones where a UPC prints them), or false for a UPC that fails its own check digit —
 * upcBars refuses those, and a tag with a gap where the bars go still gets attached to a
 * bag.
 */
function drawUpc(doc, upc, { cx, y, h, maxW }) {
  const geo = upcBars(upc)
  if (!geo) return false
  // Nominal size, shrunk only if the label is too narrow for it.
  const mod = Math.min(UPC_X_PT, maxW / geo.totalModules)
  const blockW = geo.totalModules * mod
  const x0 = cx - blockW / 2
  const barsLeft = x0 + geo.quiet * mod
  const shortH = h * 0.82   // the guards descend past the data bars
  for (const b of geo.bars) {
    doc.rect(barsLeft + b.at * mod, y, b.width * mod, b.tall ? h : shortH).fill('#000')
  }
  return { mod, x0, blockW, barsLeft, quietW: geo.quiet * mod, symbolW: geo.modules * mod }
}

function drawHangTag(doc, cfg, tag) {
  const pad = 5
  const innerW = cfg.w - pad * 2
  const cx = cfg.w / 2
  let y = pad

  doc.fillColor('#000')
  // 1. Product name. ⚠️ height:8 clips rather than wrapping onto a second line — a long
  // name pushing the barcode down would break the layout silently, and a clipped name is
  // still identifiable next to the style number underneath it.
  doc.font('Helvetica').fontSize(7)
  doc.text(tag.name, pad, y, { width: innerW, align: 'center', height: 8, ellipsis: true, lineBreak: false })
  y += 8

  // 2. Style number — the thing Nima reads first.
  doc.font('Helvetica-Bold').fontSize(8)
  doc.text(tag.style, pad, y, { width: innerW, align: 'center', lineBreak: false })
  y += 9

  // 3. Colour.
  doc.font('Helvetica').fontSize(7)
  doc.text(tag.color, pad, y, { width: innerW, align: 'center', height: 8, ellipsis: true, lineBreak: false })
  y += 10

  // 4. The symbol, then its digits.
  const barH = 32
  const g = drawUpc(doc, tag.upc, { cx, y, h: barH, maxW: innerW })
  if (!g) return false
  y += barH + 0.5

  const h = tag.human
  doc.font('Helvetica').fontSize(6)
  // ⚠️ The lead and check digits sit OUTSIDE the bars, in the quiet zones — that is where
  // a UPC prints them, and putting all twelve under the bars would read as an EAN-13.
  doc.text(h.lead, g.x0, y, { width: g.quietW, align: 'center', lineBreak: false })
  doc.text(h.check, g.x0 + g.blockW - g.quietW, y, { width: g.quietW, align: 'center', lineBreak: false })
  doc.text(`${h.left}    ${h.right}`, g.barsLeft, y, { width: g.symbolW, align: 'center', lineBreak: false })
  y += 8

  // 5. The retail price.
  doc.font('Helvetica-Bold').fontSize(10)
  doc.text(tag.price, pad, y, { width: innerW, align: 'center', lineBreak: false })
  return true
}

/** One tag per page, so a run feeds as individual labels off the roll. */
export async function buildHangTagPdf(path, cfg, tags = []) {
  const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0, autoFirstPage: false })
  const stream = createWriteStream(path)
  doc.pipe(stream)
  const drawn = []
  for (const t of tags) {
    doc.addPage({ size: [cfg.w, cfg.h], margin: 0 })
    if (drawHangTag(doc, cfg, t)) drawn.push(t.upc)
  }
  doc.end()
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej) })
  return { path, drawn }
}

/** ⚠️ Defaults to the SAME stock as the QR cargo tags — Nima's constraint, not a guess. */
export async function makeHangTagSheet(tags = [], size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size ${size}`)
  if (!tags.length) throw new Error('no tags to print')
  const dir = mkdtempSync(join(tmpdir(), 'hangtag-'))
  const { path, drawn } = await buildHangTagPdf(join(dir, `hang-tags-${tags.length}.pdf`), cfg, tags)
  return { path, drawn }
}

export async function printHangTags(tags = [], size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size ${size}`)
  const { path, drawn } = await makeHangTagSheet(tags, size)
  if (!(await queueExists(cfg.queue))) {
    // ⚠️ Names the queue: "printing failed" sends someone hunting.
    throw new Error(`printer queue ${cfg.queue} is not available on this host`)
  }
  // ⚠️ THE SAME lp FLAGS AS THE QR CARGO TAG, print-scaling=none INCLUDED — and that flag
  // is not cosmetic here (Nima, 2026-08-31: "i dont know if the pritner will print
  // correctly if not transmitted like the QR ones are"). He was right to ask. Without it
  // CUPS may scale the PDF to fit the page, and scaling a UPC-A changes its X-DIMENSION,
  // which is the one measurement a scanner depends on: a symbol shrunk below 0.0104in
  // stops reading, and one silently enlarged no longer matches the quiet zones it was
  // laid out with. A QR code survives being scaled; a linear barcode does not.
  //
  // A test asserts these flags stay identical to printTagSheet's, because the day they
  // differ is the day tags come off the roll unreadable for a reason nobody looks for.
  await new Promise((res, rej) => execFile(
    'lp', ['-d', cfg.queue, '-o', cfg.media, '-o', 'print-scaling=none', path],
    (err, out, stderr) => (err ? rej(new Error(stderr || err.message)) : res(out)),
  ))
  return { path, printed: drawn.length, queue: cfg.queue, size }
}
