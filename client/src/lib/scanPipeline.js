// scanPipeline.js — turn one multi-page scanned PDF (Brother output) into
// per-document splits, keyed by the QR codes printed on the pages.
//
// The QR is BOTH delimiter and identifier: a page carrying a QR starts a new
// document; QR-less pages attach to the current document until the next QR.
// EDI cargo tags encode `DC:<po>:<abbrev>` (same token Scan Bay decodes today,
// see src/model/dc.js). Boutique orders carry their own QR (format TBD).
//
// Runs entirely client-side: pdfjs rasters each page, BarcodeDetector (jsQR
// fallback) reads the QR, pdf-lib splits the original. Only the final upload is
// server-side (Drive, drive.file scope). Nothing is stored on our server.

import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import jsQR from 'jsqr'
import { PDFDocument } from 'pdf-lib'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

// pdfjs viewport scale 1 == 72 DPI. Scanned QR is small, so we raster generously.
const dpiToScale = (dpi) => dpi / 72

// Render every page of a PDF to an ImageData (RGBA) at the given DPI.
// Returns [{ pageNum, imageData, width, height }].
export async function rasterizePages(pdfBytes, { dpi = 200 } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) })
  const pdf = await loadingTask.promise
  const out = []
  const scale = dpiToScale(dpi)
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    await page.render({ canvasContext: ctx, viewport }).promise
    out.push({
      pageNum: n,
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height,
    })
  }
  await loadingTask.destroy()
  return out
}

// Decode a single QR from an ImageData. Prefers the native BarcodeDetector
// (more robust on skew — same primary Scan Bay uses live), falls back to jsQR.
let _detector
export async function decodeQr(imageData) {
  if ('BarcodeDetector' in window) {
    try {
      _detector ||= new window.BarcodeDetector({ formats: ['qr_code'] })
      // BarcodeDetector wants a bitmap source, not raw ImageData.
      const bmp = await createImageBitmap(imageData)
      const found = await _detector.detect(bmp)
      bmp.close?.()
      if (found[0]?.rawValue) return found[0].rawValue
    } catch { /* fall through to jsQR */ }
  }
  return jsQR(imageData.data, imageData.width, imageData.height)?.data || null
}

// Classify a QR payload into a filing target.
//   EDI (per-DC)   → `DC:<po>:<abbrev>`  → { kind:'edi', po, dc }
//   EDI (PO-level) → bare PO number      → { kind:'edi', po, dc:null }
//   boutique       → (format TBD)        → { kind:'boutique', raw }
// The old EDI labels encode just the PO number with no DC (seen live on the real
// Bloomingdale's scan, pages 49-50: `7527064`, `7776929`) — same PO-level
// fallback Scan Bay's server uses. `knownPos` (a Set of PO strings from the
// loaded orders) disambiguates a bare number from a boutique QR when available;
// without it, an all-digit payload is assumed to be a PO. Refine the boutique
// branch once that QR's real format is known.
export function classifyQr(raw, { knownPos } = {}) {
  const s = String(raw || '').trim()
  const dc = /^DC:([^:]+):(.*)$/.exec(s)
  if (dc) return { kind: 'edi', po: dc[1].trim(), dc: (dc[2] || '').trim() || null, raw: s }
  if (!s) return { kind: 'empty', raw: s }
  if (knownPos ? knownPos.has(s) : /^\d{5,}$/.test(s)) return { kind: 'edi', po: s, dc: null, raw: s }
  return { kind: 'boutique', raw: s } // refine once the boutique format is known
}

// Group pages into documents. A page with a QR opens a new document; QR-less
// pages join the open document. Leading QR-less pages (before the first QR) are
// returned as an `orphan` group so nothing is silently dropped.
//   pageResults: [{ pageNum, qr }]  (qr = decoded string or null)
// → { documents: [{ qr, classify, pageNums:[...] }], orphanPages:[...] }
export function segmentPages(pageResults, { knownPos } = {}) {
  const documents = []
  const orphanPages = []
  let current = null
  for (const { pageNum, qr } of pageResults) {
    if (qr) {
      current = { qr, classify: classifyQr(qr, { knownPos }), pageNums: [pageNum] }
      documents.push(current)
    } else if (current) {
      current.pageNums.push(pageNum)
    } else {
      orphanPages.push(pageNum)
    }
  }
  return { documents, orphanPages }
}

// Split the original PDF into a new PDF containing only the given 1-based pages.
// Returns Uint8Array bytes ready to upload.
export async function splitPdf(pdfBytes, pageNums) {
  const src = await PDFDocument.load(pdfBytes)
  const dst = await PDFDocument.create()
  const copied = await dst.copyPages(src, pageNums.map((n) => n - 1))
  copied.forEach((p) => dst.addPage(p))
  return dst.save()
}

// End-to-end: bytes → per-document splits, decoded + classified.
// Returns { documents:[{ qr, classify, pageNums, bytes }], orphanPages, pageResults }.
export async function processScan(pdfBytes, { dpi = 200, knownPos } = {}) {
  const pages = await rasterizePages(pdfBytes, { dpi })
  const pageResults = []
  for (const p of pages) {
    pageResults.push({ pageNum: p.pageNum, qr: await decodeQr(p.imageData) })
  }
  const { documents, orphanPages } = segmentPages(pageResults, { knownPos })
  for (const doc of documents) doc.bytes = await splitPdf(pdfBytes, doc.pageNums)
  return { documents, orphanPages, pageResults }
}
