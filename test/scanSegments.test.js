// Unit tests for how a scanned stack becomes documents (pure; no pdfjs, no DB).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyQr, segmentPages } from '../src/model/scanSegments.js'

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
