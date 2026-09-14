// test/bolAddresses.test.js — who the BOL says the freight is consigned to.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shipToFor, bolAuthLine } from '../src/model/bolAddresses.js'

// ── Exemplar ships direct to its own DC, and is not Macy's ─────────────────

test('⚠️ AN EXEMPLAR BOL MUST NOT SAY "MACY\'S" — the last branch was acting as a default', () => {
  // Until 2026-09-14 everything that was not Nordstrom fell through to the Macy's
  // merge-centre branch. The moment partnerForDc stopped calling DC 0510 "Nordstrom",
  // this composed "Macy's PNDC (0510) DC (0510)" for Exemplar freight — a competitor's
  // name on the BOL, the exact objection Nima raised in August about Nordstrom BOLs.
  const { block } = shipToFor('Exemplar', '0510', 'PNDC (0510)', { direct: true })
  assert.doesNotMatch(block.name, /Macy/i)
  assert.match(block.name, /PNDC/)
})

test('an Exemplar DC is addressed from their own DC List, padded or bare', () => {
  for (const dc of ['0510', '510']) {
    const { block, missing } = shipToFor('Exemplar', dc, 'x', { direct: true })
    assert.deepEqual(missing, [], `DC ${dc} should be fully addressed`)
    assert.equal(block.street, '4123 Pinnacle Point')
    assert.equal(block.city, 'Dallas')
    assert.equal(block.state, 'TX')
    assert.equal(block.zip, '75211')
  }
})

test('⚠️ AN UNKNOWN EXEMPLAR DC IS NAMED, NEVER ADDRESSED', () => {
  // A blank gets filled in; a guess gets trucked. This file's standing rule.
  const { block, missing } = shipToFor('Exemplar', '9999', 'x', { direct: true })
  assert.match(block.name, /Exemplar DC 9999/)
  assert.deepEqual(missing, ['street', 'city', 'state', 'zip'])
})

test('the other partners are untouched by the new branch', () => {
  assert.match(shipToFor('Nordstrom', '584', 'x', { direct: true }).block.name, /Nordstrom DC #584/)
  assert.match(shipToFor("Bloomingdale's", 'SC', 'x', { direct: true }).block.name, /Macy's Secaucus/)
})

test('⚠️ AND THE AUTH LINE WAS THE SECOND MACY\'S DEFAULT', () => {
  // Exemplar routes through Dynamic's TMS, which returns a confirmation number — a
  // different mechanism from a Macy's auth/appointment. The guide (p23) wants that
  // number in CID# and Special Instructions; the old line named a competitor AND
  // asked for the wrong number.
  const line = bolAuthLine({ partner: 'Exemplar', tmsConfirmation: 'ABC123' })
  assert.doesNotMatch(line, /Macy/i)
  assert.match(line, /TMS Confirmation # ABC123/)
})

test('⚠️ AN UNKNOWN TMS NUMBER LEAVES THE BLANK BLANK', () => {
  // A blank is a prompt; a plausible number is a wrong document.
  assert.match(bolAuthLine({ partner: 'Exemplar' }), /TMS Confirmation # _+/)
})

test('the other partners keep their own auth line', () => {
  assert.equal(bolAuthLine({ partner: 'Nordstrom' }), null)
  assert.match(bolAuthLine({ partner: "Bloomingdale's", authNumber: 'X1' }), /Macy's Auth \/ Appt # X1/)
})
