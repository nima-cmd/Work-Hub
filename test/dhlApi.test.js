// test/dhlApi.test.js — the MyDHL client, with fetch stubbed.
//
// ⚠️ NOTHING HERE TOUCHES DHL. The live proof is in the PR; these pin the behaviour that
// only shows up when something is wrong — a missing credential, a refused account, a
// rate quoted in the wrong currency.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dhlCreds, dhlRates } from '../src/ingest/dhlApi.js'

const ENV = { DHL_API_KEY: 'key', DHL_API_SECRET: 'sec', DHL_ACCOUNT_NUMBER: '885857720' }
const LANE = {
  origin: { countryCode: 'US', cityName: 'Glendale', postalCode: '91201' },
  destination: { countryCode: 'PE', cityName: 'LIMA', postalCode: '15073' },
  parcel: { weightLb: 12, lengthIn: 18, widthIn: 14, heightIn: 12 },
  shipOn: '2026-09-22',
}
const okFetch = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
})

test('unconfigured names the missing variable, and does not call DHL', async () => {
  let called = false
  const r = await dhlRates({ ...LANE, env: {}, _fetch: async () => { called = true } })
  assert.equal(r.ok, false)
  assert.equal(r.configured, false)
  assert.match(r.error, /DHL_API_KEY/)
  assert.equal(called, false)
})

test('a secret set but no key still names the right one', () => {
  const r = dhlCreds({ DHL_API_SECRET: 'sec' })
  assert.equal(r.ok, false)
  assert.match(r.error, /DHL_API_KEY/)
})

test('⚠️ a refused account STOPS the call — no request is made', async () => {
  // Rating on the wrong account returns a perfectly plausible price, so the refusal has
  // to happen before the network, not be checked afterwards.
  let called = false
  const r = await dhlRates({
    ...LANE,
    origin: { countryCode: 'CN', cityName: 'Shenzhen' },
    env: ENV, _fetch: async () => { called = true },
  })
  assert.equal(r.ok, false)
  assert.equal(called, false, 'DHL was never asked')
  assert.equal(r.needsConfirmation, '940296615')
})

test('⚠️ the BILLED currency is quoted, not whichever price came first', async () => {
  // DHL returns several currency views of the same product. Taking [0] would quote
  // whichever it happened to order first.
  const r = await dhlRates({
    ...LANE, env: ENV,
    _fetch: okFetch({
      products: [{
        productCode: 'P', productName: 'EXPRESS WORLDWIDE',
        totalPrice: [
          { currencyType: 'BASEC', price: 999, priceCurrency: 'EUR' },
          { currencyType: 'BILLC', price: 247.95, priceCurrency: 'USD' },
        ],
      }],
    }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.products[0].price, 247.95)
  assert.equal(r.products[0].currency, 'USD')
})

test('products come back cheapest first', async () => {
  const p = (name, price) => ({ productName: name, productCode: name[0], totalPrice: [{ currencyType: 'BILLC', price, priceCurrency: 'USD' }] })
  const r = await dhlRates({
    ...LANE, env: ENV,
    _fetch: okFetch({ products: [p('MEDICAL EXPRESS', 1589.08), p('EXPRESS WORLDWIDE', 247.95), p('EXPRESS EASY', 1472.93)] }),
  })
  assert.deepEqual(r.products.map((x) => x.name), ['EXPRESS WORLDWIDE', 'EXPRESS EASY', 'MEDICAL EXPRESS'])
})

test("⚠️ DHL's own error sentence survives, because the fixes differ", async () => {
  // "Invalid Credentials" and "The account number is not found or invalid" are different
  // problems; collapsing both to "HTTP 400" is how an afternoon gets lost.
  const r = await dhlRates({
    ...LANE, env: ENV,
    _fetch: okFetch({ detail: '998: The account number is not found or invalid.' }, 400),
  })
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.error, /account number is not found/)
})

test('an unreachable DHL is reported as unreachable, not as a bad rate', async () => {
  const r = await dhlRates({ ...LANE, env: ENV, _fetch: async () => { throw new Error('ENOTFOUND') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /could not reach DHL/)
})

test('an unknown environment is refused before the network', async () => {
  let called = false
  const r = await dhlRates({ ...LANE, environment: 'staging', env: ENV, _fetch: async () => { called = true } })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown DHL environment/)
  assert.equal(called, false)
})

test('⚠️ the request declares customs — these are international goods', async () => {
  let url = null
  await dhlRates({ ...LANE, env: ENV, _fetch: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ products: [] }) } } })
  assert.match(url, /isCustomsDeclarable=true/)
  assert.match(url, /accountNumber=885857720/)
  // Test environment by default — nothing real is ever the default.
  assert.match(url, /mydhlapi\/test\//)
})

test('⚠️ THERE IS NO WAY TO BUY A LABEL FROM THIS MODULE', async () => {
  // The app prepares, a person commits — the ShipStation posture. If a createShipment
  // is ever added it takes an explicit confirmation rather than a default, and this
  // test should be updated deliberately, not deleted.
  const mod = await import('../src/ingest/dhlApi.js')
  const names = Object.keys(mod)
  assert.deepEqual(names.sort(), ['dhlCreds', 'dhlRates'])
})
