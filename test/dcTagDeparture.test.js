// Closing a per-DC cargo tag. The DC lane of the custody register had never been
// closed once — 41 live tags, 0 cleared, 32 of them belonging to POs that had
// wholly shipped. These tests pin the scoping rule, because getting the UNIT wrong
// (PO instead of DC) is what would have made the fix worse than the bug.

import test from 'node:test'
import assert from 'node:assert/strict'
import { dcTagDeparture } from '../src/model/custody.js'

// PO 8040313 as it stood live: five DC tags, stores split across them.
const IFS_8040313 = [
  { ifNumber: 'IF7456', dc: 'CI', actualShipDate: '2026-08-05' },
  { ifNumber: 'IF7457', dc: 'CI', actualShipDate: '2026-08-05' },
  { ifNumber: 'IF7459', dc: 'CL', actualShipDate: '2026-08-05' },
  { ifNumber: 'IF7460', dc: 'HA', actualShipDate: '2026-08-05' },
  { ifNumber: 'IF7461', dc: 'SC', actualShipDate: '2026-08-04' },
  { ifNumber: 'IF7462', dc: 'SC', actualShipDate: '2026-08-05' },
]

test('a per-DC tag clears when every IF for THAT DC has shipped', () => {
  const r = dcTagDeparture({ docNumber: '8040313:CI', fulfilments: IFS_8040313 })
  assert.equal(r.departed, true)
  assert.equal(r.total, 2)          // scoped to CI's two stores, not the PO's six
  assert.equal(r.shipped, 2)
  assert.equal(r.dc, 'CI')
  assert.equal(r.poNumber, '8040313')
})

test('departedAt is the LATEST ship date in scope, not the first', () => {
  // DC SC shipped one store 08-04 and the other 08-05; the tag closed on the 5th.
  const r = dcTagDeparture({ docNumber: '8040313:SC', fulfilments: IFS_8040313 })
  assert.equal(r.departed, true)
  assert.equal(r.departedAt, '2026-08-05')
})

test('one unshipped store holds ITS OWN tag open and no other', () => {
  const ifs = IFS_8040313.map((f) =>
    f.ifNumber === 'IF7461' ? { ...f, actualShipDate: null } : f)
  const sc = dcTagDeparture({ docNumber: '8040313:SC', fulfilments: ifs })
  assert.equal(sc.departed, false)
  assert.equal(sc.shipped, 1)
  assert.equal(sc.total, 2)
  assert.match(sc.reason, /1 of 2 not marked shipped/)
  // ⚠️ The whole reason the unit is the DC: CI must still clear.
  assert.equal(dcTagDeparture({ docNumber: '8040313:CI', fulfilments: ifs }).departed, true)
})

test('a finished DC does NOT clear on the strength of another DC finishing', () => {
  // The per-PO test this replaces would have cleared every tag here, including CL.
  const ifs = IFS_8040313.map((f) =>
    f.dc === 'CL' ? { ...f, actualShipDate: null } : f)
  assert.equal(dcTagDeparture({ docNumber: '8040313:CL', fulfilments: ifs }).departed, false)
  assert.equal(dcTagDeparture({ docNumber: '8040313:HA', fulfilments: ifs }).departed, true)
})

test('a PO-level tag (empty abbreviation) scopes to the whole PO', () => {
  const r = dcTagDeparture({ docNumber: '7527086:', fulfilments: IFS_8040313 })
  assert.equal(r.dc, null)
  assert.equal(r.total, 6)
  assert.equal(r.departed, true)
})

test('a tag with no matching fulfilment NEVER clears', () => {
  // An empty scope trivially satisfies "all shipped" — the trap this guards.
  for (const doc of ['8040313:ZZ', '99999999:SC', '99999999:']) {
    const r = dcTagDeparture({ docNumber: doc, fulfilments: doc.startsWith('8040313') ? IFS_8040313 : [] })
    assert.equal(r.departed, false, doc)
    assert.equal(r.total, 0, doc)
    assert.match(r.reason, /cannot prove it left/)
  }
})

test('the live Nordstrom tags stay open — 0 of their IFs have shipped', () => {
  const ifs = [
    { ifNumber: 'IF7415', dc: '399', actualShipDate: null },
    { ifNumber: 'IF7416', dc: '399', actualShipDate: null },
  ]
  const r = dcTagDeparture({ docNumber: '50073677:399', fulfilments: ifs })
  assert.equal(r.departed, false)
  assert.equal(r.shipped, 0)
})

// ⚠️ The regression that matters most here — caught on live data DURING this change,
// not by the first cut of these tests. 32 tags qualified on their ship dates and one
// (`7527086:`, scanned out 07-30, never scanned back) was still with the warehouse.
// Closing it is the "shipped supersedes an unmatched CUSTODY_OUT" rule PR #64 ruled
// out one surface over, and it destroys the register's most useful statement about
// that tag: a return scan was missed a week ago.
test('a tag still scanned OUT is NEVER closed by a ship date', () => {
  const ifs = [{ ifNumber: 'IF7300', dc: null, actualShipDate: '2026-07-30' }]
  const r = dcTagDeparture({ docNumber: '7527086:', fulfilments: ifs, state: 'with_warehouse' })
  assert.equal(r.departed, false)
  assert.match(r.reason, /scanned out and never scanned back/)
  // The same tag, once the return scan lands, does close.
  assert.equal(dcTagDeparture({ docNumber: '7527086:', fulfilments: ifs, state: 'returned' }).departed, true)
})

test('an omitted state does not silently mean with_warehouse', () => {
  // The register and the ingest path both pass a state; a caller that forgets must
  // not get a DIFFERENT verdict than one passing 'returned', or the two drift.
  const ifs = [{ ifNumber: 'IF7300', dc: 'SC', actualShipDate: '2026-07-30' }]
  assert.equal(dcTagDeparture({ docNumber: '7527086:SC', fulfilments: ifs }).departed, true)
})

test('missing/garbage input never reads as departed', () => {
  for (const arg of [undefined, {}, { docNumber: '' }, { docNumber: ':' }]) {
    assert.equal(dcTagDeparture(arg).departed, false)
  }
})
