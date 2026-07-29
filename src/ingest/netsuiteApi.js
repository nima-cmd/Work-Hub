// src/ingest/netsuiteApi.js — read-only NetSuite SuiteQL client (Token-Based
// Auth, OAuth 1.0a HMAC-SHA256). This is an EXTERNAL client that only issues
// SuiteQL SELECT queries: it cannot INSERT/UPDATE/DELETE and no SuiteScript runs
// inside NetSuite, so it can't affect any fulfillment/billing/workflow. The token
// is additionally bound to a read-only role. See docs/netsuite-api-integration.md.
//
// Soft-disables when the 5 NS_* env vars are absent: runSuiteQL returns
// { ok:false, configured:false, rows:[] } instead of throwing, exactly like the
// Google integrations — so the app (and its CSV-import fallback) works before the
// integration is wired, and lights up once the credentials land.

import crypto from 'node:crypto'

// Account id normalisation: the REST host and the OAuth realm both want the
// account id UPPERCASED with any hyphen turned into an underscore
// (e.g. "1234567-sb1" → "1234567_SB1").
export function normalizeAccount(account) {
  return String(account || '').toUpperCase().replace(/-/g, '_')
}

function suiteqlUrl(account) {
  return `https://${normalizeAccount(account)}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`
}

// The 5 credentials, or null if any is missing (→ soft-disabled).
export function netsuiteCreds(env = process.env) {
  const account = env.NS_ACCOUNT_ID
  const consumerKey = env.NS_CONSUMER_KEY
  const consumerSecret = env.NS_CONSUMER_SECRET
  const tokenId = env.NS_TOKEN_ID
  const tokenSecret = env.NS_TOKEN_SECRET
  if (!account || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) return null
  return { account, consumerKey, consumerSecret, tokenId, tokenSecret }
}

export function netsuiteConfigured(env = process.env) {
  return !!netsuiteCreds(env)
}

// RFC-3986 percent-encoding for OAuth. encodeURIComponent leaves ! * ' ( )
// unescaped, but OAuth requires them escaped; ~ - _ . stay literal (unreserved).
export function oauthEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

// Build the OAuth 1.0a signature base string. `params` is the full set that must
// be signed: the oauth_* fields PLUS any URL query params (SuiteQL paginates via
// ?limit=&offset=, which DO participate; the JSON body does NOT). Exposed for
// unit testing — this sorting/encoding is the bug-prone part.
export function signatureBaseString(method, baseUrl, params) {
  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${oauthEncode(k)}=${oauthEncode(params[k])}`)
    .join('&')
  return [method.toUpperCase(), oauthEncode(baseUrl), oauthEncode(normalized)].join('&')
}

// Full Authorization header value for a request. nonce/timestamp are injectable
// so the signing is deterministic under test.
export function buildAuthHeader({ method, baseUrl, queryParams = {}, creds, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  }
  const base = signatureBaseString(method, baseUrl, { ...oauth, ...queryParams })
  const signingKey = `${oauthEncode(creds.consumerSecret)}&${oauthEncode(creds.tokenSecret)}`
  const signature = crypto.createHmac('sha256', signingKey).update(base).digest('base64')

  // realm + the oauth_* fields (NOT the query params) go in the header.
  const headerParams = { ...oauth, oauth_signature: signature }
  const pieces = Object.keys(headerParams)
    .sort()
    .map((k) => `${oauthEncode(k)}="${oauthEncode(headerParams[k])}"`)
  return `OAuth realm="${normalizeAccount(creds.account)}", ${pieces.join(', ')}`
}

// Run a SuiteQL query, auto-paginating via limit/offset. Read-only.
// Returns { ok:true, rows, totalResults } on success; a soft marker
// ({ configured:false } | { needsAuth:true } | { error }) otherwise — never
// throws for an expected/auth condition, mirroring the Google helpers.
//   opts.pageSize  rows per request (NetSuite caps at 1000)
//   opts.maxPages  safety cap on pages fetched (default 50 → up to 50k rows)
//   opts._fetch    injectable fetch, for tests
export async function runSuiteQL(sql, opts = {}) {
  const { pageSize = 1000, maxPages = 50, _fetch = fetch } = opts
  const creds = netsuiteCreds(opts.env)
  if (!creds) return { ok: false, configured: false, rows: [] }

  const baseUrl = suiteqlUrl(creds.account)
  const rows = []
  let offset = 0
  let totalResults = null

  for (let page = 0; page < maxPages; page++) {
    const queryParams = { limit: String(pageSize), offset: String(offset) }
    const authHeader = buildAuthHeader({ method: 'POST', baseUrl, queryParams, creds })
    const url = `${baseUrl}?limit=${pageSize}&offset=${offset}`
    let res
    try {
      res = await _fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Prefer: 'transient', // don't persist a query definition in NetSuite
        },
        body: JSON.stringify({ q: sql }),
      })
    } catch (e) {
      return { ok: false, error: `network: ${e?.message || e}`, rows }
    }

    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '')
      return { ok: false, needsAuth: true, status: res.status, error: body, rows }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: body, rows }
    }

    const data = await res.json()
    if (Array.isArray(data.items)) rows.push(...data.items)
    if (typeof data.totalResults === 'number') totalResults = data.totalResults
    if (!data.hasMore) break
    offset += pageSize
  }

  return { ok: true, rows, totalResults: totalResults ?? rows.length }
}
