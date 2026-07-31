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

// ── Concurrency governance: the ONLY real limit on this integration ──────────
// There is no daily call quota on SuiteQL/REST. What NetSuite governs is how
// many requests run AT ONCE, and that allowance is shared with Celigo — which
// is the integration that must not lose. So a saturated account is a normal,
// expected, temporary condition here, not a failure: it means Celigo is working.
//
// ⚠️ We deliberately DO NOT RETRY on this. A retry loop is precisely how a
// human pressing a button would take concurrency away from Celigo — the thing
// we're trying to protect. Fail immediately, say plainly that NetSuite is busy,
// and let the person press it again. Slow and honest beats fast and rude.
export const BUSY_CODES = [
  'SSS_REQUEST_LIMIT_EXCEEDED',        // SuiteTalk/REST concurrency governance
  'CONCURRENT_REQUEST_LIMIT_EXCEEDED',
  'REQUEST_LIMIT_EXCEEDED',
  'SSS_CONCURRENCY_LIMIT_EXCEEDED',
  'WS_REQUEST_BLOCKED',                // request queued/blocked behind others
]

// Busy is detected from the STATUS or the BODY, not just the status: NetSuite is
// not consistent about pairing 429 with these codes, and a concurrency rejection
// dressed as a 400 must not read as "the query is wrong".
export function isBusyResponse(status, body = '') {
  if (Number(status) === 429) return true
  const t = String(body || '').toUpperCase()
  return BUSY_CODES.some((c) => t.includes(c))
}

// Seconds NetSuite asks us to wait, when it says. Advisory only — nothing here
// sleeps on it; it's for telling the human how long to give it.
export function retryAfterSeconds(headers) {
  const v = headers?.get?.('retry-after')
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Run a SuiteQL query, auto-paginating via limit/offset. Read-only.
// Returns { ok:true, rows } on success; a soft marker
// ({ configured:false } | { needsAuth:true } | { error }) otherwise — never
// throws for an expected/auth condition, mirroring the Google helpers.
//
// ⚠️ We deliberately do NOT surface the response's `totalResults`. Measured live
// 2026-07-30 it is NOT a row count — it came back as exactly pageSize × 1000
// (3000 at pageSize 3, 5000 at pageSize 5) while the true count from
// `SELECT COUNT(*)` was 5,926. Trusting it would silently truncate or
// mis-report. Termination is driven by the response's `hasMore` flag; when you
// need a real total, run a COUNT(*) query.
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
  let truncated = true // flipped false the moment NetSuite says hasMore=false

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

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        return { ok: false, needsAuth: true, status: res.status, error: body, rows }
      }
      // Checked BEFORE the generic branch: a concurrency rejection is Celigo
      // holding the line, not a broken query, and the two need opposite
      // responses from whoever is reading the message.
      if (isBusyResponse(res.status, body)) {
        return {
          ok: false,
          busy: true,
          status: res.status,
          retryAfter: retryAfterSeconds(res.headers),
          error: 'NetSuite is at its concurrent-request limit',
          rows,
        }
      }
      return { ok: false, status: res.status, error: body, rows }
    }

    const data = await res.json()
    if (Array.isArray(data.items)) rows.push(...data.items)
    if (!data.hasMore) {
      truncated = false
      break
    }
    offset += pageSize
  }

  // truncated=true means we stopped at maxPages while NetSuite still had more —
  // a SILENT partial result otherwise, which would look like "that's all of it".
  // Callers must treat this as incomplete (and the sync logs it).
  return { ok: true, rows, truncated }
}
