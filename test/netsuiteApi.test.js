// Unit tests for the NetSuite SuiteQL client (no network, no creds required).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeAccount,
  oauthEncode,
  signatureBaseString,
  buildAuthHeader,
  netsuiteCreds,
  netsuiteConfigured,
  runSuiteQL,
} from '../src/ingest/netsuiteApi.js'

const CREDS = {
  account: '1234567-sb1',
  consumerKey: 'ck',
  consumerSecret: 'cs',
  tokenId: 'tk',
  tokenSecret: 'ts',
}
const FAKE_ENV = {
  NS_ACCOUNT_ID: '1234567-sb1',
  NS_CONSUMER_KEY: 'ck',
  NS_CONSUMER_SECRET: 'cs',
  NS_TOKEN_ID: 'tk',
  NS_TOKEN_SECRET: 'ts',
}
const BASE_URL = 'https://X.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql'

test('normalizeAccount: uppercases and hyphen→underscore', () => {
  assert.equal(normalizeAccount('1234567-sb1'), '1234567_SB1')
  assert.equal(normalizeAccount('acme'), 'ACME')
})

test('oauthEncode: escapes !*\'() but leaves unreserved -_.~', () => {
  assert.equal(oauthEncode("a!b*c'd(e)f"), 'a%21b%2Ac%27d%28e%29f')
  assert.equal(oauthEncode('keep-_.~'), 'keep-_.~')
  assert.equal(oauthEncode('a b/c'), 'a%20b%2Fc')
})

test('signatureBaseString: sorted, encoded, RFC-compliant', () => {
  const params = {
    oauth_consumer_key: 'ck',
    oauth_token: 'tk',
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: '1700000000',
    oauth_nonce: 'nonce',
    oauth_version: '1.0',
    limit: '2',
    offset: '0',
  }
  const expected =
    'POST&' +
    'https%3A%2F%2FX.suitetalk.api.netsuite.com%2Fservices%2Frest%2Fquery%2Fv1%2Fsuiteql&' +
    'limit%3D2%26oauth_consumer_key%3Dck%26oauth_nonce%3Dnonce%26oauth_signature_method%3D' +
    'HMAC-SHA256%26oauth_timestamp%3D1700000000%26oauth_token%3Dtk%26oauth_version%3D1.0%26offset%3D0'
  assert.equal(signatureBaseString('POST', BASE_URL, params), expected)
})

test('buildAuthHeader: well-formed, deterministic, and sensitive to creds', () => {
  const args = { method: 'POST', baseUrl: BASE_URL, queryParams: { limit: '2', offset: '0' }, creds: CREDS, nonce: 'n1', timestamp: 1700000000 }
  const h1 = buildAuthHeader(args)
  const h2 = buildAuthHeader(args)
  assert.equal(h1, h2) // deterministic under fixed nonce/timestamp
  assert.match(h1, /^OAuth realm="1234567_SB1", /) // normalized realm
  assert.match(h1, /oauth_signature_method="HMAC-SHA256"/)
  assert.match(h1, /oauth_consumer_key="ck"/)
  assert.match(h1, /oauth_signature="[^"]+"/)

  // a different token secret must change the signature
  const h3 = buildAuthHeader({ ...args, creds: { ...CREDS, tokenSecret: 'DIFFERENT' } })
  const sig = (s) => s.match(/oauth_signature="([^"]+)"/)[1]
  assert.notEqual(sig(h1), sig(h3))

  // a different nonce must change the signature too
  const h4 = buildAuthHeader({ ...args, nonce: 'n2' })
  assert.notEqual(sig(h1), sig(h4))
})

test('netsuiteCreds/Configured: all-or-nothing', () => {
  assert.equal(netsuiteConfigured({}), false)
  assert.equal(netsuiteConfigured({ ...FAKE_ENV, NS_TOKEN_SECRET: undefined }), false)
  assert.equal(netsuiteConfigured(FAKE_ENV), true)
  assert.deepEqual(netsuiteCreds(FAKE_ENV), CREDS)
  assert.equal(netsuiteCreds({}), null)
})

test('runSuiteQL: soft-disables with no creds (never throws)', async () => {
  const r = await runSuiteQL('SELECT 1 FROM dual', { env: {} })
  assert.deepEqual(r, { ok: false, configured: false, rows: [] })
})

test('runSuiteQL: paginates until hasMore=false and concatenates rows', async () => {
  const calls = []
  const pages = [
    { items: [{ a: 1 }, { a: 2 }], hasMore: true, totalResults: 3 },
    { items: [{ a: 3 }], hasMore: false, totalResults: 3 },
  ]
  let i = 0
  const _fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
    const data = pages[i++]
    return { ok: true, status: 200, json: async () => data, text: async () => '' }
  }
  const r = await runSuiteQL('SELECT a FROM t', { env: FAKE_ENV, pageSize: 2, _fetch })
  assert.equal(r.ok, true)
  assert.equal(r.rows.length, 3)
  assert.equal(r.totalResults, 3)
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /offset=0/)
  assert.match(calls[1].url, /offset=2/)
  assert.equal(calls[0].body.q, 'SELECT a FROM t')
  assert.match(calls[0].auth, /^OAuth realm=/)
})

test('runSuiteQL: surfaces a 401 as needsAuth (soft, not thrown)', async () => {
  const _fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' })
  const r = await runSuiteQL('SELECT 1', { env: FAKE_ENV, _fetch })
  assert.equal(r.ok, false)
  assert.equal(r.needsAuth, true)
  assert.equal(r.status, 401)
})
