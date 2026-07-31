// src/model/scanSegments.js — how a stack of scanned pages becomes documents.
//
// Extracted from client/src/lib/scanPipeline.js (2026-07-31) so it can be
// tested: that file imports pdfjs with Vite's `?worker` suffix, which makes
// everything in it unreachable from `npm test`. This half is pure — no pdfjs, no
// DOM, no DB — and it now carries the rule that decides whether a multi-page
// packing slip files as one document or several.
//
// The QR is BOTH delimiter and identifier. Two producers exist:
//   • EDI cargo tags        `DC:<po>:<abbrev>`  — one tag, stuck on the front page
//   • the NetSuite slip     `IF7441`            — printed in the FOOTER, so it
//                                                 repeats on EVERY page
// That second one is why the continuation rule below exists.

// Classify a QR payload into a filing target. Advisory only — server/scanFiling.js
// re-classifies with database authority before anything is filed.
//   EDI (per-DC)   → `DC:<po>:<abbrev>`  → { kind:'edi', po, dc }
//   EDI (PO-level) → bare PO number      → { kind:'edi', po, dc:null }
//   fulfilment     → `IF7441`            → { kind:'fulfilment', ifNumber }
//   boutique       → anything else       → { kind:'boutique', raw }
//
// The old EDI labels encode just the PO number with no DC (seen live on the real
// Bloomingdale's scan, pages 49-50: `7527064`, `7776929`). `knownPos` (a Set of
// PO strings from the loaded orders) disambiguates a bare number from some other
// QR when available; without it, an all-digit payload is assumed to be a PO.
//
// A fulfilment payload is NOT resolved to EDI-or-boutique here: that answer lives
// in the database (`fulfillment_dc`), and guessing it client-side would let the
// preview disagree with what actually gets filed.
export function classifyQr(raw, { knownPos } = {}) {
  const s = String(raw || '').trim()
  if (!s) return { kind: 'empty', raw: s }
  const dc = /^DC:([^:]+):(.*)$/.exec(s)
  if (dc) return { kind: 'edi', po: dc[1].trim(), dc: (dc[2] || '').trim() || null, raw: s }
  if (/^IF\d+$/i.test(s)) return { kind: 'fulfilment', ifNumber: s.toUpperCase(), raw: s }
  if (knownPos ? knownPos.has(s) : /^\d{5,}$/.test(s)) return { kind: 'edi', po: s, dc: null, raw: s }
  return { kind: 'boutique', raw: s }
}

// Compared trimmed, because a re-raster of the same printed code must count as
// the same document.
const sameQr = (a, b) => a != null && b != null && String(a).trim() === String(b).trim()

// Group pages into documents.
//   • a page whose QR differs from the open document's → starts a new document
//   • a page whose QR MATCHES the open document's      → continues it
//   • a QR-less page                                   → continues it
//   • QR-less pages before the first QR                → `orphanPages`
//
// ⚠️ THE CONTINUATION RULE IS LOAD-BEARING (2026-07-31). The NetSuite packing
// slip prints its QR in the page FOOTER, so every page of a 3-page slip carries
// the same `IF7441`. Opening a new document per QR page would file that one slip
// as three documents — and the pages would be split mid-shipment, which is worse
// than not filing at all because it looks successful.
//
// Deliberate trade-off: two consecutive COPIES of the same slip merge into one
// document. That's the right way to be wrong — a duplicate copy is rare and
// harmless, whereas shredding a real multi-page slip is neither.
//
//   pageResults: [{ pageNum, qr }]  (qr = decoded string or null)
// → { documents: [{ qr, classify, pageNums:[...] }], orphanPages:[...] }
export function segmentPages(pageResults, { knownPos } = {}) {
  const documents = []
  const orphanPages = []
  let current = null
  for (const { pageNum, qr } of pageResults) {
    if (qr && !sameQr(qr, current?.qr)) {
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
