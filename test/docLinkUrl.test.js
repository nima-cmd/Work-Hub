import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_LABEL, linkKey, parseDocUrl } from '../src/model/docLinkUrl.js'

// Nima, 2026-08-20: "within task the ability to take notes as well as link to any google
// docs if possible". `doc_links` attaches documents by (type, number); a Google Doc has a
// URL instead, so this decides what a pasted string IS before it is stored.

test('each Google product is recognised, with its file id', () => {
  const doc = parseDocUrl('https://docs.google.com/document/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/edit?usp=sharing')
  assert.equal(doc.ok, true)
  assert.equal(doc.kind, 'doc')
  assert.equal(doc.fileId, '1AbC_dEfGhIjKlMnOpQrStUvWxYz012345')
  assert.equal(parseDocUrl('https://docs.google.com/spreadsheets/d/1XyZabcdefghijklmnopqrstuv/edit#gid=0').kind, 'sheet')
  assert.equal(parseDocUrl('https://docs.google.com/presentation/d/1PPPabcdefghijklmnopqrstuv/edit').kind, 'slide')
  assert.equal(parseDocUrl('https://drive.google.com/file/d/1FFFabcdefghijklmnopqrstuv/view').kind, 'drive')
  assert.equal(parseDocUrl('https://drive.google.com/drive/folders/1DDDabcdefghijklmnopqrstuv').kind, 'folder')
})

// ⚠️ THE WHOLE REASON THE FILE ID IS EXTRACTED. The same document has many URLs — /edit
// vs /view, ?usp=sharing, #gid=0, /u/0/ — and doc_links' UNIQUE constraint is on
// (a_type, a_number, b_type, b_number). Keying on the raw URL would let one doc be
// attached to a task four times and look like four different documents.
test('the same doc pasted four different ways produces ONE key', () => {
  const id = '1AbC_dEfGhIjKlMnOpQrStUvWxYz012345'
  const keys = [
    `https://docs.google.com/document/d/${id}/edit`,
    `https://docs.google.com/document/d/${id}/edit?usp=sharing`,
    `https://docs.google.com/document/d/${id}/view#heading=h.abc`,
    `https://docs.google.com/document/d/${id}`,
  ].map((u) => linkKey(parseDocUrl(u)))
  assert.equal(new Set(keys).size, 1, `expected one key, got ${JSON.stringify(keys)}`)
  assert.equal(keys[0], id)
})

test('the canonical url drops the query and fragment', () => {
  const r = parseDocUrl('https://docs.google.com/document/d/1AAAbbbcccdddeeefffggg/edit?usp=sharing#heading=x')
  assert.equal(r.url, 'https://docs.google.com/document/d/1AAAbbbcccdddeeefffggg/edit')
})

// ⚠️ He said "any google docs" — but refusing everything else would be a rule he never
// asked for, failing at the moment someone pastes a Dropbox link.
test('a non-Google link is kept whole rather than refused', () => {
  const r = parseDocUrl('https://example.com/specs/carton-spec.pdf?v=2')
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'link')
  assert.equal(r.fileId, null)
  assert.equal(r.url, 'https://example.com/specs/carton-spec.pdf?v=2')
})

test('a non-Drive link keys on host+path, so trailing slashes do not make twins', () => {
  const a = linkKey(parseDocUrl('https://example.com/a/b'))
  const b = linkKey(parseDocUrl('https://example.com/a/b/'))
  assert.equal(a, b)
  assert.notEqual(a, linkKey(parseDocUrl('https://example.com/a/c')))
})

// ⚠️ A bare file id cannot be resolved to a product — document? sheet? — and guessing
// would invent information. Say so instead.
test('a bare file id is refused with an explanation, not guessed', () => {
  const r = parseDocUrl('1AbC_dEfGhIjKlMnOpQrStUvWxYz012345')
  assert.equal(r.ok, false)
  assert.match(r.error, /file id/i)
})

test('junk is refused', () => {
  for (const bad of ['', '   ', 'not a link', 'ftp://x/y']) {
    assert.equal(parseDocUrl(bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(parseDocUrl(null).ok, false)
  assert.equal(parseDocUrl(undefined).ok, false)
})

test('every kind has a human label — a raw URL is never the display text', () => {
  for (const k of ['doc', 'sheet', 'slide', 'form', 'drawing', 'drive', 'folder', 'link']) {
    assert.ok(KIND_LABEL[k], `missing label for ${k}`)
  }
})
