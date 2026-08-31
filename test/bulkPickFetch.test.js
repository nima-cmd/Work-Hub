// test/bulkPickFetch.test.js — the live SuiteQL read behind a pick ticket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bulkPickSql, normaliseRow, poFilterError, fetchBulkPickLines } from '../src/ingest/bulkPickFetch.js'

test('⚠️ SUITEQL LOWERCASES EVERY ALIAS — normaliseRow reads case-insensitively', () => {
  // `AS "soStatus"` came back as `sostatus`; quoting does not survive. The model read
  // undefined, so a fully-cancelled PO could not say WHY it was empty. Caught by printing
  // the keys of a real row rather than trusting the alias.
  const raw = {
    links: [], po: '40847685', tranid: 'SO12105', sostatus: 'Sales Order : Closed',
    customer: '584 Nordstrom - 584 - West Coast Omni Center', sku: 'SN03014YG-JET',
    itemtype: 'InvtPart', quantity: '-17', isclosed: 'T',
  }
  const r = normaliseRow(raw)
  assert.equal(r.soStatus, 'Sales Order : Closed')
  assert.equal(r.sku, 'SN03014YG-JET')
  assert.equal(r.isclosed, 'T')
  // And the alias in the SQL is snake_case so the mapping has something to find.
  assert.match(bulkPickSql(['X']), /AS so_status/)
  assert.doesNotMatch(bulkPickSql(['X']), /AS "soStatus"/)
})

test('a missing column reads null, never undefined-by-surprise', () => {
  const r = normaliseRow({})
  for (const k of ['po', 'tranid', 'soStatus', 'customer', 'sku', 'itemtype', 'quantity', 'isclosed']) {
    assert.equal(r[k], null, k)
  }
})

test('⚠️ PO NUMBERS ARE SHAPE-CHECKED AND QUOTED — this value comes off a form', () => {
  // SuiteQL has no parameter binding in this client, and otherrefnum is free text a
  // person types into NetSuite, so the value arrives from a form and reaches a query.
  assert.equal(poFilterError('7242978'), null)
  assert.equal(poFilterError('POJ00384244'), null)
  assert.equal(poFilterError('50106214|CLOSED'), null)
  assert.match(poFilterError("7242978' OR 1=1--"), /not a PO number shape/)
  assert.match(poFilterError(''), /empty PO number/)
  assert.match(poFilterError('x'.repeat(60)), /not a PO number shape/)
})

test('a quote inside an accepted PO is still escaped', () => {
  // Belt and braces: the shape check should already refuse it, but the quoting must not
  // depend on that being true forever.
  assert.match(bulkPickSql(["A'B"]), /'A''B'/)
})

test('the query asks only for sales order LINES', () => {
  const sql = bulkPickSql(['7242978'])
  assert.match(sql, /t\.type='SalesOrd'/)
  assert.match(sql, /tl\.mainline='F'/, 'the header row carries no item')
  assert.match(sql, /UPPER\(t\.otherrefnum\) IN \('7242978'\)/)
})

test('an empty PO list is refused before any round trip', async () => {
  await assert.rejects(() => fetchBulkPickLines([]), /no PO numbers/)
  let called = false
  await assert.rejects(
    () => fetchBulkPickLines(["bad' --"], { run: () => { called = true; return {} } }),
    /not a PO number shape/,
  )
  assert.equal(called, false, 'a bad PO must never reach the query')
})
