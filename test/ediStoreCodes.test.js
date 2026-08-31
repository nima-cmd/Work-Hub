import test from 'node:test'
import assert from 'node:assert/strict'
// ⚠️ extractStoreCodes lives in the MODEL, not the ingest module. It is pure parsing,
// and importing it from src/ingest/orderful.js pulled in the connection pool — which
// makes a DB-free unit test demand DATABASE_URL. The model/ingest split exists for
// exactly this.
import {
  diffPoVersions, summarizePoDiff, looksUnallocated, HOLD_STORE, extractStoreCodes,
} from '../src/model/ediPoDiff.js'

// Nima, 2026-08-17: "the unallocated ones all go to a store 299 which is a dc, anytime i
// see that 299 i know its unallocated. i wasn't sure if that was visible through the API."
//
// It is. Orderful exposes the 850's SDQ segment, and measured across 30 recent Nordstrom
// 850s: 299-only POs exist, 23 never mention it, and NONE mix it with real stores.

test('store codes come out of the SDQ segment', () => {
  // ⚠️ THE FIXTURE NOW USES THE REAL SEGMENT KEY (2026-08-31). It used to sit under a
  // made-up `x`, which passed only because the old implementation text-scanned the whole
  // message for a qualifier-92 pattern wherever it appeared. The parser now walks actual
  // `destinationQuantity` segments, which is what a live 850 contains — anchoring it to
  // the real structure is the point, and a fixture that could never occur was hiding that
  // the reader was not reading SDQ at all.
  const msg = { destinationQuantity: [
    { identificationCodeQualifier: '92', identificationCode: '0005189002' },  // the BUYER, 10 digits
    { identificationCodeQualifier: '92', identificationCode: '0299', quantity: '25' },
    { identificationCodeQualifier: '92', identificationCode: '0221', quantity: '10' },
    { identificationCodeQualifier: '99', identificationCode: '9999', quantity: '1' },  // wrong qualifier
  ] }
  // ⚠️ Four digits IS the store rule: qualifier 92 tags the buying party too, and live
  // Nordstrom 850s put the buyer at 10 digits (0005189002) and every store at 4.
  assert.deepEqual(extractStoreCodes(msg), ['0221', '0299'])
})

test('every line on the hold store means unallocated', () => {
  assert.equal(looksUnallocated(['0299']), true)
  assert.equal(HOLD_STORE, '0299')
})

// ⚠️ NEVER mixed on live data (0 of 30), but if it ever happens the PO is partly
// allocated and must NOT read as parked — that would hide real work.
test('299 alongside real stores is NOT unallocated', () => {
  assert.equal(looksUnallocated(['0299', '0221']), false)
  assert.equal(looksUnallocated(['0221', '0568']), false)
  assert.equal(looksUnallocated([]), false)
  assert.equal(looksUnallocated(null), false)
})

// The event Nima asked about: "will they show up ... letting us know to check them".
// Real history — PO 50073677 went 0299 (328 units) -> nine stores (328 units) on 07-28.
test('a re-send that allocates reads as ALLOCATED, not as a list of numbers', () => {
  const d = diffPoVersions(
    { storeCodes: ['0299'], lineItems: [{ sku: 'A', qty: 328 }] },
    { storeCodes: ['0004', '0221', '0730'], lineItems: [{ sku: 'A', qty: 328 }] })
  assert.equal(d.changed, true)
  const s = summarizePoDiff(d)
  assert.match(s[0], /^ALLOCATED — left store 0299, now 0004, 0221, 0730/)
})

// ⚠️ THE CASE THE OLD DIFF COULD NOT SEE. It compared dates, SKUs, quantities and
// prices — so a re-send with IDENTICAL totals that merely moved the units off the hold
// store changed nothing it could detect, and the PO would have stayed parked and silent.
test('an allocation with identical quantities still counts as a change', () => {
  const same = [{ sku: 'A', qty: 25 }, { sku: 'B', qty: 10 }]
  const d = diffPoVersions({ storeCodes: ['0299'], lineItems: same }, { storeCodes: ['0221'], lineItems: same })
  assert.equal(d.changed, true)
  assert.deepEqual(d.qtyChanges, [])        // nothing else moved
  assert.deepEqual(d.storesRemoved, ['0299'])
})

test('going the other way — back onto the hold store — is said plainly too', () => {
  const d = diffPoVersions({ storeCodes: ['0221'], lineItems: [] }, { storeCodes: ['0299'], lineItems: [] })
  assert.match(summarizePoDiff(d)[0], /moved TO store 0299 \(unallocated\)/)
})

test('an identical re-send is still a no-op, so re-sends stay quiet', () => {
  const v = { storeCodes: ['0221', '0568'], lineItems: [{ sku: 'A', qty: 5 }] }
  assert.equal(diffPoVersions(v, { ...v }).changed, false)
})

test('a store change with no 299 involved is reported plainly', () => {
  const d = diffPoVersions(
    { storeCodes: ['0004', '0221'], lineItems: [] }, { storeCodes: ['0221', '0333'], lineItems: [] })
  assert.match(summarizePoDiff(d).join(' '), /stores \+0333 -0004/)
})
