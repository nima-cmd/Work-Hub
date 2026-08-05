// src/ingest/shipstationPush.js — create/update ShipStation orders so labels can be
// bought there instead of typed by hand.
//
// The agreed architecture (Nima, and unchanged since): THE APP PUSHES ORDERS, A
// HUMAN BUYS THE LABELS. Nothing here purchases anything — every order is created
// `awaiting_shipment` and the money step stays a deliberate human action.
//
// ── Everything below was learned against the live API on 2026-08-05 ─────────
//
// ⚠️ RATE LIMIT: 40 requests per 40 seconds (x-rate-limit-limit / -remaining /
// -reset). Exceed it and ShipStation answers **404 with an empty body**, not 429 —
// so a throttle is indistinguishable from "endpoint not found" unless you read the
// headers. This paces off `remaining` and sleeps for `reset` before it runs out.
//
// ⚠️ NEVER DELETE-THEN-RECREATE. ShipStation refuses to re-create an order whose
// orderKey was previously deleted (404, empty body, permanently). Since orderKey
// here is the carton's stable identity, every re-push is an in-place upsert and no
// delete is ever issued. This is not a preference — it is the difference between a
// re-runnable sync and one that bricks its own keys.
//
// ⚠️ WHAT PRINTS: only `orderNumber` (Label Message #1) and `customField2`
// (Message #2, whose token is literally `[Custom Field #2]` — the `#` matters; a
// pasted `[Custom Field 2]` prints as literal text, verified on a real label).
// See src/model/shipstationOrder.js for the field rules.

import { buildEdiOrder, buildBoutiqueOrder } from '../model/shipstationOrder.js'

const BASE = 'https://ssapi.shipstation.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function shipstationConfigured() {
  return Boolean(process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET)
}

function authHeader() {
  const k = process.env.SHIPSTATION_API_KEY, s = process.env.SHIPSTATION_API_SECRET
  return 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64')
}

// One request, pacing itself against the published rate limit and retrying a
// throttle. `remaining <= SAFETY` waits for the window rather than gambling on the
// next call being the one that 404s.
const SAFETY = 4
export async function ssRequest(method, path, body, { retries = 2, fetchImpl = fetch } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const remaining = Number(res.headers.get('x-rate-limit-remaining') ?? 99)
    const reset = Number(res.headers.get('x-rate-limit-reset') ?? 40)
    const text = await res.text()

    if (res.ok) {
      await sleep(remaining <= SAFETY ? (reset + 2) * 1000 : 900)
      return { ok: true, data: text ? JSON.parse(text) : null }
    }
    // A throttle looks like an EMPTY 404. A real 404 carries a message body, so the
    // empty-body test is what separates "slow down" from "no such thing".
    const throttled = res.status === 429 || (res.status === 404 && !text.trim())
    if (throttled && attempt < retries) { await sleep((reset + 2) * 1000); continue }
    return { ok: false, status: res.status, body: text.slice(0, 300), throttled }
  }
  return { ok: false, status: 'retries exhausted' }
}

/**
 * Upsert a set of already-built ShipStation orders.
 * Returns a per-order report — never throws on a single failure, because one bad
 * address must not strand the other eighteen.
 */
export async function pushOrders(orders = [], { dryRun = false, request = ssRequest } = {}) {
  if (!shipstationConfigured()) return { ok: false, configured: false, pushed: 0, results: [] }
  const results = []
  for (const o of orders) {
    if (dryRun) { results.push({ orderKey: o.orderKey, orderNumber: o.orderNumber, dryRun: true }); continue }
    const r = await request('POST', '/orders/createorder', o)
    results.push({
      orderKey: o.orderKey,
      orderNumber: o.orderNumber,
      ok: r.ok,
      orderId: r.data?.orderId ?? null,
      error: r.ok ? null : `${r.status}${r.throttled ? ' (throttled)' : ''} ${r.body || ''}`.trim(),
    })
  }
  return {
    ok: true, configured: true, dryRun,
    pushed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => x.ok === false).length,
    results,
  }
}

// Build the EDI (DC-direct parcel) orders for the shipments given. One order per
// CARTON: a parcel is one label, and there is no such thing as one master label
// covering a DC's cartons — that is a BOL, i.e. the freight lane.
export function ediOrdersFor(shipments = [], { storeId, now } = {}) {
  const out = []
  for (const s of shipments) {
    const w = s.labels
    if (!w?.applicable || !w.cartons) continue
    // Freight and FOB never get a parcel label; `applicable` already encodes that.
    for (const line of w.lines) out.push(buildEdiOrder({ shipment: s, line, storeId, now }))
  }
  return out
}

// Boutique orders ship WITHOUT weight or dimensions on purpose — Nima boxes them in
// ShipStation exactly like retail. An order with no address is skipped and reported
// rather than pushed half-formed: a label to nowhere is worse than a missing one.
export function boutiqueOrdersFor(rows = [], { storeId, upsAccount, now } = {}) {
  const orders = [], skipped = []
  for (const r of rows) {
    if (!r.address?.zip) { skipped.push({ ifNumber: r.fulfilment?.ifNumber, reason: 'no ship-to address' }); continue }
    orders.push(buildBoutiqueOrder({ ...r, storeId, upsAccount, now }))
  }
  return { orders, skipped }
}

// ── Boutique ship-to addresses, from NetSuite ───────────────────────────────
//
// Boutique fulfilments ship to the CUSTOMER, and Neon holds no address at all
// (checked: the orders table has no address-shaped column). NetSuite does, but it
// takes TWO steps and the obvious one is a trap:
//
//   transaction.shipaddress  -> a freeform blob whose lines duplicate each other
//                               ("6 Spencer Pl, Scarsdale, NY 10583" then
//                               "Scarsdale NY 10583"), which this repo already
//                               documents as not mapping to any single line.
//   transaction.shippingaddress -> an ADDRESS RECORD ID, which joins to
//                               transactionShippingAddress for STRUCTURED fields
//                               plus a phone.
//
// ⚠️ transactionShippingAddress keys on the ADDRESS id, not the transaction id —
// querying it by transaction returns an empty row rather than an error, which looks
// exactly like "this customer has no address".
export async function fetchBoutiqueAddresses(ifNumbers = [], { runSuiteQL } = {}) {
  const out = new Map()
  if (!ifNumbers.length || !runSuiteQL) return out
  const list = ifNumbers.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')
  const t = await runSuiteQL(
    `SELECT id, tranid, shippingaddress FROM transaction WHERE tranid IN (${list})`)
  if (!t.ok) return out
  const withAddr = t.rows.filter((r) => r.shippingaddress)
  if (!withAddr.length) return out
  const ids = [...new Set(withAddr.map((r) => r.shippingaddress))].join(',')
  const a = await runSuiteQL(
    `SELECT nkey, addressee, addr1, addr2, city, state, zip, country, addrphone
       FROM transactionShippingAddress WHERE nkey IN (${ids})`)
  if (!a.ok) return out
  const byId = new Map(a.rows.map((r) => [String(r.nkey), r]))
  for (const r of withAddr) {
    const addr = byId.get(String(r.shippingaddress))
    if (addr) {
      out.set(r.tranid, {
        addressee: addr.addressee, addr1: addr.addr1, addr2: addr.addr2,
        city: addr.city, state: addr.state, zip: addr.zip,
        country: addr.country || 'US', phone: addr.addrphone || null,
      })
    }
  }
  return out
}
