// Throwaway feasibility harness for the Scan→Drive pipeline. Not part of the
// app — served at /spike.html via Vite. Generates scan-like multi-page PDFs
// (clean / skewed / low-DPI QR) and runs them through scanPipeline, then lets
// me load Nima's REAL sample scan and run the same checks. Delete before merge.

import qrcode from 'qrcode-generator'
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import { processScan } from '../lib/scanPipeline.js'

// SPIKE-ONLY: the automated Browser pane keeps the tab hidden, which pauses
// requestAnimationFrame and stalls pdfjs's render loop. Route rAF through
// setTimeout + spoof visibility so the harness runs headless. Harmless in a
// real foreground browser; NOT needed in the production pipeline.
if (document.hidden) {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0)
  try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }) } catch { /* */ }
  try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }) } catch { /* */ }
}

const root = document.getElementById('root')
const log = (html) => { const d = document.createElement('div'); d.innerHTML = html; root.appendChild(d) }

// ── synthetic scan builder ──────────────────────────────────────────────────
// Render a QR to PNG bytes. `modulePx` low = coarse (simulates low-DPI scan).
function qrPng(text, modulePx = 6) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make()
  const n = qr.getModuleCount(), quiet = 4
  const size = (n + quiet * 2) * modulePx
  const c = document.createElement('canvas'); c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#000'
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * modulePx, (r + quiet) * modulePx, modulePx, modulePx)
  }
  const b64 = c.toDataURL('image/png').split(',')[1]
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
}

// pages: [{ qr?: 'DC:..', text: 'label', skew?: deg, modulePx?: n }]
async function buildScan(pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const p of pages) {
    const page = doc.addPage([612, 792]) // US Letter @72dpi
    page.drawText(p.text, { x: 40, y: 740, size: 14, font, color: rgb(0, 0, 0) })
    if (p.qr) {
      const png = await doc.embedPng(qrPng(p.qr, p.modulePx ?? 6))
      const dim = 150
      page.drawImage(png, { x: 220, y: 400, width: dim, height: dim, rotate: degrees(p.skew || 0) })
      page.drawText('QR: ' + p.qr, { x: 40, y: 380, size: 9, font, color: rgb(0.4, 0.4, 0.4) })
    }
    page.drawText(p.qr ? '[new document - QR]' : '(continuation page - no QR)', { x: 40, y: 60, size: 10, font, color: rgb(0.5, 0.5, 0.5) })
  }
  return doc.save()
}

function renderResult(title, res, expected) {
  let html = `<h3>${title}</h3><table><tr><th>page</th><th>decoded QR</th></tr>`
  for (const pr of res.pageResults) {
    const cls = pr.qr ? 'ok' : 'muted'
    html += `<tr><td>${pr.pageNum}</td><td class="${cls}">${pr.qr ? esc(pr.qr) : '— (continuation/undecoded)'}</td></tr>`
  }
  html += `</table>`
  html += `<b>${res.documents.length} document(s)</b>` + (res.orphanPages.length ? ` · <span class="warn">${res.orphanPages.length} orphan page(s) before first QR</span>` : '')
  html += '<ul>'
  for (const d of res.documents) {
    const c = d.classify
    const label = c.kind === 'edi' ? `EDI · PO ${esc(c.po)}${c.dc ? ' · DC ' + esc(c.dc) : ''}` : c.kind === 'boutique' ? `boutique · ${esc(c.raw)}` : c.kind
    html += `<li>${label} — pages [${d.pageNums.join(', ')}] — split ${d.bytes.length.toLocaleString()} bytes</li>`
  }
  html += '</ul>'
  if (expected != null) {
    const got = res.documents.length
    const pass = got === expected && res.documents.every((d) => d.classify.kind !== 'empty')
    html += `<p class="${pass ? 'ok' : 'bad'}">${pass ? '✓ PASS' : '✗ FAIL'} — expected ${expected} document(s), got ${got}</p>`
  }
  log(html)
}
const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))

// A realistic EDI scan: signed BOL + its DC's IFs, then a 2nd DC, then boutique.
const SCENARIO = [
  { qr: 'DC:7527064:CG', text: "SIGNED BOL - Bloomingdale's CG" },
  { text: 'IF7264 - store 001' },
  { text: 'IF7265 - store 002' },
  { qr: 'DC:7527064:SC', text: "SIGNED BOL - Bloomingdale's SC" },
  { text: 'IF7266 - store 010' },
  { qr: 'BQ:SAKS-BOUTIQUE-99123', text: 'Boutique order - Saks 5th Ave' },
  { text: 'packing slip (continuation)' },
]

async function runSynthetic() {
  root.innerHTML = '<h1>Scan → Drive feasibility spike</h1>'
  mountControls()
  for (const [title, opts] of [
    ['Clean (200 DPI, no skew)', { modulePx: 6, skew: 0, dpi: 200 }],
    ['Skewed 5°', { modulePx: 6, skew: 5, dpi: 200 }],
    ['Skewed 12°', { modulePx: 6, skew: 12, dpi: 200 }],
    ['Coarse QR + 150 DPI (low-res scan proxy)', { modulePx: 3, skew: 3, dpi: 150 }],
    ['Worst case: coarse + 12° + 120 DPI', { modulePx: 2, skew: 12, dpi: 120 }],
  ]) {
    log(`<p class="muted">building & processing: ${title}…</p>`)
    try {
      const pages = SCENARIO.map((p) => (p.qr ? { ...p, skew: opts.skew, modulePx: opts.modulePx } : p))
      const bytes = await buildScan(pages)
      const res = await processScan(bytes, { dpi: opts.dpi })
      renderResult(title, res, 3)
    } catch (err) {
      log(`<p class="bad">✗ ${esc(title)} — ${esc(err.message)}</p><pre class="bad">${esc(err.stack || '')}</pre>`)
    }
  }
  log('<p class="muted">Synthetic runs done. Load a real sample below to validate against a physical Brother scan.</p>')
}

function mountControls() {
  const bar = document.createElement('div')
  bar.innerHTML = `<button id="rerun">↻ Re-run synthetic</button>
    <label style="margin-left:12px">Real sample PDF: <input id="file" type="file" accept="application/pdf"></label>
    <label style="margin-left:8px">DPI <input id="dpi" type="number" value="200" style="width:70px"></label>`
  root.appendChild(bar)
  bar.querySelector('#rerun').onclick = runSynthetic
  bar.querySelector('#file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return
    const dpi = Number(bar.querySelector('#dpi').value) || 200
    log(`<p class="muted">processing real sample “${esc(f.name)}” at ${dpi} DPI…</p>`)
    const bytes = new Uint8Array(await f.arrayBuffer())
    try {
      const res = await processScan(bytes, { dpi })
      renderResult(`REAL: ${f.name} @ ${dpi} DPI`, res, null)
    } catch (err) { log(`<p class="bad">✗ ${esc(err.message)}</p>`) }
  }
}

// ?noauto skips the synthetic auto-run so a manual/real-sample run has the main
// thread to itself.
window.processScan = processScan
if (!location.search.includes('noauto')) runSynthetic()
else { mountControls(); log('<p class="muted">Auto-run skipped (?noauto). Use the file input, or window.processScan(bytes,{dpi}).</p>') }
