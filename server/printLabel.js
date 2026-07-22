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
function buildDcPdf(path, cfg, { poNumber, dc, storeCount }) {
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
    const storeLine = `${stores} ${stores === 1 ? 'STORE' : 'STORES'}`
    // QR carries PO + DC so the Scan Bay resolves both (dcToken format).
    const qrData = `DC:${PO}:${dc || ''}`

    if (cfg.layout === 'compact') {
      const qrSize = cfg.h - MARGIN * 2
      drawQr(doc, qrData, MARGIN, MARGIN, qrSize)
      const tx = MARGIN + qrSize + 8
      const tw = cfg.w - tx - MARGIN
      doc.font('Helvetica-Bold').fontSize(6).text('◆ NAGHEDI · EDI OUT', tx, MARGIN, { width: tw })
      doc.font('Helvetica-Bold').fontSize(11).text(`PO ${PO}`, tx, MARGIN + 9, { width: tw, lineBreak: false })
      if (dc) doc.font('Helvetica-Bold').fontSize(26).text(dc, tx, MARGIN + 22, { width: tw, lineBreak: false })
      doc.font('Helvetica').fontSize(8).text(storeLine, tx, MARGIN + (dc ? 52 : 26), { width: tw })
    } else {
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('◆ NAGHEDI', 0, 26, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(9).text('EDI OUTBOUND · BY DC', 0, 50, { width: cfg.w, align: 'center', characterSpacing: 2 })
      const qrSize = 168
      drawQr(doc, qrData, cx - qrSize / 2, 74, qrSize)
      doc.font('Helvetica-Bold').fontSize(26).text(`PO ${PO}`, 0, 256, { width: cfg.w, align: 'center' })
      if (dc) doc.font('Helvetica-Bold').fontSize(72).text(dc, 0, 292, { width: cfg.w, align: 'center' })
      doc.font('Helvetica-Bold').fontSize(20).text(storeLine, 0, dc ? 392 : 320, { width: cfg.w, align: 'center', characterSpacing: 2 })
    }
    doc.end()
  })
}

function buildPdf(path, cfg, { ifNumber, soNumber, customer, poNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [cfg.w, cfg.h], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)
    if (cfg.wash) doc.rect(0, 0, cfg.w, cfg.h).fill(cfg.wash)
    doc.fillColor('black')

    const IF = String(ifNumber || '')
    // EDI cargo tags reference the customer PO, never the sales order (Nima,
    // 2026-07-21); boutique/ecom tags keep the SO. The QR always encodes the
    // IF — that's the custody scan identity regardless.
    const refLines = (info.refByPo && poNumber
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
    }
    doc.end()
  })
}

export async function printCargoTag(info, size = '2.25x1.25') {
  const cfg = LABELS[size]
  if (!cfg) throw new Error(`unknown label size: ${size}`)
  const kind = info?.kind === 'edi' ? 'edi' : info?.kind === 'dc' ? 'dc' : 'if'
  if (kind === 'if' ? !info?.ifNumber : !info?.poNumber) throw new Error(kind === 'if' ? 'ifNumber required' : 'poNumber required')
  const dir = mkdtempSync(join(tmpdir(), 'cargo-tag-'))
  const stem = String(
    kind === 'edi' ? `edi-${info.poNumber}` :
    kind === 'dc' ? `dc-${info.poNumber}-${info.dc || 'all'}` :
    info.ifNumber,
  ).replace(/[^\w-]/g, '_')
  const path = join(dir, `${stem}-${size}.pdf`)
  const builder = kind === 'edi' ? buildEdiPdf : kind === 'dc' ? buildDcPdf : buildPdf
  await builder(path, cfg, info)
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', cfg.queue, '-o', cfg.media, '-o', 'print-scaling=none', path], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message))
      resolve({ ok: true, size, printer: cfg.queue, detail: stdout.trim() })
    })
  })
}
