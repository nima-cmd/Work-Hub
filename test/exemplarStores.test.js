// test/exemplarStores.test.js — against the Store Servicing DC List of 2026-06-10.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STORES, DCS, DC_STORES, REPORTING_ONLY, store, storeByAbbrev, servicingDc,
  storesForDc, groupByDc, NETSUITE_DC_CONFLICTS, NETSUITE_ONLY, SOURCE,
} from '../src/model/exemplarStores.js'

test('⚠️ NETSUITE SENDS 18 STORES TO THE WRONG DC, AND THAT IS THE POINT OF THIS FILE', () => {
  // I built nmgStores.js from NetSuite's custentity_dc_location and argued in its
  // header that reading NetSuite beat typing the guide. Against the official list,
  // 17 stores NetSuite routes to PNDC 510 are serviced from ECDC 560 in Pittston PA,
  // and Denver is the reverse. Freight on the NetSuite value goes to the wrong
  // building — a refused delivery and a chargeback.
  assert.equal(NETSUITE_DC_CONFLICTS.length, 18)
  const toEcdc = NETSUITE_DC_CONFLICTS.filter((c) => c.netsuite === '510' && c.official === '560')
  assert.equal(toEcdc.length, 17)
  const dn = NETSUITE_DC_CONFLICTS.find((c) => c.abbrev === 'DN')
  assert.deepEqual([dn.netsuite, dn.official], ['577', '510'])

  // And every conflict resolves against this file to the OFFICIAL value.
  for (const c of NETSUITE_DC_CONFLICTS) {
    assert.equal(servicingDc(storeByAbbrev(c.abbrev).store).dc, c.official, c.name)
  }
})

test('⚠️ THE STORE NUMBER IS EXEMPLAR\'S, NOT NETSUITE\'S', () => {
  // NetSuite numbers Neiman 1001-1111; Exemplar uses 0110/0210/0223. The label wants
  // Exemplar's — printing 1010 for Beverly Hills is fee 41/301, $250 minimum.
  assert.equal(storeByAbbrev('LA').store, '0210')
  assert.equal(storeByAbbrev('DT').store, '0110')
  assert.equal(storeByAbbrev('TY').store, '0223')
  // NetSuite's number resolves to nothing here, deliberately.
  assert.equal(store('1010'), null)
  assert.equal(store('1001'), null)
})

test('⚠️ 517 AND 577 ARE ONE BUILDING WITH TWO DC NUMBERS', () => {
  // 2500 S Workman Mill is 517 for the Saks banners and 577 for Neiman. A Neiman
  // carton labelled 517 is mis-routed inside a warehouse that did receive it.
  assert.equal(DCS[517].street, DCS[577].street)
  assert.equal(DCS[517].zip, DCS[577].zip)
  assert.deepEqual(DCS[577].banners, ['NM'])
  assert.deepEqual(DCS[517].banners, ['SFA', 'O5'])
  assert.equal(servicingDc('0210').dc, '577', 'Neiman Beverly Hills')
  assert.equal(servicingDc('0603W').dc, '517', 'Saks Beverly Hills')
})

test('⚠️ A STORE NUMBER IS NOT ALWAYS NUMERIC', () => {
  // 0603M/0603W and 0630M/0630W are the men's and women's stores at one location and
  // are DIFFERENT ship-tos. Parsing as an integer drops the suffix and merges them.
  assert.equal(store('0603M').street, '9634 Wilshire Blvd')
  assert.equal(store('0603W').street, '9600 Wilshire Blvd')
  assert.notEqual(store('0630M').street, store('0630W').street)
  assert.equal(store('603M').store, '0603M', 'and it still tolerates missing padding')
})

test('⚠️ STORE 0077 IS A DC, WHICH IS WHY THE LIVE ORDER LOOKED ODD', () => {
  // The NetSuite customer on IF7650 is "EXEMPLAR LUXURY - GLOBAL PNDC - 0077", and
  // 0077 is not a shop — it is Pinnacle Point receiving on its own store number.
  assert.equal(DC_STORES['0077'].name, 'GLOBAL PNDC')
  const dc = servicingDc('0077')
  assert.equal(dc.dc, '510')
  assert.equal(dc.street, '4123 Pinnacle Point')
  assert.equal(dc.city, 'Dallas')
})

test('⚠️ A DC OF "N/A" IS null, NEVER A NEARBY GUESS', () => {
  // The servicing list prints N/A for the Saks Photo Studio: samples are
  // direct-to-store and skip the TMS, so it genuinely has no servicing DC.
  // [[default-is-not-an-answer]] — the nearest DC would be a fabricated routing.
  assert.equal(store('0694').dc, null)
  assert.equal(servicingDc('0694'), null)
})

test('reporting-only codes never receive freight', () => {
  for (const code of ['0080', '0083', '0683']) {
    assert.match(REPORTING_ONLY[code], /852 reporting only/)
    assert.equal(store(code), null, `${code} must not resolve as a ship-to`)
  }
})

test('⚠️ THE EAST/WEST SPLIT NETSUITE IMPLIES IS NOT REAL', () => {
  // Denver and Scottsdale are the proof: both look "west", and they go to different
  // DCs. Any rule derived from geography rather than the list is wrong.
  assert.equal(servicingDc('0226').dc, '510', 'Denver -> PNDC Dallas')
  assert.equal(servicingDc('0229').dc, '577', 'Scottsdale -> WCSC Whittier')
  // Likewise Houston Galleria (NM) and Houston (SFA) both go to 510, while
  // Bal Harbour NM and Bal Harbour SFA both go to 560 — banner is not the rule either.
  assert.equal(servicingDc('0114').dc, '510')
  assert.equal(servicingDc('0634').dc, '510')
  assert.equal(servicingDc('0115').dc, '560')
  assert.equal(servicingDc('0637').dc, '560')
})

test('grouping for a consolidated BOL, with unknown stores named', () => {
  const { groups, unknown } = groupByDc([
    { store: '0210', qty: 10 },   // 577
    { store: '0224', qty: 4 },    // 577
    { store: '0115', qty: 6 },    // 560
    { store: '9999', qty: 3 },    // nowhere
  ])
  assert.equal(groups.length, 2)
  const wcsc = groups.find((g) => g.dc.dc === '577')
  assert.deepEqual(wcsc.stores, ['0210', '0224'])
  assert.equal(wcsc.units, 14)
  assert.equal(groups.find((g) => g.dc.dc === '560').units, 6)
  assert.equal(unknown.length, 1)
  assert.equal(groups.reduce((a, g) => a + g.units, 0), 20, 'the unknown store is NOT counted as shipped')
})

test('every store resolves to a DC with a full address, or to null on purpose', () => {
  for (const s of STORES) {
    if (s.dc === null) { assert.equal(s.store, '0694'); continue }
    const dc = DCS[s.dc]
    assert.ok(dc, `${s.store} ${s.name} points at unknown DC ${s.dc}`)
    for (const f of ['street', 'city', 'state', 'zip']) {
      assert.ok(dc[f], `DC ${s.dc} has no ${f}`)
    }
    assert.match(s.zip, /^\d{5}$/, `${s.store} zip`)
  }
  // Counted from the data, not from memory — my first guess here was 12 and the
  // answer is 13 (10 NM + BG Photo Studio + SFA Houston + OFF 5th Grapevine).
  assert.equal(STORES.length, 67)
  assert.equal(storesForDc('510').length, 13)
  assert.equal(storesForDc('517').length, 4)
  assert.equal(storesForDc('577').length, 7)
  // ⚠️ ECDC PITTSTON CARRIES 42 OF 67 STORES — nearly two thirds. That is the scale
  // of the NetSuite error: it routes 17 of those to Dallas instead.
  assert.equal(storesForDc('560').length, 42)
})

test('the source documents carry the dates printed on them', () => {
  assert.equal(SOURCE.servicingList.dated, '2026-06-10')
  assert.equal(SOURCE.ediCodes.dated, '2026-04-21')
})

test('⚠️ THREE NETSUITE STORES ARE ON NO CURRENT EXEMPLAR LIST', () => {
  // Boston, Ala Moana and Topanga are live NetSuite customers and appear on neither
  // document. Closed, renamed or not EDI-enabled — a question for Exemplar, not
  // something to infer. An order to one has no verifiable ship-to.
  assert.deepEqual(NETSUITE_ONLY.map((s) => s.abbrev), ['BN', 'AM', 'TP'])
  for (const s of NETSUITE_ONLY) assert.equal(storeByAbbrev(s.abbrev), null)
})
