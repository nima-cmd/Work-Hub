// test/partnerDocuments.test.js — every id here was read back from Drive metadata.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCUMENTS, FOLDERS, documents, documentsFor, documentForModule,
  unreadDocuments, unlinkedDocuments, driveUrl,
} from '../src/model/partnerDocuments.js'

test('⚠️ A LINK IS EITHER VERIFIED OR ABSENT — never a plausible-looking id', () => {
  // A wrong Drive id does not error, it 404s for the person who clicked it, which
  // is worse than no link. Every id below was fetched from Drive and matched on
  // title; the one document that is not indexed yet carries null on purpose.
  for (const d of DOCUMENTS) {
    if (d.driveId === null) continue
    assert.match(d.driveId, /^[A-Za-z0-9_-]{25,}$/, `${d.key} has a malformed id`)
  }
  assert.deepEqual(unlinkedDocuments().map((d) => d.key), ['exemplar-standards-2026-08'])
  assert.equal(driveUrl(null), null, 'no id must produce no url, not a broken one')
})

test('⚠️ THE CANONICAL SAKS LINK IS THE ORIGINAL, NOT THE " (1)" COPY', () => {
  // Both are 5,594,501 bytes so content is not at stake — but I linked the copy
  // first, and a registry whose job is provenance should point at the original.
  const d = DOCUMENTS.find((x) => x.key === 'saks-routing-rev11')
  assert.equal(d.driveId, '1Sfdx66Q8GyFJ3F9V1-7JsWH8vOMUZp6h')
  assert.equal(d.duplicateOf, '1tWoItc9qEkvZDNLSVKfU7RPPEDM2rQsd')
})

test('⚠️ THEY ARE IN THREE FOLDERS, AND THE FILE ONCE CLAIMED ONE', () => {
  const folderOf = Object.fromEntries(DOCUMENTS.map((d) => [d.key, d.folder]))
  assert.equal(folderOf['saks-standards-2024-06'], 'saks')
  assert.equal(folderOf['sfa-routing-2024-07'], 'saks')
  assert.equal(folderOf['nmg-routing'], 'nmg')
  assert.equal(folderOf['macys-routing'], 'data')
  // Every document names a folder that exists.
  for (const d of DOCUMENTS) assert.ok(FOLDERS[d.folder], `${d.key} points at an unknown folder`)
  assert.equal(documents().find((d) => d.key === 'nmg-routing').folderLabel, 'the NMG folder')
})

test('the rules modules resolve back to the document they were built from', () => {
  assert.equal(documentForModule('src/model/saksRouting.js').key, 'saks-routing-rev11')
  assert.equal(documentForModule('src/model/exemplarStandards.js').key, 'exemplar-standards-2026-08')
  assert.equal(documentForModule('src/model/nothing.js'), null)
})

test('⚠️ THE GAP REPORT NAMES THE THREE GUIDES NOBODY HAD READ', () => {
  // The point of the registry: these sat in Drive while I told Nima I needed them.
  const keys = unreadDocuments().map((d) => d.key)
  assert.ok(keys.includes('macys-routing'))
  assert.ok(keys.includes('shopbop-vendor-ops'))
  assert.ok(keys.includes('nordstrom-edi'))
  // A superseded edition is not a gap — nobody should be reading it.
  assert.ok(!keys.includes('saks-standards-2024-06'))
  assert.ok(!keys.includes('nmg-routing'))
  // And a rule enforced from a document nobody read says so, with the citation.
  const macys = unreadDocuments().find((d) => d.key === 'macys-routing')
  assert.match(macys.why, /bolAddresses\.js/)
  assert.match(macys.why, /cannot be checked against the source/)
})

test('a partner lookup puts the governing edition first', () => {
  const saks = documentsFor('Saks')
  assert.ok(saks.length >= 3)
  assert.equal(saks[0].supersededBy, undefined, 'a superseded guide must never lead')
  // Neiman resolves through the Exemplar `also` list, not a separate record.
  assert.ok(documentsFor('Neiman Marcus').some((d) => d.key === 'saks-routing-rev11'))
  assert.ok(documentsFor('Nordstrom').every((d) => d.partner === 'Nordstrom'))
  assert.deepEqual(documentsFor('Costco'), [])
})

test('⚠️ THE RULES MODULES POINT BACK AT A DOCUMENT KEY THAT EXISTS', async () => {
  // A `documentKey` that matches nothing would render a "source" link as blank and
  // read as "no document" — the exact impression this registry exists to prevent.
  const [saks, exemplar] = await Promise.all([
    import('../src/model/saksRouting.js'),
    import('../src/model/exemplarStandards.js'),
  ])
  for (const k of [saks.SOURCE.documentKey, exemplar.SOURCE.documentKey]) {
    assert.ok(DOCUMENTS.find((d) => d.key === k), `${k} is not a document`)
  }
  assert.equal(documentForModule('src/model/saksRouting.js').key, saks.SOURCE.documentKey)
})

test('⚠️ THE REGISTRY NAMES THE FILE THE RULES WERE ACTUALLY READ FROM', async () => {
  // Two copies sit side by side. "_thap" is the site's latest, unlocked so it could
  // be saved (Nima, 2026-09-11); the other is the restricted original.
  // exemplarStandards.js reads the unlocked one, and the registry has to agree with
  // it, or a future reader checks a rule against the wrong file.
  const { SOURCE } = await import('../src/model/exemplarStandards.js')
  const d = DOCUMENTS.find((x) => x.key === 'exemplar-standards-2026-08')
  assert.match(SOURCE.file, /_thap\.pdf$/)
  assert.ok(d.readFrom.includes(SOURCE.file), 'the registry must name the file actually read')
  assert.match(d.alsoOnDisk, /restricted original/)
})
