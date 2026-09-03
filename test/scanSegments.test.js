// Unit tests for how a scanned stack becomes documents (pure; no pdfjs, no DB).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyQr, segmentPages, scanFilename, findFilingCollisions, proNumbersIn } from '../src/model/scanSegments.js'
import { classifyDriveError } from '../src/ingest/googleDrive.js'

const pages = (...qrs) => qrs.map((qr, i) => ({ pageNum: i + 1, qr }))

test('scan: a QR-less page joins the document above it', () => {
  const { documents, orphanPages } = segmentPages(pages('DC:7527064:CG', null, null))
  assert.equal(documents.length, 1)
  assert.deepEqual(documents[0].pageNums, [1, 2, 3])
  assert.deepEqual(orphanPages, [])
})

test('scan: pages before the first QR are orphans, not silently dropped', () => {
  // This is the signed Master BOL in the real EDI scan.
  const { documents, orphanPages } = segmentPages(pages(null, null, 'DC:7527064:CG'))
  assert.deepEqual(orphanPages, [1, 2])
  assert.deepEqual(documents[0].pageNums, [3])
})

test('scan: a REPEATED identical QR continues the document — the footer case', () => {
  // The NetSuite packing slip prints its QR in the footer, so every page of a
  // 3-page slip carries the same IF. Opening a new document per QR page would
  // file one slip as three, split mid-shipment, while looking successful.
  const { documents } = segmentPages(pages('IF7441', 'IF7441', 'IF7441'))
  assert.equal(documents.length, 1)
  assert.deepEqual(documents[0].pageNums, [1, 2, 3])
  assert.equal(documents[0].qr, 'IF7441')
})

test('scan: a DIFFERENT QR still starts a new document', () => {
  const { documents } = segmentPages(pages('IF7441', 'IF7441', 'IF7442', 'IF7442'))
  assert.equal(documents.length, 2)
  assert.deepEqual(documents.map((d) => d.pageNums), [[1, 2], [3, 4]])
})

test('scan: whitespace around a re-rastered code is not a new document', () => {
  const { documents } = segmentPages(pages('IF7441', ' IF7441 '))
  assert.equal(documents.length, 1)
  assert.deepEqual(documents[0].pageNums, [1, 2])
})

test('scan: a mixed stack of slips and cargo tags segments correctly', () => {
  const { documents, orphanPages } = segmentPages(pages(
    null,                 // master BOL
    'DC:7527064:CG',      // EDI cargo tag, one page
    'IF7441', 'IF7441',   // 2-page boutique slip, footer QR on both
    'DC:7776929:SC', null, // EDI tag + its continuation page
  ))
  assert.deepEqual(orphanPages, [1])
  assert.deepEqual(documents.map((d) => [d.qr, d.pageNums]), [
    ['DC:7527064:CG', [2]],
    ['IF7441', [3, 4]],
    ['DC:7776929:SC', [5, 6]],
  ])
})

test('scan: an empty stack and an all-blank stack are both safe', () => {
  assert.deepEqual(segmentPages([]), { documents: [], orphanPages: [] })
  assert.deepEqual(segmentPages(pages(null, null)), { documents: [], orphanPages: [1, 2] })
})

test('classifyQr: the DC token wins and keeps its parts', () => {
  assert.deepEqual(classifyQr('DC:7527064:CG'), { kind: 'edi', po: '7527064', dc: 'CG', raw: 'DC:7527064:CG' })
  // A tag with no DC half is still PO-level EDI, not malformed.
  assert.deepEqual(classifyQr('DC:7527064:'), { kind: 'edi', po: '7527064', dc: null, raw: 'DC:7527064:' })
})

test('classifyQr: an IF is reported as a fulfilment, NOT guessed into a channel', () => {
  // EDI-vs-boutique lives in fulfillment_dc, server-side. Guessing here would let
  // the preview disagree with what actually gets filed.
  assert.deepEqual(classifyQr('IF7441'), { kind: 'fulfilment', ifNumber: 'IF7441', raw: 'IF7441' })
  assert.equal(classifyQr('if7441').ifNumber, 'IF7441')
  assert.equal(classifyQr(' IF7441 ').kind, 'fulfilment')
})

test('classifyQr: a bare PO is EDI only when it is a known PO', () => {
  const knownPos = new Set(['7527064'])
  assert.equal(classifyQr('7527064', { knownPos }).kind, 'edi')
  assert.equal(classifyQr('9999999', { knownPos }).kind, 'boutique')
  // With no PO list, an all-digit payload is assumed to be a PO (the old labels).
  assert.equal(classifyQr('7527064').kind, 'edi')
})

test('classifyQr: empty is its own answer, not boutique', () => {
  assert.equal(classifyQr('').kind, 'empty')
  assert.equal(classifyQr(null).kind, 'empty')
})

// ── filing names + collisions ────────────────────────────────────────────────
// The real bug behind 2026-07-31's lost slips: PO 7776940 is 15 fulfilments over
// 5 DCs, so PO+DC named only 5 files for 15 documents — and putPdf updates in
// place, so the rest would have overwritten each other reporting success.

test('scanFilename: the IF is what makes a slip unique, not the PO+DC', () => {
  // Three CI fulfilments on ONE PO — the exact shape that collapsed to one name.
  const names = ['IF7332', 'IF7335', 'IF7336'].map((ifNumber) =>
    scanFilename({ po: '7776940', dc: 'CI', ifNumber }))
  assert.deepEqual(names, ['7776940-CI-IF7332.pdf', '7776940-CI-IF7335.pdf', '7776940-CI-IF7336.pdf'])
  assert.equal(new Set(names).size, 3) // the whole point
})

test('scanFilename: the DC prefix survives, so a DC still sorts together', () => {
  assert.match(scanFilename({ po: '7776940', dc: 'ST', ifNumber: 'IF7343' }), /^7776940-ST-/)
})

test('scanFilename: a cargo-tag QR has no IF, so it keeps the old name', () => {
  // `DC:<po>:<dc>` carries no fulfilment number — one tag per shipment, so it
  // cannot collide with itself.
  assert.equal(scanFilename({ po: '7776940', dc: 'CI', ifNumber: null }), '7776940-CI.pdf')
  assert.equal(scanFilename({ po: '7776940', dc: null, ifNumber: null }), '7776940.pdf')
})

test('findFilingCollisions: two documents aiming at one path are caught', () => {
  const docs = [
    { filename: 'a.pdf', partner: "Bloomingdale's", pos: ['7776940'], root: 'BOLs', qr: 'IF1' },
    { filename: 'a.pdf', partner: "Bloomingdale's", pos: ['7776940'], root: 'BOLs', qr: 'IF2' },
    { filename: 'b.pdf', partner: "Bloomingdale's", pos: ['7776940'], root: 'BOLs', qr: 'IF3' },
  ]
  const clashes = findFilingCollisions(docs)
  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].filename, 'a.pdf')
  assert.equal(clashes[0].documents.length, 2)
})

test('findFilingCollisions: same name in a DIFFERENT folder is not a collision', () => {
  const docs = [
    { filename: 'a.pdf', partner: "Bloomingdale's", pos: ['1'], root: 'BOLs' },
    { filename: 'a.pdf', partner: "Bloomingdale's", pos: ['2'], root: 'BOLs' },
    { filename: 'a.pdf', partner: 'Nordstrom', pos: ['1'], root: 'BOLs' },
  ]
  assert.deepEqual(findFilingCollisions(docs), [])
})

test('findFilingCollisions: the real 15-slip stack is clean once the IF is in the name', () => {
  const byDc = { CI: 3, SC: 3, ST: 4, JP: 4, CL: 1 } // PO 7776940, measured live
  let n = 7332
  const docs = []
  for (const [dc, count] of Object.entries(byDc)) {
    for (let i = 0; i < count; i++) {
      const ifNumber = `IF${n++}`
      docs.push({
        filename: scanFilename({ po: '7776940', dc, ifNumber }),
        partner: "Bloomingdale's", pos: ['7776940'], root: 'BOLs', ifNumber,
      })
    }
  }
  assert.equal(docs.length, 15)
  assert.deepEqual(findFilingCollisions(docs), [])
  // and the OLD scheme would have collapsed them to 5
  const old = new Set(docs.map((d) => d.filename.replace(/-IF\d+/, '')))
  assert.equal(old.size, 5)
})

test('findFilingCollisions: skipped documents are not counted', () => {
  const docs = [
    { filename: 'a.pdf', partner: 'P', pos: ['1'], root: 'r' },
    { filename: 'a.pdf', partner: 'P', pos: ['1'], root: 'r', skip: true },
  ]
  assert.deepEqual(findFilingCollisions(docs), [])
})

// ── Drive error classification ───────────────────────────────────────────────
// 403 is BOTH "wrong scope" (fatal) and "too fast" (retry). Conflating them told
// Nima to re-authorise a connection that was working.

test('classifyDriveError: a rate-limit 403 retries instead of demanding re-auth', () => {
  const body = JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'Rate Limit Exceeded' } })
  const v = classifyDriveError(403, body)
  assert.equal(v.retry, true)
  assert.ok(!v.needsReauth)
})

test('classifyDriveError: a scope 403 is fatal and asks for re-auth', () => {
  const body = JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } })
  const v = classifyDriveError(403, body)
  assert.equal(v.retry, false)
  assert.equal(v.needsReauth, true)
})

test('classifyDriveError: 429 and 5xx retry; 401 does not', () => {
  assert.equal(classifyDriveError(429, '').retry, true)
  assert.equal(classifyDriveError(500, '').retry, true)
  assert.equal(classifyDriveError(503, '').retry, true)
  assert.equal(classifyDriveError(401, '').needsReauth, true)
  assert.equal(classifyDriveError(401, '').retry, false)
})

test('classifyDriveError: a non-JSON body still classifies off the status', () => {
  const v = classifyDriveError(503, '<html>Service Unavailable</html>')
  assert.equal(v.retry, true)
  assert.equal(v.reason, 'backendError')
})

test('classifyDriveError: an unknown 403 reason errs toward re-auth, not a retry loop', () => {
  const v = classifyDriveError(403, '')
  assert.equal(v.retry, false)
  assert.equal(v.needsReauth, true)
})

// ── The BOL tag, and the carrier's barcode beside it ─────────────────────────
test('⚠️ A BOL IS ITS OWN KIND — a cargo tag cannot say "bill of lading"', () => {
  // Nima, 2026-09-03: "the cargo tag doesn't tell you its a bol though does it".
  // Stamping DC:<po>:<dc> on a BOL makes it indistinguishable from a carton label.
  assert.deepEqual(classifyQr('NB1731283'), { kind: 'bol', bolNumber: 'NB1731283', raw: 'NB1731283' })
  assert.equal(classifyQr('nb1731283').bolNumber, 'NB1731283')
})

test('⚠️ no PO or DC is PARSED out of a BOL number — bol_registry holds both', () => {
  const c = classifyQr('NB1731277')
  assert.equal(c.po, undefined)
  assert.equal(c.dc, undefined)
})

test('a BOL number is not mistaken for a bare PO', () => {
  assert.equal(classifyQr('NB1731283', { knownPos: new Set(['50073678']) }).kind, 'bol')
  assert.equal(classifyQr('50073678', { knownPos: new Set(['50073678']) }).kind, 'edi')
})

test('⚠️ the BOL number lands IN THE FILENAME, or a signed BOL overwrites a slip', () => {
  // putPdf UPDATES a same-named file in place: without this both file to
  // `50073678-799.pdf` and the second silently replaces the first.
  assert.equal(scanFilename({ po: '50073678', dc: '799', bolNumber: 'NB1731273' }), '50073678-799-NB1731273.pdf')
  assert.equal(scanFilename({ po: '50073678', dc: '799' }), '50073678-799.pdf')
})

test("⚠️ THE CARRIER'S BARCODE NEVER STARTS A DOCUMENT", () => {
  // CTE staples its own sticker wherever it likes. Letting it open a document puts
  // a boundary in our filing under a third party's control.
  const { documents } = segmentPages([
    { pageNum: 1, qr: 'NB1731277', codes: ['CTEG 803868'] },
    { pageNum: 2, qr: null, codes: ['CTEG 803868'] },
    { pageNum: 3, qr: 'NB1731279', codes: [] },
  ])
  assert.equal(documents.length, 2)
  assert.deepEqual(documents[0].pageNums, [1, 2])
  assert.deepEqual(documents[0].proNumbers, ['CTEG803868'])
  assert.deepEqual(documents[1].proNumbers, [])
})

test('the same PRO read twice is one number, and spacing is not identity', () => {
  assert.deepEqual(proNumbersIn(['CTEG 803868', 'CTEG803868', 'cteg-803868']), ['CTEG803868'])
})

test('⚠️ our own identifiers are never captured as a PRO', () => {
  assert.deepEqual(proNumbersIn(['NB1731277', 'IF7644', 'DC:50073678:799']), [])
})

test('⚠️ a PRO found before any identity belongs to NO document', () => {
  // It would otherwise attach to whichever document happened to open next.
  const { documents, orphanPages } = segmentPages([
    { pageNum: 1, qr: null, codes: ['CTEG 803868'] },
    { pageNum: 2, qr: 'NB1731277', codes: [] },
  ])
  assert.deepEqual(orphanPages, [1])
  assert.deepEqual(documents[0].proNumbers, [])
})

test('a page with no codes array still segments', () => {
  const { documents } = segmentPages([{ pageNum: 1, qr: 'NB1731277' }])
  assert.deepEqual(documents[0].proNumbers, [])
})
