// src/model/scanSegments.js — how a stack of scanned pages becomes documents.
//
// Extracted from client/src/lib/scanPipeline.js (2026-07-31) so it can be
// tested: that file imports pdfjs with Vite's `?worker` suffix, which makes
// everything in it unreachable from `npm test`. This half is pure — no pdfjs, no
// DOM, no DB — and it now carries the rule that decides whether a multi-page
// packing slip files as one document or several.
//
// The QR is BOTH delimiter and identifier. Two producers exist:
//   • the BOL tag           `NB1731283`         — the BOL NUMBER itself, printed
//                                                 into the BOL's own barcode space
//                                                 (or stuck on retroactively)
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
  // ⚠️ A BOL IS ITS OWN KIND, and that is the whole point (Nima, 2026-09-03: "the
  // cargo tag doesn't tell you its a bol though does it"). Stamping a carton tag's
  // `DC:<po>:<dc>` onto a bill of lading would make the two documents
  // indistinguishable to everything downstream. The BOL number IS the identity, so
  // it is what the tag carries — which also makes the same code wedge-scannable
  // straight into NetSuite's BOL field for the ASN.
  // No PO or DC is parsed out of it: `bol_registry` holds both, and a lookup beats
  // a parse. The server resolves them with database authority.
  if (/^NB\d+$/i.test(s)) return { kind: 'bol', bolNumber: s.toUpperCase(), raw: s }
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
//   pageResults: [{ pageNum, qr, codes }]
//     qr    = the decoded IDENTITY symbol (or null)
//     codes = every other symbol found on the page, e.g. the carrier's PRO
// → { documents: [{ qr, classify, pageNums:[...], proNumbers:[...] }], orphanPages }
//
// ⚠️ A NON-IDENTITY CODE NEVER OPENS OR CLOSES A DOCUMENT. The carrier staples its
// own barcode onto our BOL (`CTEG 803868`), so a page can now carry two symbols.
// Letting the carrier's sticker start a document would split a BOL wherever the
// driver happened to place it — a boundary decided by a third party.
export function segmentPages(pageResults, { knownPos } = {}) {
  const documents = []
  const orphanPages = []
  let current = null
  for (const { pageNum, qr, codes } of pageResults) {
    if (qr && !sameQr(qr, current?.qr)) {
      current = { qr, classify: classifyQr(qr, { knownPos }), pageNums: [pageNum], proNumbers: [] }
      documents.push(current)
    } else if (current) {
      current.pageNums.push(pageNum)
    } else {
      orphanPages.push(pageNum)
      continue // a PRO before any identity belongs to no document
    }
    for (const pro of proNumbersIn(codes)) {
      if (!current.proNumbers.includes(pro)) current.proNumbers.push(pro)
    }
  }
  return { documents, orphanPages }
}

// A carrier's own tracking barcode on our paper.
//
// ⚠️ MATCHED ON SHAPE, AND DELIBERATELY NOT ON A CARRIER LIST. CTE prints
// `CTEG 803868`; the next LTL carrier prints something else, and a whitelist would
// silently drop it. The rule is "letters then digits, and NOT one of our own
// identifiers" — anything else is captured and shown for confirmation rather than
// written as fact. Spaces are kept out of the stored value so `CTEG 803868` and
// `CTEG803868` are one number.
export function proNumbersIn(codes = []) {
  const out = []
  for (const c of codes) {
    const s = String(c || '').trim()
    if (!s) continue
    if (/^NB\d+$/i.test(s)) continue          // our BOL
    if (/^IF\d+$/i.test(s)) continue          // a fulfilment
    if (/^DC:/i.test(s)) continue              // a cargo tag
    if (!/^[A-Z][A-Z0-9]*[\s-]?\d{4,}$/i.test(s)) continue
    const norm = s.replace(/[\s-]+/g, '').toUpperCase()
    if (!out.includes(norm)) out.push(norm)
  }
  return out
}

// ── filing names ─────────────────────────────────────────────────────────────
// ⚠️ THE PO+DC PAIR IS THE FOLDER, NOT THE DOCUMENT (measured 2026-07-31).
// One PO routinely ships several fulfilments to the SAME DC — the real
// Bloomingdale's scan, PO 7776940, is 15 fulfilments over 5 DCs (JP×4, ST×4,
// CI×3, SC×3, CL×1). The old name `<po>-<dc>.pdf` therefore produced 5 names
// for 15 documents, and `putPdf` UPDATES a same-named file in place, so each
// later slip would have silently replaced an earlier one **while reporting
// success** — data loss shaped exactly like a clean run.
//
// The IF number is the document's identity, so it belongs in the name. Keeping
// `<po>-<dc>-` as the prefix means a DC's slips still sort together in the
// folder. A `DC:<po>:<dc>` cargo-tag QR carries no IF, so that form falls back
// to the old name — one tag per shipment, so it doesn't collide with itself.
// ⚠️ A BOL NEEDS ITS NUMBER IN THE NAME for the same reason a slip needs its IF.
// A signed BOL and a cargo-tagged document for the same PO+DC would both land on
// `<po>-<dc>.pdf`, and `putPdf` UPDATES a same-named file in place — so the second
// would silently replace the first WHILE REPORTING SUCCESS. That is the exact data
// loss the IF number was added to prevent, arriving by a different door.
export function scanFilename({ po, dc, ifNumber, bolNumber }) {
  const stem = dc ? `${po}-${dc}` : `${po}`
  const id = ifNumber || bolNumber
  return id ? `${stem}-${id}.pdf` : `${stem}.pdf`
}

// Two documents in ONE scan that resolve to the same Drive path would overwrite
// each other, and both would report `ok`. Detect it at plan time — before any
// bytes move — so the run can refuse instead of quietly losing a slip.
//
// Within a single scan a repeat is never legitimate: `segmentPages` already
// merges consecutive copies of the same slip into one document, so two
// documents sharing a path means two DIFFERENT slips claimed one name.
// Returns the colliding docs keyed by path, `[]` when clean.
export function findFilingCollisions(documents = []) {
  const byPath = new Map()
  for (const d of documents) {
    if (d?.skip || !d?.filename) continue
    const path = `${d.root || ''}/${d.partner || ''}/${(d.pos && d.pos[0]) || ''}/${d.filename}`
    if (!byPath.has(path)) byPath.set(path, [])
    byPath.get(path).push(d)
  }
  return [...byPath.entries()]
    .filter(([, ds]) => ds.length > 1)
    .map(([path, ds]) => ({ path, filename: ds[0].filename, documents: ds }))
}
