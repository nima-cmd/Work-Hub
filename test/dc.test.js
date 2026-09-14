// test/dc.test.js — which partner a DC code belongs to, and how it reads on screen.
//
// Split out from model.test.js when Exemplar's numeric DCs turned out to be
// answering "Nordstrom" on a live routing card.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partnerForDc, dcLabel } from '../src/model/dc.js'

// ── Exemplar DCs are numeric too, and that was a live mislabel ──────────────

test('⚠️ AN EXEMPLAR DC IS NOT NORDSTROM — the numeric branch was a guess that got one wrong', () => {
  // Found live 2026-09-14: PO 8928906 to DC 0510 consolidated under `Nordstrom|0510`
  // in the routing feed. Routing it as Nordstrom applies Nordstrom's BOL, portal and
  // deadline to Exemplar freight, and hides the Exemplar rules for it entirely.
  assert.equal(partnerForDc('0510'), 'Exemplar')
  assert.equal(partnerForDc('510'), 'Exemplar')
  for (const c of ['517', '550', '560', '577']) assert.equal(partnerForDc(c), 'Exemplar')
})

test('Nordstrom keeps every numeric DC that is not Exemplar', () => {
  for (const c of ['584', '599', '569', '89']) assert.equal(partnerForDc(c), 'Nordstrom')
})

test('the other two lanes are untouched', () => {
  assert.equal(partnerForDc('SBX2'), 'Shopbop')
  assert.equal(partnerForDc('SC'), "Bloomingdale's")
})

test('⚠️ AND AN EXEMPLAR DC IS NAMED ON SCREEN — "DC 0510" reads as a Nordstrom DC', () => {
  assert.equal(dcLabel('0510'), 'PNDC (0510)')
  assert.equal(dcLabel('584'), 'DC 584')
  assert.equal(dcLabel('SC'), 'Secaucus')
})
