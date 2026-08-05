// src/ingest/shipstationTracking.js — what the carrier actually did, pulled back
// from ShipStation into the rows we pushed.
//
// Why this exists (Nima, 2026-08-05): the push had no memory, so Work-Hub could
// not tell a label existed. Nineteen Bloomingdale's cartons had real tracking
// numbers sitting in ShipStation while every one of their IFs still read
// `Picked` here, with no ASN and no invoice, and nothing anywhere able to say
// the next step was owed.
//
// ⚠️ READ-ONLY. Every call is a GET on /shipments. A ShipStation key can buy
// labels; nothing in this file posts anything, and nothing here marks anything
// shipped.
//
// ⚠️ A ship date from ShipStation is NOT a departure. It is the date the label
// was made out for, and on the EDI lane marking shipped happens deliberately
// AHEAD of the pickup to trigger the ASN (see src/model/orderEvents.js). The
// honest departure signal is the carrier's first MOVEMENT scan, which this
// endpoint does not carry — so nothing here claims one.

import { mapShipmentRow } from './shipstationCosts.js'

const V1 = 'https://ssapi.shipstation.com'

export function shipstationConfigured() {
  return Boolean(process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET)
}

const authHeader = () =>
  'Basic ' + Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString('base64')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One GET with 429 back-off, mirroring shipstationCosts.js. Returns {ok, data}
// and never throws on status, so a partial harvest reports how far it got.
async function get(path, { maxRetries = 5, fetchImpl = fetch } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res
    try {
      res = await fetchImpl(V1 + path, { headers: { Authorization: authHeader(), Accept: 'application/json' } })
    } catch (e) {
      if (attempt === maxRetries) return { ok: false, error: `network: ${e.message}` }
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (res.status === 429) {
      await sleep(((Number(res.headers.get('x-rate-limit-reset')) || 60) + 1) * 1000)
      continue
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json().catch(() => null) }
  }
  return { ok: false, error: 'rate limited past the retry budget' }
}

// A ShipStation /shipments row → what we store against our own order.
//
// ⚠️ A VOIDED label still has a tracking number, and ShipStation keeps the
// voided row alongside the live one — PO 8040313 DC CL carries three shipments
// for one carton, two of them voided reprints. Voided rows are kept (the reprint
// history is real) but flagged, and pickLive below never lets one win.
export function mapTracking(s) {
  if (!s?.orderKey) return null
  return {
    orderKey: String(s.orderKey),
    trackingNumber: s.trackingNumber ? String(s.trackingNumber).trim() : null,
    carrierCode: s.carrierCode || null,
    serviceCode: s.serviceCode || null,
    shipDate: s.shipDate ? String(s.shipDate).slice(0, 10) : null,
    shipmentCost: s.shipmentCost != null ? Number(s.shipmentCost) : null,
    voided: !!s.voided,
    labelAt: s.createDate || null,
  }
}

// One row per orderKey: the newest NON-voided label wins; if every label for a
// carton was voided, the newest voided one is kept so the card can say the label
// was made and then killed, rather than showing nothing at all.
export function pickLive(rows = []) {
  const best = new Map()
  for (const r of rows) {
    if (!r?.orderKey) continue
    const prev = best.get(r.orderKey)
    if (!prev) { best.set(r.orderKey, r); continue }
    const better = (prev.voided && !r.voided) ||
      (prev.voided === r.voided && String(r.labelAt || '') > String(prev.labelAt || ''))
    if (better) best.set(r.orderKey, r)
  }
  return [...best.values()]
}

// Harvest recent shipments and keep only the ones whose orderKey we minted.
// `ours` is the set of order keys from shipstation_order — an orderKey we did
// not push is not ours to claim, and ~99,000 retail shipments live in the same
// account.
export async function harvestTracking({ ours = new Set(), pages = 3, pageSize = 200, request = get } = {}) {
  if (!shipstationConfigured()) return { ok: false, configured: false, rows: [], scanned: 0 }
  const rows = []
  let scanned = 0
  for (let page = 1; page <= pages; page++) {
    const r = await request(`/shipments?pageSize=${pageSize}&page=${page}&sortBy=CreateDate&sortDir=DESC`)
    if (!r.ok) return { ok: false, configured: true, error: r.error, rows: pickLive(rows), scanned }
    const list = r.data?.shipments || []
    scanned += list.length
    for (const s of list) {
      const m = mapTracking(s)
      if (m && ours.has(m.orderKey)) rows.push(m)
    }
    if (!list.length || page >= (r.data?.pages || 1)) break
  }
  return { ok: true, configured: true, rows: pickLive(rows), scanned }
}

// ── Backfill ────────────────────────────────────────────────────────────────
//
// Orders pushed BEFORE shipstation_order existed (the 19 EDI cartons and 14
// boutique orders of 2026-08-05) have no row to harvest onto. This rebuilds one
// from ShipStation's own copy of the order.
//
// ⚠️ It PARSES the orderKey for the IF and carton, which the push path
// deliberately does not do — the push carries those values from the source data
// so the two can't drift. Here there is no source to carry from: the order in
// ShipStation is the only record that the push happened. That is exactly why
// the push writes its own row now.
export function recordFromOrder(o) {
  const key = String(o?.orderKey || '')
  const m = key.match(/^WH-(IF\d+)(?:-(\d+))?$/)
  if (!m) return null
  return {
    orderKey: key,
    ifNumber: m[1],
    cartonNo: m[2] ? Number(m[2]) : null,
    orderNumber: o.orderNumber || null,
    // A carton number is the EDI shape (one order per carton); boutique pushes
    // one order per IF and chooses its box in ShipStation.
    scope: m[2] ? 'edi' : 'boutique',
    storeId: o.advancedOptions?.storeId ?? null,
    shipstationId: o.orderId ?? null,
    // The PO is the leading segment of an EDI order number ('8040313-0061');
    // boutique line 1 is a customer PO or our SO, which is not a PO here.
    poNumber: m[2] ? (String(o.orderNumber || '').split('-')[0] || null) : null,
    dc: null,
  }
}

export async function backfillPushedOrders({ pages = 3, pageSize = 200, request = get } = {}) {
  if (!shipstationConfigured()) return { ok: false, configured: false, records: [] }
  const records = []
  for (let page = 1; page <= pages; page++) {
    const r = await request(`/orders?pageSize=${pageSize}&page=${page}&sortBy=CreateDate&sortDir=DESC`)
    if (!r.ok) return { ok: false, configured: true, error: r.error, records }
    const list = r.data?.orders || []
    for (const o of list) {
      const rec = recordFromOrder(o)
      if (rec) records.push(rec)
    }
    if (!list.length || page >= (r.data?.pages || 1)) break
  }
  return { ok: true, configured: true, records }
}

export { mapShipmentRow }
