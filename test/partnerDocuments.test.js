// test/partnerDocuments.test.js — every id here was read back from Drive metadata.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCUMENTS, FOLDERS, documents, documentsFor, documentForModule,
  unreadDocuments, unlinkedDocuments, driveUrl,
  reviewStatus, needsReview, GUIDES_ROOT, REVIEW_EVERY_DAYS,
} from '../src/model/partnerDocuments.js'

test('⚠️ A LINK IS EITHER VERIFIED OR ABSENT — never a plausible-looking id', () => {
  // A wrong Drive id does not error, it 404s for the person who clicked it, which
  // is worse than no link. Every id below was fetched from Drive and matched on
  // title; the one document that is not indexed yet carries null on purpose.
  for (const d of DOCUMENTS) {
    if (d.driveId === null) continue
    assert.match(d.driveId, /^[A-Za-z0-9_-]{25,}$/, `${d.key} has a malformed id`)
  }
  // ⚠️ FOUR are unlinked, and every one is unlinked for the SAME honest reason: the
  // file is in the Data folder on disk and the Drive connector has not indexed it,
  // so no id can be READ. An id that was not read is not written here.
  assert.deepEqual(unlinkedDocuments().map((d) => d.key).sort(), [
    'exemplar-standards-2026-08', 'saks-edi-4050', 'saks-edi-5010', 'saks-edi-store-dc-codes',
  ])
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

test('⚠️ EDITION AGE AND LAST-CHECKED ARE DIFFERENT AGES', () => {
  // Conflating them is the trap. A 2024 guide is stale however recently someone
  // looked at it; a 2026 guide checked eight months ago may have been reissued twice.
  const now = new Date('2026-09-11T12:00:00Z').getTime()
  const r = reviewStatus({ editionDate: '2026-06-01', lastChecked: '2026-09-11' }, now)
  assert.equal(r.state, 'current')
  assert.equal(r.editionAgeDays, 102)
  assert.equal(r.sinceCheckedDays, 0)
  assert.equal(r.overdue, false)
})

test('⚠️ NEVER CHECKED IS OVERDUE, NOT FINE', () => {
  // [[default-is-not-an-answer]]. The alternative is a registry that goes quiet
  // about exactly the documents nobody has ever verified — and the Routing Guide
  // puts the duty on us in writing.
  const now = new Date('2026-09-11T12:00:00Z').getTime()
  const r = reviewStatus({ editionDate: '2026-05-22' }, now)
  assert.equal(r.state, 'never-checked')
  assert.equal(r.overdue, true)
  assert.equal(r.sinceCheckedDays, null)
  assert.match(r.why, /Never verified/)
  // With no edition date either, it still reports rather than throwing.
  assert.equal(reviewStatus({}, now).state, 'never-checked')
})

test('a superseded edition is not chased', () => {
  const r = reviewStatus({ supersededBy: 'x', editionDate: '2024-06-10' })
  assert.equal(r.state, 'superseded')
  assert.equal(r.overdue, false)
  // And it stays out of the review queue.
  assert.ok(!needsReview().some((d) => d.supersededBy))
})

test('the cadence is what makes a checked document go overdue', () => {
  const now = new Date('2026-09-11T12:00:00Z').getTime()
  assert.equal(reviewStatus({ lastChecked: '2026-08-01' }, now).state, 'current')
  assert.equal(reviewStatus({ lastChecked: '2026-05-01' }, now).state, 'overdue')
  // A per-document cadence overrides the default.
  assert.equal(reviewStatus({ lastChecked: '2026-08-01', reviewEveryDays: 7 }, now).state, 'overdue')
})

test('⚠️ THE SERVICING DC LIST IS THE ONE THAT OVERRULES NETSUITE', () => {
  // It is the only authoritative store→DC map and it disagrees with NetSuite on 18
  // of 33 Neiman stores. Recorded so nobody "simplifies" back to the NetSuite field.
  const d = DOCUMENTS.find((x) => x.key === 'saks-servicing-dc-list')
  assert.equal(d.rulesIn, 'src/model/exemplarStores.js')
  assert.match(d.governs, /supersedes NetSuite/)
  assert.equal(d.editionDate, '2026-06-10')
  assert.ok(d.driveId, 'this one must be linkable — it is the document people will want to open')
})

test('⚠️ A RENAMED FILE IS NOT A NEW EDITION', () => {
  // Nima re-supplied the routing guide and the servicing list with "current" in the
  // filename. Both are byte-identical to what was already registered, so they are
  // recorded as alternate names rather than as uncatalogued editions.
  for (const key of ['saks-routing-rev11', 'saks-servicing-dc-list']) {
    assert.match(DOCUMENTS.find((d) => d.key === key).alsoNamed, /current/)
  }
})

test('⚠️ THE TWO STORE LISTS CONFLICT ON STORE 0694, AND THAT IS RECORDED', () => {
  // The 2026-04-21 EDI codes list puts the Saks Photo Studio at 250 Vesey Street;
  // the newer 2026-06-10 servicing list puts it at 611 5th Ave. Newer wins, but
  // saksRouting.js still holds the Vesey address from the Routing Guide, so this is
  // a live disagreement between three current documents, not a resolved question.
  const d = DOCUMENTS.find((x) => x.key === 'saks-edi-store-dc-codes')
  assert.ok(d.conflicts?.some((c) => /0694/.test(c)))
})

test('the guides folder is described but NOT created', () => {
  // Creating folders and moving files in a shared Drive is Nima's call, not a side
  // effect of reading a registry — and these files live across three folders today,
  // so consolidating them MOVES documents other people may be linking to.
  assert.equal(GUIDES_ROOT.created, false)
  assert.match(GUIDES_ROOT.mirrors, /googleDrive\.js/)
})
