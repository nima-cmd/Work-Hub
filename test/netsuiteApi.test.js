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
  isBusyResponse,
  retryAfterSeconds,
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
  // totalResults is deliberately a LIE here (NetSuite reports pageSize×1000 in
  // real life) — the client must ignore it and trust hasMore instead.
  const pages = [
    { items: [{ a: 1 }, { a: 2 }], hasMore: true, totalResults: 2000 },
    { items: [{ a: 3 }], hasMore: false, totalResults: 2000 },
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
  assert.equal(r.truncated, false) // reached the true end
  assert.equal(r.totalResults, undefined) // never surfaced — it's not a row count
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /offset=0/)
  assert.match(calls[1].url, /offset=2/)
  assert.equal(calls[0].body.q, 'SELECT a FROM t')
  assert.match(calls[0].auth, /^OAuth realm=/)
})

test('runSuiteQL: flags truncated=true when it stops at maxPages mid-stream', async () => {
  // NetSuite still says hasMore, but we hit the page cap — must NOT look complete.
  const _fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({ items: [{ a: 1 }], hasMore: true }),
  })
  const r = await runSuiteQL('SELECT a FROM t', { env: FAKE_ENV, pageSize: 1, maxPages: 2, _fetch })
  assert.equal(r.ok, true)
  assert.equal(r.rows.length, 2)
  assert.equal(r.truncated, true)
})

test('runSuiteQL: surfaces a 401 as needsAuth (soft, not thrown)', async () => {
  const _fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' })
  const r = await runSuiteQL('SELECT 1', { env: FAKE_ENV, _fetch })
  assert.equal(r.ok, false)
  assert.equal(r.needsAuth, true)
  assert.equal(r.status, 401)
})

// ── Celigo-priority / concurrency governance ────────────────────────────────
// There is no daily call quota on SuiteQL — the limit is CONCURRENT requests,
// shared with Celigo. A saturated account is normal and temporary, so it has to
// be distinguishable from a real failure.

test('busy: a 429 is busy whatever the body says', () => {
  assert.equal(isBusyResponse(429, ''), true)
  assert.equal(isBusyResponse('429', 'anything'), true)
})

test('busy: a concurrency rejection dressed as a 400 is still busy', () => {
  // NetSuite is not consistent about pairing 429 with these codes, and reading
  // this as a malformed query would send someone to debug the SQL instead of
  // waiting for Celigo.
  const body = '{"o:errorDetails":[{"o:errorCode":"SSS_REQUEST_LIMIT_EXCEEDED"}]}'
  assert.equal(isBusyResponse(400, body), true)
  assert.equal(isBusyResponse(0, 'CONCURRENT_REQUEST_LIMIT_EXCEEDED'), true)
  assert.equal(isBusyResponse(0, 'ws_request_blocked'), true) // case-insensitive
})

test('busy: a genuine query error is NOT busy', () => {
  // The distinction that matters — this one is our bug, not Celigo's turn.
  assert.equal(isBusyResponse(400, 'Invalid or unsupported search'), false)
  assert.equal(isBusyResponse(500, 'UNEXPECTED_ERROR'), false)
  assert.equal(isBusyResponse(0, ''), false)
  assert.equal(isBusyResponse(0, null), false)
})

test('busy: runSuiteQL reports busy instead of a generic failure, and does NOT retry', async () => {
  let calls = 0
  const _fetch = async () => {
    calls++
    return {
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      text: async () => 'SSS_REQUEST_LIMIT_EXCEEDED',
    }
  }
  const r = await runSuiteQL('SELECT id FROM transaction', { _fetch, env: {
    NS_ACCOUNT_ID: CREDS.account, NS_CONSUMER_KEY: 'k', NS_CONSUMER_SECRET: 's',
    NS_TOKEN_ID: 't', NS_TOKEN_SECRET: 'ts',
  } })
  assert.equal(r.ok, false)
  assert.equal(r.busy, true)
  assert.equal(r.retryAfter, 30)
  // ONE attempt. Retrying is how a button steals concurrency from Celigo.
  assert.equal(calls, 1)
})

test('busy: an auth failure still outranks busy — 401 is not "come back later"', async () => {
  const _fetch = async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => 'nope' })
  const r = await runSuiteQL('SELECT id FROM transaction', { _fetch, env: {
    NS_ACCOUNT_ID: CREDS.account, NS_CONSUMER_KEY: 'k', NS_CONSUMER_SECRET: 's',
    NS_TOKEN_ID: 't', NS_TOKEN_SECRET: 'ts',
  } })
  assert.equal(r.needsAuth, true)
  assert.ok(!r.busy)
})

test('retryAfterSeconds: only a usable positive number', () => {
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '15' })), 15)
  assert.equal(retryAfterSeconds(new Headers()), null)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })), null)
  assert.equal(retryAfterSeconds(undefined), null)
})
