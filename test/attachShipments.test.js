// test/attachShipments.test.js — a shipment must survive its partner being renamed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachShipments } from '../src/model/routing.js'

const group = (partner, dc, memberPos) => ({ partner, dc, memberPos })
const ship = (dcPoKey, partner, dc, memberPos, bolNumber) => ({ dcPoKey, partner, dc, memberPos, bolNumber })

test('the ordinary case: an exact key match, and nothing is reported as re-filed', () => {
  const s = ship("Bloomingdale's|SC|7242978", "Bloomingdale's", 'SC', ['7242978'], 'NB1')
  const r = attachShipments([group("Bloomingdale's", 'SC', ['7242978'])], [s])
  assert.equal(r.groups[0].shipment, s)
  assert.equal(r.groups[0].refiledFrom, null)
  assert.deepEqual(r.detached, [])
})

test('⚠️ A RECLASSIFIED PARTNER MUST NOT ORPHAN THE BOL — this is how a second one gets minted', () => {
  // Live 2026-09-14: PO 8928906 to DC 0510 was stored as Nordstrom (every numeric DC
  // answered "Nordstrom") and holds BOL NB1731288. Once partnerForDc said Exemplar,
  // the group's key no longer matched and the card offered "Assign BOL".
  const s = ship('Nordstrom|0510|8928906', 'Nordstrom', '0510', ['8928906'], 'NB1731288')
  const r = attachShipments([group('Exemplar', '0510', ['8928906'])], [s])
  assert.equal(r.groups[0].shipment.bolNumber, 'NB1731288')
  assert.deepEqual(r.groups[0].refiledFrom, { key: 'Nordstrom|0510|8928906', partner: 'Nordstrom' })
})

test('⚠️ A FALLBACK MATCH IS NOT ALSO DETACHED — that would show one BOL in two places', () => {
  const s = ship('Nordstrom|0510|8928906', 'Nordstrom', '0510', ['8928906'], 'NB1731288')
  const r = attachShipments([group('Exemplar', '0510', ['8928906'])], [s])
  assert.deepEqual(r.detached, [])
})

test('a shipment whose freight is genuinely gone is still detached', () => {
  const s = ship('Nordstrom|584|50073688', 'Nordstrom', '584', ['50073688'], 'NB2')
  const r = attachShipments([group('Exemplar', '0510', ['8928906'])], [s])
  assert.equal(r.groups[0].shipment, null)
  assert.deepEqual(r.detached.map((x) => x.dcPoKey), ['Nordstrom|584|50073688'])
})

test('the PO order in the key does not decide the match', () => {
  // The stored key joins memberPos in whatever order it was built with; the freight is
  // the same freight either way, and a sort-order difference must not mint a second BOL.
  const s = ship("Bloomingdale's|CG|8350986,8329536", "Bloomingdale's", 'CG', ['8350986', '8329536'], 'NB3')
  const r = attachShipments([group('Exemplar', 'CG', ['8329536', '8350986'])], [s])
  assert.equal(r.groups[0].shipment.bolNumber, 'NB3')
})

test('an exact match is preferred over a freight match, so the right row wins', () => {
  const exact = ship('Exemplar|0510|8928906', 'Exemplar', '0510', ['8928906'], 'NEW')
  const old = ship('Nordstrom|0510|8928906', 'Nordstrom', '0510', ['8928906'], 'OLD')
  const r = attachShipments([group('Exemplar', '0510', ['8928906'])], [old, exact])
  assert.equal(r.groups[0].shipment.bolNumber, 'NEW')
  assert.equal(r.groups[0].refiledFrom, null)
  // ⚠️ And the loser is reported as detached rather than vanishing — two rows claiming
  // one shipment is exactly what a person needs to see.
  assert.deepEqual(r.detached.map((x) => x.bolNumber), ['OLD'])
})
