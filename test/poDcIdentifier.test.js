// test/poDcIdentifier.test.js — deriving a fulfilment's PO-DC when NetSuite has none.
import test from 'node:test'
import assert from 'node:assert/strict'
import { derivePoDc, resolvePoDc, resolveFulfilmentRows, missingIdentifier } from '../src/model/poDcIdentifier.js'
import { ifSql } from '../src/ingest/ediPackagesLive.js'

const row = (o) => ({ id: '1', tranid: 'IF1', status: 'A', po_dc: null, so_po: '1071913', cust_dc: 'SC', ...o })

test('⚠️ NETSUITE\'S OWN VALUE ALWAYS WINS — we never override the field', () => {
  // It is what the ASN is generated from. Preferring our own arithmetic over the real
  // field would be the app quietly disagreeing with the document the partner receives.
  const r = resolvePoDc(row({ po_dc: '7242989-JP', so_po: '1071913', cust_dc: 'SC' }))
  assert.deepEqual(r, { poDc: '7242989-JP', derived: false, missingNetsuiteField: false })
})

test('a missing field is derived from the PO and the customer DC', () => {
  assert.deepEqual(resolvePoDc(row()), { poDc: '1071913-SC', derived: true, missingNetsuiteField: true })
})

test('⚠️ "-" IS ABSENT, NOT A VALUE', () => {
  // The field renders for every fulfilment; boutique orders get a literal dash because
  // they have no PO and no DC. Treating it as present leaves the row unroutable AND
  // unexplained.
  assert.equal(resolvePoDc(row({ po_dc: '-' })).poDc, '1071913-SC')
  assert.equal(resolvePoDc(row({ po_dc: '-' })).derived, true)
})

test('⚠️ half a key is never invented', () => {
  // "1071913-" or "-SC" is exactly the junk splitPoDc already defends against, and it
  // would put a freight destination on a shipment nobody routed.
  assert.equal(derivePoDc('1071913', ''), null)
  assert.equal(derivePoDc('', 'SC'), null)
  assert.equal(resolvePoDc(row({ so_po: null })).poDc, null)
  assert.equal(resolvePoDc(row({ cust_dc: null })).poDc, null)
})

test('⚠️ THE WARNING FIRES EVEN WHEN WE COULD FILL THE GAP OURSELVES', () => {
  // Deriving restores OUR view. The 856 is still built from the empty NetSuite field,
  // so a derived row must never read as "solved".
  const r = resolvePoDc(row())
  assert.equal(r.derived, true)
  assert.equal(r.missingNetsuiteField, true)
})

test('⚠️ a fulfilment reached from two disagreeing sales orders REFUSES to derive', () => {
  // The SO join returns one row per link. Picking the first would group a carton onto
  // the wrong BOL — the exact failure this feed exists to prevent.
  const out = resolveFulfilmentRows([
    row({ id: '9', so_po: '1071913' }),
    row({ id: '9', so_po: '1235197' }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].po_dc, null)
  assert.deepEqual(out[0].ambiguousPo, ['1071913', '1235197'])
})

test('duplicate links that AGREE still derive', () => {
  const out = resolveFulfilmentRows([row({ id: '9' }), row({ id: '9' })])
  assert.equal(out.length, 1)
  assert.equal(out[0].po_dc, '1071913-SC')
})

test('a duplicate row carrying the real field keeps it', () => {
  const out = resolveFulfilmentRows([
    row({ id: '9', po_dc: null }),
    row({ id: '9', po_dc: '1071913-SC' }),
  ])
  assert.equal(out[0].poDcDerived, false)
})

test('⚠️ THE WARNING IS EDI FREIGHT ONLY — boutique orders are not a fault', () => {
  // Run live 2026-09-01 the unfiltered list was 18: the 11 real ones plus 7 boutique
  // fulfilments that have no PO or DC and never will. A list that is 39% one lane is
  // describing the lane, not the fault.
  const rows = resolveFulfilmentRows([
    row({ id: '1', tranid: 'IF7626' }),                                  // EDI, derivable
    row({ id: '2', tranid: 'IF7446', po_dc: '-', so_po: null, cust_dc: null }), // boutique
  ])
  assert.deepEqual(missingIdentifier(rows).map((m) => m.ifNumber), ['IF7626'])
})

test('⚠️ the query no longer requires the identifier to be present', () => {
  // That requirement made an EMPTY FIELD look identical to NO WORK: 11 packed
  // fulfilments, 13 cartons on the floor, and a feed that returned nothing at all.
  const sql = ifSql()
  assert.doesNotMatch(sql, /custbody_po_cd_identifier IS NOT NULL\s*\n\s*AND status/)
  assert.match(sql, /so\.otherrefnum AS so_po/)
  assert.match(sql, /c\.custentity_dc_location AS cust_dc/)
  // Still excludes shipped freight — that half of the scope was never wrong.
  assert.match(sql, /t\.status <> 'C'/)
})

test('a row with neither the field nor both halves is dropped, not guessed', () => {
  const out = resolveFulfilmentRows([row({ id: '5', po_dc: '-', so_po: null, cust_dc: null })])
  assert.equal(out[0].po_dc, null)
  assert.equal(out[0].poDcDerived, false)
})
