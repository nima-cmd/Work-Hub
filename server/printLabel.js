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
    if (cfg.layout === 'compact') {
      // 2.25×1.25: QR left, text column right.
      const qrSize = cfg.h - MARGIN * 2
      drawQr(doc, IF, MARGIN, MARGIN, qrSize)
      const tx = MARGIN + qrSize + 8
      const tw = cfg.w - tx - MARGIN
      doc.font('Helvetica-Bold').fontSize(7).text('◆ NAGHEDI', tx, MARGIN, { width: tw })
      doc.font('Helvetica-Bold').fontSize(18).text(IF, tx, MARGIN + 10, { width: tw })
      doc.font('Helvetica').fontSize(8)
        .text([soNumber, customer, poNumber ? `PO ${poNumber}` : ''].filter(Boolean).join('\n'),
          tx, MARGIN + 32, { width: tw, lineGap: 1 })
    } else {
      // 4×6: centred, big QR — the full cargo tag.
      const cx = cfg.w / 2
      doc.font('Helvetica-Bold').fontSize(18).text('◆ NAGHEDI', 0, 28, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(9).text('CARGO TAG · WAREHOUSE CUSTODY', 0, 52, { width: cfg.w, align: 'center', characterSpacing: 2 })
      const qrSize = 200
      drawQr(doc, IF, cx - qrSize / 2, 78, qrSize)
      doc.font('Helvetica-Bold').fontSize(34).text(IF, 0, 292, { width: cfg.w, align: 'center' })
      doc.font('Helvetica').fontSize(13)
        .text([soNumber, customer, poNumber ? `PO ${poNumber}` : ''].filter(Boolean).join('\n'),
          0, 336, { width: cfg.w, align: 'center', lineGap: 3 })
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
  if (!info?.ifNumber) throw new Error('ifNumber required')
  const dir = mkdtempSync(join(tmpdir(), 'cargo-tag-'))
  const path = join(dir, `${String(info.ifNumber).replace(/[^\w-]/g, '_')}-${size}.pdf`)
  await buildPdf(path, cfg, info)
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', cfg.queue, '-o', cfg.media, '-o', 'print-scaling=none', path], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message))
      resolve({ ok: true, size, printer: cfg.queue, detail: stdout.trim() })
    })
  })
}
