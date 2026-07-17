// server/printLabel.js — the 2.25×1.25 paper cargo tag, printed straight to the
// MUNBYN via `lp` (NOT the browser print dialog, which rescales and destroys
// the sizing — Nima's long-standing pain). The recipe here is the one proven
// in the sibling munbyn-label-printer project:
//   • page sized EXACTLY 2.25in × 1.25in (162 × 90pt), no orientation override;
//   • background washed light gray (#F2F2F2) — a pure-white background makes the
//     printer's optical gap sensor cut the job short mid-label;
//   • real content inset ~10pt from the edges (the print head's unprintable margin);
//   • submitted with `lp -o PageSize=2.25x1.25 -o print-scaling=none`.
// Only works where the MUNBYN queue exists (the local iMac at the warehouse) —
// the cloud deploy has no printer, so the route reports that cleanly.
import PDFDocument from 'pdfkit'
import qrcode from 'qrcode-generator'
import { execFile } from 'node:child_process'
import { mkdtempSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRINTER = process.env.MUNBYN_QUEUE || 'MUNBYN_RW401AP_2'
const MEDIA = 'PageSize=2.25x1.25'
const PT = 72
const LABEL_W = 2.25 * PT
const LABEL_H = 1.25 * PT
const WASH = '#F2F2F2'
const MARGIN = 10

// Is the label printer actually reachable from this host? (lpstat -p <queue>)
export function printerAvailable() {
  return new Promise((resolve) => {
    execFile('lpstat', ['-p', PRINTER], (err) => resolve(!err))
  })
}

// Draw the QR by filling one small black square per dark module — reuses the
// same qrcode-generator dep the client label uses, so no image pipeline needed.
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

function buildPdf(path, { ifNumber, soNumber, customer, poNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [LABEL_W, LABEL_H], margin: 0 })
    const out = createWriteStream(path)
    out.on('finish', resolve)
    out.on('error', reject)
    doc.pipe(out)

    doc.rect(0, 0, LABEL_W, LABEL_H).fill(WASH)

    // QR on the left, squared to the printable height; text column to its right.
    const qrSize = LABEL_H - MARGIN * 2
    drawQr(doc, String(ifNumber || ''), MARGIN, MARGIN, qrSize)

    const textX = MARGIN + qrSize + 8
    const textW = LABEL_W - textX - MARGIN
    doc.fillColor('black')
    doc.font('Helvetica-Bold').fontSize(7).text('◆ NAGHEDI', textX, MARGIN, { width: textW })
    doc.font('Helvetica-Bold').fontSize(18).text(String(ifNumber || ''), textX, MARGIN + 10, { width: textW })
    doc.font('Helvetica').fontSize(8)
    const lines = [soNumber, customer, poNumber ? `PO ${poNumber}` : ''].filter(Boolean)
    doc.text(lines.join('\n'), textX, MARGIN + 32, { width: textW, lineGap: 1 })

    doc.end()
  })
}

export async function printPaperLabel(info) {
  if (!info?.ifNumber) throw new Error('ifNumber required')
  const dir = mkdtempSync(join(tmpdir(), 'cargo-tag-'))
  const path = join(dir, `${String(info.ifNumber).replace(/[^\w-]/g, '_')}.pdf`)
  await buildPdf(path, info)
  return new Promise((resolve, reject) => {
    execFile('lp', ['-d', PRINTER, '-o', MEDIA, '-o', 'print-scaling=none', path], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message))
      resolve({ ok: true, printer: PRINTER, detail: stdout.trim() })
    })
  })
}
