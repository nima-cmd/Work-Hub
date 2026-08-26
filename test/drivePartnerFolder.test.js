// test/drivePartnerFolder.test.js — mapping a partner label onto a real Drive folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDriveFolder, canCheckDrive } from '../src/model/drivePartnerFolder.js'

// The folders that ACTUALLY exist, enumerated from Drive 2026-08-26.
const BOLS = ['Nordstrom', "Bloomingdale's"]
const BOUTIQUES = ['Splash', 'Andrews']

test('the real trading_partner labels map to the real folders', () => {
  assert.equal(resolveDriveFolder("Bloomingdale's", BOLS), "Bloomingdale's")
  assert.equal(resolveDriveFolder('Nordstrom (US) (Direct to Store)', BOLS), 'Nordstrom')
  assert.equal(resolveDriveFolder('Nordstrom (US) (for 856 only)', BOLS), 'Nordstrom')
})

test('a partner with no folder is null — nothing was ever filed for them', () => {
  // ⚠️ NOT a failure. ShopBop, Neiman Marcus and Saks have no folder in either tree, so
  // "no signed paperwork filed" is a verified answer rather than a gap.
  for (const p of ['Shopbop (BOP LLC)', 'Neiman Marcus Group (NMG)', 'Saks Fifth Avenue & Saks OFF 5th - US (810 only)']) {
    assert.equal(resolveDriveFolder(p, BOLS), null)
  }
  assert.equal(canCheckDrive('Shopbop (BOP LLC)', BOLS), false)
})

test('apostrophes are deleted, not split on', () => {
  // ⚠️ Mapping ' to a space makes "Bloomingdale's" → "bloomingdale s" and
  // "Bloomingdales" → "bloomingdales": two spellings of one partner that stop
  // comparing equal. A comment claimed apostrophes were handled while the code split.
  for (const v of ["Bloomingdale's", 'Bloomingdales', 'BLOOMINGDALES', 'Bloomingdale’s']) {
    assert.equal(resolveDriveFolder(v, BOLS), "Bloomingdale's", v)
  }
})

test('the boutique tree is matched against ITS OWN folder list', () => {
  // ⚠️ The two trees hold different partners. Resolving a boutique name against the
  // BOLs list is how every boutique shipment came to report "no paperwork".
  assert.equal(resolveDriveFolder('Andrews', BOUTIQUES), 'Andrews')
  assert.equal(resolveDriveFolder('Andrews', BOLS), null)
  assert.equal(resolveDriveFolder("Bloomingdale's", BOUTIQUES), null)
})

test('a prefix match needs a WORD BOUNDARY, not a substring', () => {
  // ⚠️ A bare startsWith would match "Nordstromia Ltd" to "Nordstrom", and a bare
  // includes would match any folder whose name appears anywhere in the label.
  assert.equal(resolveDriveFolder('Nordstromia Ltd', BOLS), null)
  assert.equal(resolveDriveFolder('Not Nordstrom At All', BOLS), null)
  assert.equal(resolveDriveFolder('Nordstrom', BOLS), 'Nordstrom')
})

test('the longest matching folder wins', () => {
  // So a specific folder is never shadowed by a shorter one that also prefixes.
  const f = ['Saks', 'Saks Fifth Avenue']
  assert.equal(resolveDriveFolder('Saks Fifth Avenue & OFF 5th', f), 'Saks Fifth Avenue')
})

test('nothing to match on is null, never a guess', () => {
  assert.equal(resolveDriveFolder(null, BOLS), null)
  assert.equal(resolveDriveFolder('', BOLS), null)
  assert.equal(resolveDriveFolder('Nordstrom', []), null, 'an empty folder list cannot confirm anything')
})
