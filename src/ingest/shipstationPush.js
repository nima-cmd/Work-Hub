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
import { partitionForShipstation, HOLD } from '../model/shipstationEligible.js'
import { labelTracking } from '../model/labelEvidence.js'

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
// `records` rides alongside `orders` so the push can be REMEMBERED (2026-08-05).
// It is built in this same loop on purpose: the alternative — a second function
// that re-derives if/carton/po/dc from the order object — is the two-copies shape
// that has produced a bug in this repo every time it has been tried. The record
// is not sent to ShipStation; only `orders` is.
export function ediOrdersFor(shipments = [], { storeId, now } = {}) {
  const out = [], records = []
  for (const s of shipments) {
    const w = s.labels
    if (!w?.applicable || !w.cartons) continue
    // Freight and FOB never get a parcel label; `applicable` already encodes that.
    for (const line of w.lines) {
      const order = buildEdiOrder({ shipment: s, line, storeId, now })
      out.push(order)
      records.push({
        orderKey: order.orderKey, orderNumber: order.orderNumber, scope: 'edi', storeId,
        ifNumber: line.ifNumber, cartonNo: line.cartonNo ?? line.seq ?? null,
        poNumber: line.poNumber ?? null, dc: s.dc ?? null,
      })
    }
  }
  return { orders: out, records }
}

// Boutique orders ship WITHOUT weight or dimensions on purpose — Nima boxes them in
// ShipStation exactly like retail. An order with no address is skipped and reported
// rather than pushed half-formed: a label to nowhere is worse than a missing one.
// ⚠️ The gate is now src/model/shipstationEligible.js, not an address check. Two of
// Nima's corrections on 2026-08-06 land here: the scope was inverted (Packed is the
// DONE pile), and only domestic UPS is set up in ShipStation. Everything declined is
// returned in `skipped` WITH ITS REASON so the warning names the fix — several of
// these are "make this label by hand", which is an instruction, not an error.
export function boutiqueOrdersFor(rows = [], { storeId, upsAccount, now } = {}) {
  const orders = [], skipped = [], records = []
  const { push, held } = partitionForShipstation(rows, (r) => ({
    status: r.order?.status ?? r.fulfilment?.status,
    labelCount: r.labelCount ?? 0,
    deadLabelCount: r.deadLabelCount ?? 0,
    carrier: r.carrier,
    shipMethod: r.shipMethod,
    shipMethodName: r.shipMethodName,
    country: r.address?.country,
    freightTerms: r.order?.freightTerms,
    hasAddress: !!r.address?.zip,
    thirdPartyAcct: r.thirdPartyAcct,
    thirdPartyZip: r.thirdPartyZip,
    readFailed: r.readFailed,
  }))
  for (const h of held) {
    // ⚠️ ALREADY_LABELLED CARRIES THE LIVE TRACKING NUMBERS, and no other hold does.
    // It is the only refusal a person can act on from the board — the way through is to
    // declare those labels unusable — and the numbers are right here, in the same
    // computation that decided the hold. Sending them back means the client needs no
    // second call and, more importantly, cannot disagree with the gate about WHICH
    // labels are counting.
    //
    // ⚠️ Deliberately NOT added to /api/orders instead: that payload carries `labelled`
    // as a boolean on purpose ("the board never shows them and the tracking list is
    // long"), and every card would pay for a list only this refusal needs.
    const entry = { ifNumber: h.row.fulfilment?.ifNumber, hold: h.hold, reason: h.reason }
    if (h.hold === HOLD.ALREADY_LABELLED) entry.tracking = liveTracking(h.row)
    skipped.push(entry)
  }
  for (const { row: r, serviceCode, billTo } of push) {
    // ⚠️ The resolved third party overrides whatever the row carried. buildBoutiqueOrder
    // bills our own Big Box account when it sees no billToAccount, so leaving this to
    // the row's own fields is how IF7405 got pushed on OUR account while the customer
    // had UPS 782847.
    const order = buildBoutiqueOrder({
      ...r,
      order: billTo
        ? { ...r.order, billToAccount: billTo.account, billToZip: billTo.zip, freightTerms: 'Third Party Bill' }
        : r.order,
      storeId, upsAccount, serviceCode, now,
    })
    orders.push(order)
    // No carton number: a boutique fulfilment pushes as ONE order and the box is
    // chosen in ShipStation, so there is nothing to number.
    records.push({
      orderKey: order.orderKey, orderNumber: order.orderNumber, scope: 'boutique', storeId,
      ifNumber: r.fulfilment?.ifNumber ?? null, cartonNo: null,
      poNumber: r.order?.poNumber ?? null, dc: null,
    })
  }
  return { orders, skipped, records }
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
// The requested carrier and service, from NetSuite (Nima, 2026-08-06: "We need
// shipstation to also pick up the requested shipping method as it's generally
// selected upon selection").
//
// ⚠️ DELIBERATELY A SEPARATE QUERY FROM fetchBoutiqueAddresses, not two more columns
// on its first SELECT. A NOT_EXPOSED column makes SuiteQL return ZERO ROWS instead of
// erroring — proven the same day against `thirdpartyacct` — so folding these in would
// mean that the day a field's permission changes, the ADDRESS lookup silently returns
// nothing and every order is skipped as "no ship-to address". Kept apart, a
// permission change costs us the carrier (which then holds the order, safely) and
// nothing else.
//
// `shipmethod` resolves to an opaque ID: `shipitem` and every sibling table return
// empty on the bot role. src/model/shipstationEligible.js maps the IDs we can name
// and holds the rest rather than guessing a service level.
// The labels that are actually counting against this fulfilment.
//
// ⚠️ USES labelTracking, the SAME function the gate used to reach its verdict, rather
// than re-deriving from the row. A dead label must not be offered for killing twice, and
// a voided ShipStation label is not evidence — both rules live in labelEvidence.js and
// there is no reason for a second opinion here.
export function liveTracking(row = {}) {
  return labelTracking({
    nsTracking: row.order?.nsTracking ?? row.nsTracking,
    ssTracking: row.order?.ssTracking ?? row.ssTracking,
    deadTracking: row.order?.deadTracking ?? row.deadTracking,
  })
}

export async function fetchBoutiqueShipMethods(ifNumbers = [], { runSuiteQL } = {}) {
  const out = new Map()
  if (!ifNumbers.length || !runSuiteQL) return out
  const list = ifNumbers.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')
  const r = await runSuiteQL(
    `SELECT tranid, shipcarrier, shipmethod FROM transaction WHERE tranid IN (${list})`)
  if (!r.ok) return out
  for (const row of r.rows) {
    out.set(row.tranid, { carrier: row.shipcarrier || null, shipMethod: row.shipmethod ?? null })
  }
  return out
}

// ── The requested service AND who pays, from the SALES ORDER record ─────────
//
// ⚠️ THIS SUPERSEDES fetchBoutiqueShipMethods ABOVE, WHICH READ THE WRONG THING.
//
// `transaction.shipcarrier` is a carrier GROUP, not a carrier: "FedEx/USPS/More"
// covers BOTH Fedex and DHL Express (proven — IF7450 is DHL Express and IF7452 is
// Fedex, and SuiteQL calls both "FedEx/USPS/More"). Gating on the group happened to
// hold the right two orders on 2026-08-06, for the wrong reason, and it would
// misclassify a "More"-group order that is actually UPS.
//
// The sales order REST record carries `shipMethod` as a READABLE NAME — "UPS®
// Ground", "Fedex", "DHL Express" — which is the actual service, and `thirdPartyAcct`,
// which is who pays. The customer record adds `thirdPartyZipCode`, which UPS needs to
// validate third-party billing, and which is NOT on the sales order.
//
// ⚠️ WHY THE SALES ORDER AND NOT THE ITEM FULFILMENT: the itemfulfillment REST record
// demands 'Transactions -> Fulfill Sales Orders' at **EDIT** level even for a GET,
// which would hand this deliberately read-only integration the power to fulfil
// orders. The sales order needs no extra permission at all.
//
// ⚠️ WHY THIS MATTERS, CONCRETELY: on 2026-08-06 IF7405 (Saint Bernard) was pushed
// billed to Naghedi's own Big Box account while the customer has UPS account 782847.
// Nothing had been purchased, so no money moved — but that is Naghedi paying freight
// the customer's account covers, which is the exact class of error
// src/model/upsRates.js exists to prevent. It was missed because the customer record
// was sampled for five other fulfilments and generalised from.
export async function fetchBoutiqueShipDetails(ifNumbers = [], soByIf = new Map(), { runSuiteQL, restGet, refName } = {}) {
  const out = new Map()
  if (!ifNumbers.length || !runSuiteQL || !restGet) return out
  const soNumbers = [...new Set(ifNumbers.map((n) => soByIf.get(n)).filter(Boolean))]
  if (!soNumbers.length) return out

  // The SO internal id, which SuiteQL gives cheaply and REST needs.
  const list = soNumbers.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')
  const q = await runSuiteQL(`SELECT id, tranid, entity FROM transaction WHERE tranid IN (${list})`)
  if (!q.ok) return out
  const meta = new Map(q.rows.map((r) => [r.tranid, { id: r.id, customerId: r.entity }]))

  // One customer can own several fulfilments, so the zip is fetched once per customer.
  const custCache = new Map()
  const customerZip = async (customerId) => {
    if (!customerId) return null
    if (custCache.has(customerId)) return custCache.get(customerId)
    const c = await restGet(`customer/${customerId}`)
    // ⚠️ Scan the keys rather than asserting the spelling: it is `thirdPartyZipCode`
    // with a capital C, and an explicit `thirdPartyZipcode` finds nothing silently.
    let zip = null, carrier = null
    if (c.ok && c.data) {
      for (const k of Object.keys(c.data)) {
        if (/^thirdpartyzipcode$/i.test(k)) zip = refName(c.data[k])
        if (/^thirdpartycarrier$/i.test(k)) carrier = refName(c.data[k])
      }
    }
    const v = { zip: zip || null, carrier: carrier || null }
    custCache.set(customerId, v)
    return v
  }

  for (const ifNumber of ifNumbers) {
    const so = soByIf.get(ifNumber)
    const m = so ? meta.get(so) : null
    if (!m) continue
    const r = await restGet(`salesorder/${m.id}`)
    if (!r.ok || !r.data) {
      // A read failure must not read as "no third party" — that would bill us.
      out.set(ifNumber, { shipMethodName: null, thirdPartyAcct: null, thirdPartyZip: null, readFailed: true, error: r.error || null })
      continue
    }
    let shipMethodName = null, thirdPartyAcct = null
    for (const k of Object.keys(r.data)) {
      if (/^shipmethod$/i.test(k)) shipMethodName = refName(r.data[k])
      if (/^thirdpartyacct$/i.test(k)) thirdPartyAcct = refName(r.data[k])
    }
    const cust = thirdPartyAcct ? await customerZip(m.customerId) : { zip: null, carrier: null }
    out.set(ifNumber, {
      shipMethodName: shipMethodName || null,
      thirdPartyAcct: thirdPartyAcct || null,
      thirdPartyZip: cust.zip,
      thirdPartyCarrier: cust.carrier,
      readFailed: false,
    })
  }
  return out
}

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
