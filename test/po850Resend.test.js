// test/po850Resend.test.js — the same PO sent again.
//
// ⚠️ THE FIXTURES ARE THE REAL POs, read from edi_transactions 2026-09-17. The one that
// started this is 50184318: 1 store → 25, under purpose code "Duplicate".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resendFinding, resendFindings, resendBanner, storeMap, RESEND_KIND, RESEND_WINDOW_DAYS,
} from '../src/model/po850Resend.js'

const v = (createdAt, o = {}) => ({
  createdAt, purposeCode: '00', storeCodes: [], storeQuantities: [], totalUnits: 0, lineCount: 0, ...o,
})

// PO 50184318, verbatim.
const PO50184318 = [
  v('2026-07-28T23:36:18Z', {
    purposeCode: '00', totalUnits: 150, lineCount: 4,
    storeCodes: ['0299'], storeQuantities: [{ store: '0299', units: 150 }],
  }),
  v('2026-09-15T01:24:59Z', {
    purposeCode: '07', totalUnits: 150, lineCount: 22,
    storeCodes: ['0004', '0209', '0221', '0320', '0333'],
    storeQuantities: [
      { store: '0004', units: 4 }, { store: '0209', units: 10 }, { store: '0221', units: 4 },
      { store: '0320', units: 5 }, { store: '0333', units: 3 },
    ],
  }),
]

test('⚠️ THE ALLOCATION ARRIVED UNDER "DUPLICATE" — the code must not decide', () => {
  const f = resendFinding(PO50184318)
  assert.equal(f.kind, RESEND_KIND.ALLOCATION.key)
  assert.equal(f.label, 'allocation arrived')
  assert.match(f.work, /enter the store lines/)
  // The code is reported…
  assert.deepEqual(f.purpose, { from: '00', to: '07' })
  // …and was emphatically not trusted. Purpose 07 means "same document"; this one went
  // from one store to five and is the whole reason this module exists.
  assert.equal(f.stores.before, 1)
  assert.equal(f.stores.after, 5)
  assert.match(f.summary, /1 store → 5/)
  assert.match(f.summary, /4 lines → 22/)
})

test('the per-store split travels with the finding, so nobody re-reads the 850', () => {
  const f = resendFinding(PO50184318)
  assert.equal(f.allocation.length, 5)
  assert.deepEqual(f.allocation[0], { store: '0004', units: 4 })
  assert.equal(f.allocation.reduce((a, x) => a + x.units, 0), 26)
  // And the store that held everything before is gone.
  assert.deepEqual(f.stores.removed, ['0299'])
  assert.ok(f.stores.added.includes('0004'))
})

test('⚠️ STORES FALLING TO ZERO IS NOT AN ALLOCATION', () => {
  // Three of the sixteen did this — 50073678, 50106212, 40847685. Reading it as an
  // allocation sends somebody to enter lines that do not exist.
  const f = resendFinding([
    v('2026-08-01T00:00:00Z', { storeCodes: ['0299'], totalUnits: 150 }),
    v('2026-09-07T00:00:00Z', { storeCodes: [], totalUnits: 150 }),
  ])
  assert.equal(f.kind, RESEND_KIND.WITHDRAWN.key)
  assert.match(f.work, /confirm whether this PO is cancelled/)
  assert.notEqual(f.kind, RESEND_KIND.ALLOCATION.key)
})

test('stores moving without a count change is a REALLOCATION', () => {
  // 40856257 went 3 stores → 1: fewer, but not none.
  const f = resendFinding([
    v('2026-05-01T00:00:00Z', { storeCodes: ['0004', '0209', '0221'] }),
    v('2026-06-04T00:00:00Z', { storeCodes: ['0004'] }),
  ])
  assert.equal(f.kind, RESEND_KIND.REALLOCATION.key)
  assert.deepEqual(f.stores.removed, ['0209', '0221'])
})

test('the SAME stores re-split is a quantity change, not a reallocation', () => {
  const f = resendFinding([
    v('2026-09-01T00:00:00Z', { storeCodes: ['0004', '0209'], totalUnits: 20, storeQuantities: [{ store: '0004', units: 10 }, { store: '0209', units: 10 }] }),
    v('2026-09-10T00:00:00Z', { storeCodes: ['0004', '0209'], totalUnits: 20, storeQuantities: [{ store: '0004', units: 15 }, { store: '0209', units: 5 }] }),
  ])
  assert.equal(f.kind, RESEND_KIND.QUANTITY.key)
  assert.deepEqual(f.resplit.sort(), ['0004', '0209'])
  assert.match(f.summary, /2 stores re-split/)
})

test('⚠️ a resend that changed nothing we track is DROPPED, not greyed out', () => {
  // Nordstrom retransmits routinely. Listing every one trains people to stop reading.
  const identical = [
    v('2026-09-01T00:00:00Z', { storeCodes: ['0004'], totalUnits: 10, lineCount: 2, storeQuantities: [{ store: '0004', units: 10 }] }),
    v('2026-09-10T00:00:00Z', { purposeCode: '07', storeCodes: ['0004'], totalUnits: 10, lineCount: 2, storeQuantities: [{ store: '0004', units: 10 }] }),
  ]
  assert.equal(resendFinding(identical).kind, RESEND_KIND.RESEND.key)
  const out = resendFindings({ '1': identical }, { now: new Date('2026-09-17') })
  assert.equal(out.recent.length, 0, 'nothing to act on, so nothing listed')
})

test('⚠️ ONE VERSION IS NOT A RESEND', () => {
  // Otherwise every PO is flagged the day it arrives.
  assert.equal(resendFinding([v('2026-09-01T00:00:00Z')]), null)
  assert.equal(resendFinding([]), null)
})

test('⚠️ RECENT ONLY — the older ones are COUNTED, never raised', () => {
  // Nima, 2026-09-17: "flag the recent ones only." Sixteen POs stretch to last October;
  // fourteen historical alarms is how a banner becomes wallpaper.
  const alloc = (at) => [
    v('2026-01-01T00:00:00Z', { storeCodes: ['0299'], totalUnits: 150 }),
    v(at, { purposeCode: '07', storeCodes: ['0004', '0209'], totalUnits: 150 }),
  ]
  const out = resendFindings(
    { 50184318: alloc('2026-09-14T00:00:00Z'), 40684459: alloc('2025-10-23T00:00:00Z') },
    { now: new Date('2026-09-17T00:00:00Z') },
  )
  assert.equal(out.recent.length, 1)
  assert.equal(out.recent[0].po, '50184318')
  assert.equal(out.recent[0].ageDays, 3)
  assert.equal(out.older.count, 1)
  assert.deepEqual(out.older.pos, ['40684459'])
  assert.equal(out.windowDays, RESEND_WINDOW_DAYS)
})

test('⚠️ "entered?" is a SEPARATE fact from "changed"', () => {
  const byPo = { 50184318: PO50184318 }
  // No sales orders → entry work.
  const none = resendFindings(byPo, { soCountFor: () => 0, now: new Date('2026-09-17') })
  assert.equal(none.recent[0].entered, false)
  assert.equal(none.recent[0].soCount, 0)
  // Already entered → the work is CHECKING, not entering.
  const some = resendFindings(byPo, { soCountFor: () => 25, now: new Date('2026-09-17') })
  assert.equal(some.recent[0].entered, true)
  // ⚠️ And null when the caller supplied no orders — not false, which would claim
  // nothing is entered.
  const unknown = resendFindings(byPo, { now: new Date('2026-09-17') })
  assert.equal(unknown.recent[0].entered, null)
})

test('⚠️ the banner counts WORK, not resends', () => {
  const byPo = { 50184318: PO50184318 }
  const f = resendFindings(byPo, { soCountFor: () => 0, now: new Date('2026-09-17') })
  const b = resendBanner(f)
  assert.match(b.text, /1 allocation arrived — 5 store lines to enter/)
  assert.equal(b.needEntry, 1)
  assert.equal(b.severity, 'warn')
  assert.deepEqual(b.pos, ['50184318'])

  // ⚠️ An allocation already entered is not entry work, so the banner softens rather
  // than shouting about work that is done.
  const done = resendBanner(resendFindings(byPo, { soCountFor: () => 25, now: new Date('2026-09-17') }))
  assert.equal(done.needEntry, 0)
  assert.equal(done.severity, 'notice')
  assert.match(done.text, /1 other PO resent with changes/)

  assert.equal(resendBanner({ recent: [] }), null, 'silence when there is nothing')
})

test('storeMap sums duplicate store lines rather than overwriting them', () => {
  // One store can appear on several line items of the same 850.
  const m = storeMap([{ store: '0004', units: 4 }, { store: '0004', units: 6 }, { store: '0209', units: 1 }])
  assert.equal(m.get('0004'), 10)
  assert.equal(m.get('0209'), 1)
  assert.equal(storeMap(null).size, 0)
})
