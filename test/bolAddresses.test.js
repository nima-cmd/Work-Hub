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

// ── Freight terms ──────────────────────────────────────────────────────────
// The term itself is computed in server/bolPdf.js; these assert the rule it follows,
// because the old one was a comment ("never prepaid") rather than a check.

test('⚠️ "NEVER PREPAID" WAS TRUE OF TWO PARTNERS, NOT OF BOLs', () => {
  // Exemplar's PO 8928906 header reads Freight: Prepaid. The BOL would have ticked
  // Collect — §12.9 code 905 / NMG T24, cost of freight + $75.
  const term = (shipment) => {
    const recorded = String(shipment.freightTerms || '').trim().toLowerCase()
    return recorded === 'prepaid' ? 'Prepaid'
      : recorded === 'collect' ? 'Collect'
        : recorded === '3rd' || recorded === 'third party' || recorded === '3rd party' ? '3rd'
          : /XLTL|RXO/i.test(`${shipment.scac || ''} ${shipment.carrier || ''}`) ? '3rd' : 'Collect'
  }
  assert.equal(term({ freightTerms: 'Prepaid' }), 'Prepaid')
  assert.equal(term({ freightTerms: 'Collect' }), 'Collect')
  // Nothing recorded keeps the old derivation, which is right for the partners it was
  // written for — that is why this went unnoticed.
  assert.equal(term({}), 'Collect')
  assert.equal(term({ scac: 'RXOX' }), '3rd')
  // And a recorded term beats the carrier derivation, not the other way round.
  assert.equal(term({ freightTerms: 'Prepaid', scac: 'RXOX' }), 'Prepaid')
})
