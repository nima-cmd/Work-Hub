// test/exemplarStores.test.js — against the Store Servicing DC List of 2026-06-10.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STORES, DCS, DC_STORES, REPORTING_ONLY, store, storeByAbbrev, servicingDc,
  storesForDc, groupByDc, LEGACY_DC_DISAGREEMENTS, LEGACY_ONLY, SOURCE,
  LIVE_ENTITY, isLiveShipTo, STOREFRONT_RENAME, storefrontFor, dcAddressLines,
} from '../src/model/exemplarStores.js'

test('⚠️ THE 18 DISAGREEMENTS ARE DORMANT LEGACY, NOT LIVE MIS-ROUTING', () => {
  // I found these in NetSuite's custentity_dc_location and wrote that "freight
  // routed on the NetSuite field goes to the wrong building — a refused delivery and
  // a chargeback". One query killed that: 32 of the 39 old "Neiman Marcus - …"
  // customers have NEVER had a sales order, and the other 6 stopped 2025-03-11. The
  // disagreement is real; the consequence I attached was invented. Marked live:false
  // so nobody re-raises it as an incident.
  assert.equal(LEGACY_DC_DISAGREEMENTS.length, 18)
  assert.ok(LEGACY_DC_DISAGREEMENTS.every((c) => c.live === false))
  const toEcdc = LEGACY_DC_DISAGREEMENTS.filter((c) => c.netsuite === '510' && c.official === '560')
  assert.equal(toEcdc.length, 17)
  const dn = LEGACY_DC_DISAGREEMENTS.find((c) => c.abbrev === 'DN')
  assert.deepEqual([dn.netsuite, dn.official], ['577', '510'])
  // Each still resolves here to the OFFICIAL value, for whenever one is reactivated.
  for (const c of LEGACY_DC_DISAGREEMENTS) {
    assert.equal(servicingDc(storeByAbbrev(c.abbrev).store).dc, c.official, c.name)
  }
})

test('⚠️ THE NEW ENTITY HAS ONE SHIP-TO, AND THAT IS THE ROUTING AUTHORITY', () => {
  // Nima: "they are a new company we need to only look at the new ones we made its a
  // new entity." Exemplar Luxury Group was created in NetSuite 2026-09-04 with two
  // records, and exactly one destination exists. A second needs a customer record
  // that does not exist yet, so an order for one is a question, not a lookup.
  assert.equal(LIVE_ENTITY.createdInNetSuite, '2026-09-04')
  assert.equal(LIVE_ENTITY.formerly, 'Saks Global')
  assert.equal(LIVE_ENTITY.shipTos.length, 1)
  assert.deepEqual(
    LIVE_ENTITY.shipTos.map((s) => [s.store, s.dc]), [['0077', '510']])
  assert.equal(isLiveShipTo('0077'), true)
  assert.equal(isLiveShipTo('77'), true, 'padding-tolerant, like every store lookup here')
  // ⚠️ A store that EXISTS in the reference data is still not shippable today.
  assert.equal(isLiveShipTo('0210'), false, 'Beverly Hills is reference, not a live ship-to')
  assert.ok(store('0210'), 'and it does resolve as reference')
  assert.equal(LIVE_ENTITY.legacyCustomers, 39)
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

test('⚠️ THREE OLD RECORDS ARE ON NO CURRENT EXEMPLAR LIST', () => {
  // Boston, Ala Moana and Topanga are legacy customers on neither document. Boston
  // and Topanga are two of the six that ever shipped, both last on 2025-03-11.
  assert.deepEqual(LEGACY_ONLY.map((s) => s.abbrev), ['BN', 'AM', 'TP'])
  for (const s of LEGACY_ONLY) assert.equal(storeByAbbrev(s.abbrev), null)
})

test('⚠️ THE STOREFRONT RENAME IS A NAME CHANGE, NOT A RENUMBERING', () => {
  // Exemplar's EDI director: effective 2026-09-21 "SAKS GLOBAL" becomes "EXEMPLAR
  // LUXURY GROUP" in REF(19) and MTX. Store and DC numbers are untouched — which is
  // why 0077 is still 0077 on DC 510, and why reading this as a renumbering would
  // have thrown away a store list that is still correct.
  assert.equal(STOREFRONT_RENAME.renumbering, false)
  assert.equal(STOREFRONT_RENAME.effective, '2026-09-21')
  assert.deepEqual(STOREFRONT_RENAME.segments, ['REF(19)', 'MTX'])
  // Only the two stores whose STOREFRONT column reads SAKS GLOBAL are affected.
  assert.deepEqual(STOREFRONT_RENAME.affectsStores, ['0073', '0077'])

  // It is date-driven, so the cutover cannot be missed or applied early.
  assert.equal(storefrontFor('0077', '2026-09-20'), 'SAKS GLOBAL')
  assert.equal(storefrontFor('0077', '2026-09-21'), 'EXEMPLAR LUXURY GROUP')
  assert.equal(storefrontFor('0077', '2026-12-01'), 'EXEMPLAR LUXURY GROUP')
  // A store the notice does not cover returns null rather than a banner name.
  assert.equal(storefrontFor('0210'), null)
})

test('⚠️ TWO THINGS IN THE RENAME NOTICE ARE UNRESOLVED AND STAY THAT WAY', () => {
  // The notice addresses 5010 partners and then names the 4050 segments, and it
  // omits Saks OFF 5th from the updated storefront list while 12 O5 stores are on
  // the servicing list. Both are recorded as open questions for edi@saks.com rather
  // than resolved by inference.
  assert.equal(STOREFRONT_RENAME.openQuestions.length, 2)
  assert.match(STOREFRONT_RENAME.openQuestions[0], /5010.*4050|4050.*5010/)
  assert.match(STOREFRONT_RENAME.openQuestions[1], /OFF 5th/)
  assert.ok(!STOREFRONT_RENAME.updatedStorefrontList.some((n) => /OFF 5TH/i.test(n)))
  assert.equal(STORES.filter((s) => s.banner === 'O5').length, 12)
})

test('⚠️ ONE DC TABLE, AND IT IS THE DOCUMENT\'S', () => {
  // There were two and they disagreed on all seven entries; the carton label
  // imported the hand-transcribed one. saksRouting.js now derives from here.
  assert.deepEqual(dcAddressLines('0510'), ['4123 Pinnacle Point', 'Dallas, TX 75211'])
  assert.deepEqual(dcAddressLines('560'), [
    '600-620 Research Drive', 'CenterPoint Commerce & Trade Park', 'Pittston Township, PA 18640',
  ])
  assert.equal(dcAddressLines('999'), null, 'an unknown DC yields no address, never a partial one')
  // 072 and 694 are STORE numbers and must not resolve as DCs.
  assert.equal(dcAddressLines('072'), null)
  assert.equal(dcAddressLines('694'), null)
  assert.equal(store('0694').store, '0694', 'but 694 is a real store')
})

test('store 0077 resolves end to end, which is what Nima asked', () => {
  assert.equal(DC_STORES['0077'].name, 'GLOBAL PNDC')
  assert.equal(isLiveShipTo('0077'), true)
  const dc = servicingDc('0077')
  assert.equal(dc.dc, '510')
  assert.equal(dc.name, 'PNDC')
  assert.equal(dc.receiving, 'Tue-Fri 6:30 AM - 3:30 PM')
  assert.match(dc.appointment, /Conduit/)
  // ⚠️ Jewellery is a different dock on the same DC code — not relevant to handbags,
  // but it is the kind of detail that makes a delivery turn up at the wrong door.
  assert.equal(dc.jewelleryStreet, '4123 Pinnacle Point Suite J')
})
