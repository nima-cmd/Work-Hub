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
export async function rasterizePages(pdfBytes, { dpi = 200, onProgress } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) })
  const pdf = await loadingTask.promise
  const out = []
  const scale = dpiToScale(dpi)
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress?.(n, pdf.numPages)
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

// Render + decode each page one at a time, discarding the pixels before moving
// on. A 50-page scan at 150 DPI is ~8MB of RGBA per page — holding them all
// (as rasterizePages does) is ~400MB and thrashes the tab, so processScan
// streams instead. Returns [{ pageNum, qr }].
export async function decodePages(pdfBytes, { dpi = 200, onProgress } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) })
  const pdf = await loadingTask.promise
  const scale = dpiToScale(dpi)
  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const results = []
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress?.(n, pdf.numPages)
    const page = await pdf.getPage(n)
    const viewport = page.getViewport({ scale })
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    // Trust BarcodeDetector when present (15/15 on the real scan, and the live
    // Scan Bay camera relies on it too) — running a full-page jsQR pass on every
    // QR-less continuation page as well roughly doubles the time for no gain.
    // jsQR is the fallback only where BarcodeDetector isn't available.
    let qr = null
    if (detector) {
      try { qr = (await detector.detect(canvas))[0]?.rawValue || null } catch { /* skip page */ }
    } else {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      qr = jsQR(img.data, img.width, img.height)?.data || null
    }
    results.push({ pageNum: n, qr })
    page.cleanup?.()
  }
  await loadingTask.destroy()
  return results
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

// Copy the given 1-based pages out of an already-loaded PDFDocument into fresh
// PDF bytes. Reuse one loaded source across many splits — loading a large
// scanned PDF is the expensive part.
async function copyPagesOut(srcDoc, pageNums) {
  const dst = await PDFDocument.create()
  const copied = await dst.copyPages(srcDoc, pageNums.map((n) => n - 1))
  copied.forEach((p) => dst.addPage(p))
  return dst.save()
}

// Split the original PDF into a new PDF containing only the given 1-based pages.
// Convenience for one-off callers; processScan loads the source once instead.
export async function splitPdf(pdfBytes, pageNums) {
  return copyPagesOut(await PDFDocument.load(pdfBytes), pageNums)
}

// Base64-encode bytes in chunks (String.fromCharCode on the whole array blows
// the call stack for multi-MB splits).
export function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

// End-to-end: bytes → per-document splits, decoded + classified. onProgress is
// called with { phase:'raster'|'split', page, total } so the UI can show both
// the (slow) rasterize pass and the split pass.
// Returns { documents:[{ qr, classify, pageNums, bytes }], orphanPages,
// orphanBytes, pageResults }. orphanBytes = the leading QR-less pages (the
// signed Master BOL) already split, or null.
export async function processScan(pdfBytes, { dpi = 200, knownPos, onProgress } = {}) {
  const pageResults = await decodePages(pdfBytes, {
    dpi,
    onProgress: (page, total) => onProgress?.({ phase: 'raster', page, total }),
  })
  const { documents, orphanPages } = segmentPages(pageResults, { knownPos })

  // Load the (large) source ONCE and copy pages out of it for every split.
  const srcDoc = await PDFDocument.load(pdfBytes)
  const total = documents.length + (orphanPages.length ? 1 : 0)
  let done = 0
  for (const doc of documents) {
    onProgress?.({ phase: 'split', page: ++done, total })
    doc.bytes = await copyPagesOut(srcDoc, doc.pageNums)
  }
  let orphanBytes = null
  if (orphanPages.length) {
    onProgress?.({ phase: 'split', page: ++done, total })
    orphanBytes = await copyPagesOut(srcDoc, orphanPages)
  }
  return { documents, orphanPages, orphanBytes, pageResults }
}
