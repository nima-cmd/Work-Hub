// test/nmgStores.test.js — the store→DC map, read from NetSuite 2026-09-11.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STORES, NS_DCS, store, dcForStore, storesForDc, groupByDc, SOURCE,
} from '../src/model/nmgStores.js'

test('⚠️ TWO NUMBERING SYSTEMS, MATCHED ON THE DC NAME AND NOT ON ITS DIGITS', () => {
  // NetSuite says 7010/7060/7077; the Routing Guide says 510/560/577. The digits
  // line up, and that is a coincidence — the evidence is that NetSuite's record
  // names (PINNACLE POINT / EAST COAST / WEST COAST) match the guide's PNDC / ECDC
  // / WCSC entries at the same street addresses.
  assert.equal(dcForStore('1001').code, '510')
  assert.equal(dcForStore('1001').abbrev, 'PNDC')
  assert.deepEqual(dcForStore('1001').address, ['4123 Pinnacle Point Dr', 'Dallas, TX 75211'])
  assert.equal(dcForStore('1010').code, '577')
  assert.equal(dcForStore('1010').abbrev, 'WCSC')
  assert.equal(NS_DCS['7060'].guideCode, '560')
  // Both numbering systems already live in the same NetSuite field.
  assert.equal(NS_DCS['0510'].guideCode, '510')
})

test('⚠️ WCSC IS TWO DC CODES AT ONE ADDRESS — Neiman stores take 577, never 517', () => {
  // 2500 Workman Mill Road is DC 577 for NMG and DC 517 for Saks Fifth Avenue, with
  // different receiving hours; 517 REFUSES delivery without a TMS routing. Sending a
  // Neiman shipment under 517 would book the wrong dock rules.
  const bh = dcForStore('1010')
  assert.equal(bh.code, '577')
  assert.match(bh.receiving, /3:00 AM/)
  assert.ok(!STORES.some((s) => s.nsDc === '517'))
})

test('⚠️ A STORE NUMBER IS ZERO-PADDED IN EDI AND BARE EVERYWHERE ELSE', () => {
  // The same trap as the DC codes. A lookup that silently misses prints a carton
  // label with no store name — fee code 41/301, $250 minimum, per shipment.
  assert.equal(store('1001').abbrev, 'DT')
  assert.equal(store(1001).abbrev, 'DT')
  assert.equal(store(' 1001 ').abbrev, 'DT', 'EDI fields arrive padded with spaces too')
  // Tolerating the padding is the POINT — an 850 writes 01001 for store 1001.
  assert.equal(store('01001').abbrev, 'DT')
  // But tolerance must not reach past the store list into the DC codes, which share
  // the field. 0510 is PNDC, not a store, and must stay unresolved.
  assert.equal(store('0510'), null, 'a DC code is not a store number')
  assert.equal(store('510'), null)
  assert.equal(store(''), null)
})

test('⚠️ AN UNKNOWN STORE IS RETURNED, NEVER DEFAULTED TO A DC', () => {
  // [[default-is-not-an-answer]]. A store missing here means Neiman opened or renamed
  // one; the fix is to refresh the list, not to ship the units to whichever DC the
  // rest of the shipment happened to use.
  assert.equal(dcForStore('9999'), null)
  assert.equal(dcForStore(null), null)
  const { groups, unknown } = groupByDc([
    { store: '1001', qty: 10 }, { store: '1010', qty: 4 }, { store: '9999', qty: 6 },
  ])
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].store, '9999')
  assert.equal(groups.length, 2, 'the unknown store must not become a third group')
  assert.equal(groups.reduce((a, g) => a + g.units, 0), 14, 'and its units are NOT counted as shipped')
})

test('grouping by DC is the unit a consolidated BOL is built on', () => {
  const { groups } = groupByDc([
    { store: '1001', qty: 10 }, { store: '1002', qty: 5 },   // both → 510
    { store: '1010', qty: 4 },                                // → 577
  ])
  const pndc = groups.find((g) => g.dc.code === '510')
  assert.deepEqual(pndc.stores, ['1001', '1002'])
  assert.equal(pndc.units, 15)
  assert.equal(groups.find((g) => g.dc.code === '577').units, 4)
})

test('the east/west split is real and every store resolves', () => {
  assert.equal(STORES.length, 36)
  assert.equal(SOURCE.counts.stores, STORES.length, 'the recorded count must match the list')
  // Every store resolves to a DC with an address — no half-populated entries.
  for (const s of STORES) {
    const dc = dcForStore(s.store)
    assert.ok(dc, `${s.store} ${s.name} resolves to no DC`)
    assert.ok(dc.address?.length, `${s.store} has a DC with no address`)
  }
  assert.equal(storesForDc('577').length, 10)
  assert.equal(storesForDc('510').length, 26)
  // Looked up by either numbering system.
  assert.equal(storesForDc('7077').length, storesForDc('577').length)
})
