// test/upsRates.test.js — the wholesale-rate model.
//
// The tests that matter most here are the PROVENANCE ones. The whole point of this
// module is that an 18GE01 figure can never be presented as the wholesale rate, so
// that rule gets tested from several directions rather than assumed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UPS_ACCOUNTS, WHOLESALE_ACCOUNT, accountFromTracking, isWholesaleAccount, toPounds,
  weightMatches, eligibleActuals, normalizeActual, quoteFromActuals, liveFigure,
  wholesaleFigure, crossChecks, rateAnswerForBox,
} from '../src/model/upsRates.js'
import { mapShipmentRow, countByAccount } from '../src/ingest/shipstationCosts.js'
import { rateRequest } from '../src/ingest/shipstationRates.js'

test('accountFromTracking reads the shipper number out of a 1Z barcode', () => {
  // Real tracking numbers off Naghedi's own shipments.
  assert.equal(accountFromTracking('1ZC6J6100300643847'), 'C6J610')
  assert.equal(accountFromTracking('1ZC6J6104219896430'), 'C6J610')
  assert.equal(accountFromTracking('1Z18GE010316740963'), '18GE01')
  assert.equal(accountFromTracking('1z18ge010316740963'), '18GE01', 'case-insensitive')
  assert.equal(accountFromTracking('  1ZC6J6100300643847 '), 'C6J610', 'tolerates whitespace')
  assert.equal(accountFromTracking('9400110200000000000000'), null, 'not a UPS barcode')
  assert.equal(accountFromTracking(''), null)
  assert.equal(accountFromTracking(null), null)
})

test('the wholesale account is C6J610, and the primary account is not it', () => {
  assert.equal(WHOLESALE_ACCOUNT, 'C6J610')
  assert.equal(UPS_ACCOUNTS.C6J610.role, 'wholesale')
  assert.equal(UPS_ACCOUNTS.C6J610.primary, false)
  assert.equal(UPS_ACCOUNTS['18GE01'].primary, true, 'the primary is the ecom account — this is the trap')
  assert.ok(isWholesaleAccount('C6J610'))
  assert.ok(isWholesaleAccount('c6j610'))
  assert.ok(!isWholesaleAccount('18GE01'))
})

test('per-account carrier_ids are distinct — the only way V2 can target an account', () => {
  assert.equal(UPS_ACCOUNTS.C6J610.carrierId, 'se-698098')
  assert.equal(UPS_ACCOUNTS['18GE01'].carrierId, 'se-697942')
  assert.notEqual(UPS_ACCOUNTS.C6J610.carrierId, UPS_ACCOUNTS['18GE01'].carrierId)
})

test('toPounds normalizes the units ShipStation actually mixes', () => {
  assert.equal(toPounds(192, 'ounces'), 12)
  assert.equal(toPounds(16, 'ounces'), 1)
  assert.equal(toPounds(32, 'pounds'), 32)
  assert.equal(toPounds(10, undefined), 10, 'defaults to pounds')
  assert.ok(Math.abs(toPounds(1, 'kg') - 2.20462262) < 1e-6)
  assert.equal(toPounds(null, 'ounces'), null)
})

test('weightMatches widens for small boxes so they still find comparables', () => {
  assert.ok(weightMatches(30, 32), 'within 25%')
  assert.ok(!weightMatches(10, 32), 'far too light')
  // A 3 lb target with a pure ±25% band would admit only 2.25–3.75 lb.
  assert.ok(weightMatches(4.5, 3), 'the ±2 lb floor rescues small boxes')
  assert.ok(!weightMatches(6, 3))
  assert.ok(!weightMatches(null, 3))
})

test('eligibleActuals drops voided labels, zero costs and the wrong account', () => {
  const rows = [
    { trackingNumber: '1ZC6J6100000000001', serviceCode: 'ups_ground', shipmentCost: 30, voided: false },
    { trackingNumber: '1ZC6J6100000000002', serviceCode: 'ups_ground', shipmentCost: 30, voided: true },
    { trackingNumber: '1ZC6J6100000000003', serviceCode: 'ups_ground', shipmentCost: 0, voided: false },
    { trackingNumber: '1Z18GE010000000004', serviceCode: 'ups_ground', shipmentCost: 30, voided: false },
    { trackingNumber: '1ZC6J6100000000005', serviceCode: 'ups_2nd_day_air', shipmentCost: 90, voided: false },
  ].map(normalizeActual)

  const out = eligibleActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground' })
  assert.deepEqual(out.map((r) => r.trackingNumber), ['1ZC6J6100000000001'])
})

test('a voided label never moves the median — it was refunded', () => {
  const base = { serviceCode: 'ups_ground', destPostal: '02554', destState: 'MA', weightLb: 32, shipDate: '2026-06-01' }
  const rows = [
    { ...base, trackingNumber: '1ZC6J6100000000001', shipmentCost: 40, voided: false },
    { ...base, trackingNumber: '1ZC6J6100000000002', shipmentCost: 40, voided: false },
    { ...base, trackingNumber: '1ZC6J6100000000003', shipmentCost: 40, voided: false },
    { ...base, trackingNumber: '1ZC6J6100000000009', shipmentCost: 9999, voided: true },
  ]
  const q = quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' }, { minSamples: 3 })
  assert.equal(q.median, 40)
  assert.equal(q.n, 3)
})

test('quoteFromActuals prefers the tightest geography and reports which it used', () => {
  const mk = (i, cost, postal, state) => ({
    trackingNumber: `1ZC6J61000000000${String(i).padStart(2, '0')}`,
    serviceCode: 'ups_ground', shipmentCost: cost, weightLb: 32, destPostal: postal, destState: state,
    shipDate: '2026-06-01', voided: false,
  })
  // Five same-ZIP3 comparables plus cheaper faraway noise that must NOT be used.
  const rows = [
    mk(1, 50, '02554', 'MA'), mk(2, 52, '02554', 'MA'), mk(3, 54, '02554', 'MA'),
    mk(4, 56, '02554', 'MA'), mk(5, 58, '02554', 'MA'),
    mk(6, 12, '91502', 'CA'), mk(7, 12, '91502', 'CA'),
  ]
  const q = quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' })
  assert.equal(q.tier, 'same ZIP3')
  assert.equal(q.n, 5)
  assert.equal(q.median, 54)
  assert.equal(q.thin, false)
  assert.ok(q.median > 40, 'the cheap cross-country rows did not drag it down')
})

test('quoteFromActuals widens when a tight match is too thin, and flags it', () => {
  const mk = (i, cost, postal, state) => ({
    trackingNumber: `1ZC6J61000000000${String(i).padStart(2, '0')}`,
    serviceCode: 'ups_ground', shipmentCost: cost, weightLb: 30, destPostal: postal, destState: state,
    shipDate: '2026-06-01', voided: false,
  })
  // Nothing in 02554; six elsewhere in MA.
  const rows = [mk(1, 44, '02138', 'MA'), mk(2, 46, '02138', 'MA'), mk(3, 48, '02139', 'MA'),
    mk(4, 50, '02140', 'MA'), mk(5, 52, '02141', 'MA'), mk(6, 54, '02142', 'MA')]
  const q = quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' })
  assert.equal(q.tier, 'same state')
  assert.equal(q.n, 6)
  assert.equal(q.thin, false)
})

test('a single distant comparable still answers, but is marked thin', () => {
  const rows = [{
    trackingNumber: '1ZC6J6100000000001', serviceCode: 'ups_ground', shipmentCost: 31,
    weightLb: 32, destPostal: '33308', destState: 'FL', shipDate: '2026-06-29', voided: false,
  }]
  const q = quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' })
  assert.equal(q.n, 1)
  assert.equal(q.thin, true, 'one sample must never look authoritative')
  assert.equal(q.tier, 'nationwide')
})

test('quoteFromActuals returns null rather than inventing a number', () => {
  assert.equal(quoteFromActuals([], { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32 }), null)
  // History exists, but only on the other account.
  const rows = [{ trackingNumber: '1Z18GE010000000001', serviceCode: 'ups_ground', shipmentCost: 20, weightLb: 32, destPostal: '02554', destState: 'MA', voided: false }]
  assert.equal(quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' }), null)
})

test('a historical actual reports its age so nobody quotes 2024 prices as current', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    trackingNumber: `1ZC6J61000000000${i}`, serviceCode: 'ups_ground', shipmentCost: 30 + i,
    weightLb: 32, destPostal: '02554', destState: 'MA', shipDate: '2024-06-01', voided: false,
  }))
  const q = quoteFromActuals(rows, { account: 'C6J610', serviceCode: 'ups_ground', weightLb: 32, destPostal: '02554', destState: 'MA' }, { asOfDate: '2026-08-02' })
  assert.equal(q.basis, 'historical-actual')
  assert.equal(q.asOf.to, '2024-06-01')
  assert.ok(q.staleDays > 700, `expected a stale flag, got ${q.staleDays}`)
  assert.match(q.caveat, /not a live quote/i)
})

// ---- the provenance rule ----

test('wholesaleFigure NEVER substitutes the primary account', () => {
  const ecomLive = liveFigure({ account: '18GE01', serviceCode: 'ups_ground', shippingAmount: 57.64, otherAmount: 16.5 })
  assert.equal(wholesaleFigure([ecomLive]), null, 'an 18GE01 quote is not a wholesale rate at any cost')
  assert.equal(wholesaleFigure([]), null)
  assert.equal(wholesaleFigure([null, undefined]), null)
})

test('wholesaleFigure prefers a live wholesale quote over wholesale history', () => {
  const hist = { basis: 'historical-actual', account: 'C6J610', isWholesale: true, median: 30.99 }
  const live = liveFigure({ account: 'C6J610', serviceCode: 'ups_ground', shippingAmount: 33, otherAmount: 0 })
  assert.equal(wholesaleFigure([hist, live]).basis, 'live-quote')
  assert.equal(wholesaleFigure([hist]).basis, 'historical-actual')
})

test('non-wholesale figures come back explicitly labelled as not wholesale', () => {
  const ecom = liveFigure({ account: '18GE01', serviceCode: 'ups_ground', shippingAmount: 57.64, otherAmount: 16.5 })
  const [cc] = crossChecks([ecom])
  assert.equal(cc.notWholesale, true)
  assert.match(cc.warning, /not the wholesale account/i)
  assert.match(cc.warning, /C6J610/)
})

test('liveFigure totals shipping plus surcharges', () => {
  // The $16.50 other_amount on the Nantucket lane is a real UPS delivery-area
  // surcharge, so the total a boutique gets quoted has to include it.
  const f = liveFigure({ account: 'C6J610', serviceCode: 'ups_ground', shippingAmount: 57.64, otherAmount: 16.5, asOf: '2026-08-02' })
  assert.equal(f.total, 74.14)
  assert.equal(f.isWholesale, true)
  assert.equal(f.basis, 'live-quote')
})

test('rateAnswerForBox explains WHY there is no wholesale number', () => {
  const ecom = liveFigure({ account: '18GE01', serviceCode: 'ups_ground', shippingAmount: 57.64, otherAmount: 16.5 })
  const box = { weightLb: 32, lengthIn: 24, widthIn: 18, heightIn: 14 }
  const a = rateAnswerForBox(box, [ecom], { liveWholesaleError: 'The connection appears to be invalid' })

  assert.equal(a.wholesale, null)
  assert.match(a.wholesaleUnavailableReason, /connection appears to be invalid/)
  assert.equal(a.crossChecks.length, 1)
  assert.equal(a.crossChecks[0].notWholesale, true)
  assert.equal(a.box.weightLb, 32)
})

test('rateAnswerForBox surfaces the wholesale figure when there is one', () => {
  const hist = { basis: 'historical-actual', account: 'C6J610', isWholesale: true, median: 30.99, n: 8 }
  const ecom = liveFigure({ account: '18GE01', serviceCode: 'ups_ground', shippingAmount: 57.64, otherAmount: 16.5 })
  const a = rateAnswerForBox({ weightLb: 12 }, [hist, ecom])
  assert.equal(a.wholesale.median, 30.99)
  assert.equal(a.wholesaleUnavailableReason, null)
  assert.equal(a.crossChecks.length, 1, 'the ecom figure stays visible, just demoted')
})

// ---- ingest mapping ----

test('mapShipmentRow normalizes a real ShipStation shipment', () => {
  // The genuine last C6J610 label, verified live 2026-08-02.
  const row = mapShipmentRow({
    shipmentId: 329775521, orderNumber: '3102150', createDate: '2026-06-29T08:40:11.5600000',
    shipDate: '2026-06-29', trackingNumber: '1ZC6J6104219896430', serviceCode: 'ups_ground',
    carrierCode: 'ups', shipmentCost: 30.99, insuranceCost: 0, voided: false,
    weight: { value: 192, units: 'ounces' }, dimensions: { units: 'inches', length: 22, width: 16, height: 7 },
    shipTo: { city: 'Fort Lauderdale', state: 'FL', postalCode: '33308', residential: null },
    advancedOptions: { storeId: 123781 },
  })
  assert.equal(row.upsAccount, 'C6J610')
  assert.equal(row.weightLb, 12, '192 oz is 12 lb — storing 192 would break every weight comparison')
  assert.equal(row.shipmentCost, 30.99)
  assert.equal(row.destState, 'FL')
  assert.equal(row.shipDate, '2026-06-29')
  assert.equal(row.lengthIn, 22)
})

test('mapShipmentRow skips a shipment with no tracking number', () => {
  assert.equal(mapShipmentRow({ shipmentId: 1, trackingNumber: null }), null)
  assert.equal(mapShipmentRow({ shipmentId: 1, trackingNumber: '' }), null)
})

test('countByAccount separates the accounts and ignores refunded money', () => {
  const rows = [
    { upsAccount: 'C6J610', shipmentCost: 30, voided: false },
    { upsAccount: 'C6J610', shipmentCost: 40, voided: false },
    { upsAccount: 'C6J610', shipmentCost: 999, voided: true },
    { upsAccount: '18GE01', shipmentCost: 10, voided: false },
  ]
  const c = countByAccount(rows)
  assert.equal(c.C6J610.n, 3)
  assert.equal(c.C6J610.withCost, 2)
  assert.equal(c.C6J610.avgCost, 35)
  assert.equal(c['18GE01'].avgCost, 10)
})

test('rateRequest targets the account by carrier_id, ships from Glendale', () => {
  const body = rateRequest({
    box: { weightLb: 32, lengthIn: 24, widthIn: 18, heightIn: 14 },
    destination: { city: 'Nantucket', state: 'MA', postalCode: '02554' },
    carrierId: UPS_ACCOUNTS.C6J610.carrierId,
  })
  assert.deepEqual(body.rate_options.carrier_ids, ['se-698098'])
  assert.equal(body.shipment.ship_from.postal_code, '91201')
  assert.equal(body.shipment.ship_to.postal_code, '02554')
  assert.equal(body.shipment.packages[0].weight.value, 32)
  assert.equal(body.shipment.packages[0].dimensions.length, 24)
  assert.equal(body.shipment.ship_to.address_residential_indicator, 'no', 'boutiques are commercial')
})

test('rateRequest omits dimensions when they were not captured', () => {
  const body = rateRequest({
    box: { weightLb: 5 }, destination: { city: 'Burbank', state: 'CA', postalCode: '91502' },
    carrierId: UPS_ACCOUNTS['18GE01'].carrierId,
  })
  assert.equal(body.shipment.packages[0].dimensions, undefined, 'sending zero dims would be quoted as a flat envelope')
})

test('rateRequest passes residential through — it is worth real money', () => {
  const resi = rateRequest({
    box: { weightLb: 5 }, destination: { city: 'Burbank', state: 'CA', postalCode: '91502' },
    carrierId: UPS_ACCOUNTS.C6J610.carrierId, residential: true,
  })
  assert.equal(resi.shipment.ship_to.address_residential_indicator, 'yes')
})

test('loadShipmentCosts batches, and collapses a repeated tracking number', async () => {
  // A multi-package ShipStation shipment can repeat a tracking number within one
  // page. Postgres refuses to update the same row twice in one INSERT … ON
  // CONFLICT, so the loader must dedupe before batching or a backfill dies partway.
  const statements = []
  const db = { query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 0 } } }
  const { loadShipmentCosts } = await import('../src/ingest/shipstationCosts.js')

  const rows = [
    { trackingNumber: '1ZC6J610000000001', upsAccount: 'C6J610', shipmentCost: 10 },
    { trackingNumber: '1ZC6J610000000001', upsAccount: 'C6J610', shipmentCost: 20 },
    { trackingNumber: '1ZC6J610000000002', upsAccount: 'C6J610', shipmentCost: 30 },
  ]
  const n = await loadShipmentCosts(rows, db)
  assert.equal(n, 2, 'the duplicate collapsed')
  assert.equal(statements.length, 1, 'one batched statement, not one per row')
  assert.match(statements[0].sql, /ON CONFLICT \(tracking_number\) DO UPDATE/)
  assert.equal(statements[0].params.length, 40, '2 rows × 20 columns')
  assert.equal(statements[0].params[16], 20, 'the LAST occurrence wins')
})

test('loadShipmentCosts respects the batch size so the parameter limit is never hit', async () => {
  const statements = []
  const db = { query: async (sql, params) => { statements.push(params.length); return { rowCount: 0 } } }
  const { loadShipmentCosts } = await import('../src/ingest/shipstationCosts.js')
  const rows = Array.from({ length: 250 }, (_, i) => ({ trackingNumber: `1ZC6J61000000${String(i).padStart(4, '0')}`, upsAccount: 'C6J610' }))
  await loadShipmentCosts(rows, db, { batchSize: 100 })
  assert.deepEqual(statements, [2000, 2000, 1000], '100+100+50 rows × 20 columns')
  // 500 × 20 = 10,000 bound parameters, well under Postgres's 65,535 ceiling.
  assert.ok(500 * 20 < 65535)
})
