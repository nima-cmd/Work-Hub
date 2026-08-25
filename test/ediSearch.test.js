import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSearchHits, hitSummary, normalizeQuery, MATCH } from '../src/model/ediSearch.js'

// ⚠️ SEARCH EVERYWHERE, THEN SAY WHAT MATCHED. Classifying the input first — "NB… is a
// BOL, 5 digits is an invoice" — is guessing, and the guesses collide: 11419 is an
// invoice number AND a plausible PO.

test('a hit on the PO itself is just the PO', () => {
  const rows = groupSearchHits([{ poNumber: '7242978', partner: "Bloomingdale's", field: MATCH.PO, value: '7242978' }])
  assert.equal(rows.length, 1)
  assert.equal(hitSummary(rows[0]), 'PO 7242978')
})

test('a hit on a BOL names the BOL as the reason', () => {
  const rows = groupSearchHits([{ poNumber: '7242978', partner: "Bloomingdale's", field: MATCH.BOL, value: 'NB1731242' }])
  assert.match(hitSummary(rows[0]), /PO 7242978 — matched on BOL \/ ASN NB1731242/)
})

test('several documents on one PO collapse to ONE row, keeping every reason', () => {
  // The PO is the thing you act on, so a BOL search and a PO search land in the same
  // place — but a number matching two documents is information, not noise.
  const rows = groupSearchHits([
    { poNumber: '7242978', field: MATCH.BOL, value: 'NB1731242' },
    { poNumber: '7242978', field: MATCH.INVOICE, value: '11419' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].matches.length, 2)
})

test('⚠️ the same value from two sources is said ONCE', () => {
  // A BOL arrives from routing_shipment AND from an 856. Printing it twice tells the
  // reader nothing.
  const rows = groupSearchHits([
    { poNumber: 'P1', field: MATCH.BOL, value: 'NB1' },
    { poNumber: 'P1', field: MATCH.BOL, value: 'NB1' },
  ])
  assert.equal(rows[0].matches.length, 1)
})

test('an exact PO hit outranks a document hit', () => {
  const rows = groupSearchHits([
    { poNumber: 'ZZZ', field: MATCH.INVOICE, value: '11419' },
    { poNumber: 'AAA', field: MATCH.PO, value: 'AAA' },
  ])
  assert.equal(rows[0].poNumber, 'AAA', 'the thing you literally typed comes first')
})

test('one number matching two DIFFERENT POs returns both', () => {
  // Ambiguity is reported, never resolved by guessing which was meant.
  const rows = groupSearchHits([
    { poNumber: 'P1', field: MATCH.INVOICE, value: '11419' },
    { poNumber: 'P2', field: MATCH.INVOICE, value: '11419' },
  ])
  assert.equal(rows.length, 2)
})

test('the partner is filled from whichever hit knows it', () => {
  const rows = groupSearchHits([
    { poNumber: 'P1', field: MATCH.BOL, value: 'NB1' },
    { poNumber: 'P1', partner: "Bloomingdale's", field: MATCH.INVOICE, value: '11419' },
  ])
  assert.equal(rows[0].partner, "Bloomingdale's")
})

test('hits with no PO are dropped — there is nothing to act on', () => {
  assert.equal(groupSearchHits([{ field: MATCH.BOL, value: 'NB1' }]).length, 0)
})

test('⚠️ normalizeQuery does NOT strip a prefix', () => {
  // "NB1731242" and "1731242" are different strings and only one is a BOL. Helpfully
  // removing the prefix would match a PO that happens to share the digits.
  assert.equal(normalizeQuery('  nb1731242 '), 'NB1731242')
  assert.equal(normalizeQuery('1731242'), '1731242')
})

test('empty input normalises to an empty string, not a wildcard', () => {
  assert.equal(normalizeQuery(null), '')
  assert.equal(normalizeQuery('   '), '')
})
