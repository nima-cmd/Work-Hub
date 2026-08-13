import test from 'node:test'
import assert from 'node:assert/strict'
import {
  netsuiteUrl, recordPage, isDocNumber, normalizeDoc, LINK_ERROR, LINK_MESSAGE,
} from '../src/model/netsuiteLinks.js'

// The three record types verified live 2026-08-13 against our own account.
test('builds the URL from NetSuite\'s own record type', () => {
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'salesorder', id: '2840012' }),
    'https://8513640.app.netsuite.com/app/accounting/transactions/salesord.nl?id=2840012')
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'itemfulfillment', id: '2829557' }),
    'https://8513640.app.netsuite.com/app/accounting/transactions/itemship.nl?id=2829557')
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'invoice', id: '2819896' }),
    'https://8513640.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=2819896')
})

test('record type case does not matter — the two NetSuite APIs disagree about it', () => {
  assert.equal(recordPage('SalesOrder'), 'salesord')
  assert.equal(recordPage('  INVOICE '), 'custinvc')
})

// ⚠️ The rule this module exists for. A guessed page name gives a plausible URL that
// lands on an error page, which reads as NetSuite's fault rather than ours.
test('an unknown record type returns null rather than a guess', () => {
  assert.equal(recordPage('journalentry'), null)
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'journalentry', id: '1' }), null)
})

test('a missing account or id is null, never a half-built URL', () => {
  assert.equal(netsuiteUrl({ recordtype: 'salesorder', id: '1' }), null)
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'salesorder' }), null)
  assert.equal(netsuiteUrl({ account: '8513640', recordtype: 'salesorder', id: '' }), null)
})

// A sandbox account id is `8513640_SB1`, whose host name spells the underscore as a
// hyphen. Getting this wrong points a sandbox link at PRODUCTION.
test('a sandbox account keeps pointing at the sandbox', () => {
  assert.match(netsuiteUrl({ account: '8513640_SB1', recordtype: 'salesorder', id: '9' }),
    /^https:\/\/8513640-sb1\.app\.netsuite\.com\//)
})

test('document-number shape is checked before any query is spent', () => {
  for (const d of ['SO12446', 'IF7480', 'INV11358', 'PO50203208']) assert.ok(isDocNumber(d), d)
  for (const d of ['', '12446', 'SO', "SO12446'; DROP TABLE orders--", 'SO 12446', null]) {
    assert.equal(isDocNumber(d), false, String(d))
  }
})

test('normalizeDoc upper-cases and trims, so a lower-case card link still resolves', () => {
  assert.equal(normalizeDoc('  so12446 '), 'SO12446')
})

test('every error kind has a sentence — a surface never has to invent one', () => {
  for (const k of Object.values(LINK_ERROR)) assert.ok(LINK_MESSAGE[k], k)
})
