// src/ingest/shipstationCosts.js — pull what UPS actually BILLED, from ShipStation.
//
// Why this exists: the wholesale UPS account (C6J610) can't be rate-quoted through
// ShipStation until Nima reconnects the carrier, but every label ever bought on it
// through ShipStation recorded the real billed cost alongside the weight, the
// dimensions and the destination. That history is the only source of true wholesale
// pricing we can reach today. See src/model/upsRates.js for the reasoning and for
// the rule that a non-wholesale figure is never presented as wholesale.
//
// READ-ONLY against ShipStation — every call here is a GET on /shipments. A
// ShipStation key *can* buy labels, so nothing in this file posts anything.
//
// Which account paid is NOT a field on the shipment: the record carries only
// carrierCode "ups". It has to be read out of the 1Z tracking number, which embeds
// the six-character UPS shipper number. accountFromTracking does that.
//
// Rate limits: V1 allows 40 requests/minute and answers 429 with an
// X-Rate-Limit-Reset (seconds). A full backfill is ~280 pages, so this waits out
// the reset rather than hammering — a backfill is slow but unattended.
import { accountFromTracking, toPounds, isoDate } from '../model/upsRates.js'

const V1 = 'https://ssapi.shipstation.com'

export function shipstationConfigured() {
  return Boolean(process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET)
}

const authHeader = () =>
  'Basic ' + Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString('base64')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One GET, with 429 back-off. Returns { ok, data } — never throws on HTTP status,
// so a partial backfill reports how far it got instead of dying.
async function get(path, { maxRetries = 6 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res
    try {
      res = await fetch(V1 + path, { headers: { Authorization: authHeader(), Accept: 'application/json' } })
    } catch (e) {
      if (attempt === maxRetries) return { ok: false, error: `network: ${e.message}` }
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('x-rate-limit-reset')) || 60
      await sleep((wait + 1) * 1000)
      continue
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json().catch(() => null) }
  }
  return { ok: false, error: 'rate limited past the retry budget' }
}

// A ShipStation shipment → the row we store. Weight is normalized to POUNDS here
// (ShipStation reports ounces for small parcels and pounds for big boxes; storing
// the raw mix would make every later weight comparison wrong).
export function mapShipmentRow(s) {
  const tracking = s?.trackingNumber ? String(s.trackingNumber).trim() : null
  if (!tracking) return null
  return {
    trackingNumber: tracking,
    upsAccount: accountFromTracking(tracking),
    shipstationId: s.shipmentId ?? null,
    orderNumber: s.orderNumber ?? null,
    carrierCode: s.carrierCode ?? null,
    serviceCode: s.serviceCode ?? null,
    shipDate: isoDate(s.shipDate),
    createDate: s.createDate ?? null,
    weightLb: toPounds(s.weight?.value, s.weight?.units),
    lengthIn: s.dimensions?.length ?? null,
    widthIn: s.dimensions?.width ?? null,
    heightIn: s.dimensions?.height ?? null,
    destPostal: s.shipTo?.postalCode ?? null,
    destState: s.shipTo?.state ?? null,
    destCity: s.shipTo?.city ?? null,
    destResidential: s.shipTo?.residential ?? null,
    shipmentCost: s.shipmentCost ?? null,
    insuranceCost: s.insuranceCost ?? null,
    voided: Boolean(s.voided),
    storeId: s.advancedOptions?.storeId ?? null,
  }
}

// Count the pull by account so the operator can see at a glance whether any
// wholesale history came back — a run that returns only 18GE01 rows has not
// achieved the point of the exercise.
export function countByAccount(rows) {
  const out = {}
  for (const r of rows) {
    const k = r.upsAccount || '(unknown)'
    out[k] = out[k] || { n: 0, withCost: 0, costSum: 0 }
    out[k].n++
    if (r.shipmentCost > 0 && !r.voided) { out[k].withCost++; out[k].costSum += r.shipmentCost }
  }
  for (const v of Object.values(out)) v.avgCost = v.withCost ? Math.round((v.costSum / v.withCost) * 100) / 100 : null
  return out
}

// Page through /shipments for a carrier and date window.
export async function fetchShipments({ carrierCode = 'ups', from = null, to = null, maxPages = Infinity, onPage = null } = {}) {
  if (!shipstationConfigured()) return { ok: false, configured: false, rows: [] }
  const q = (page) => {
    const p = new URLSearchParams({ carrierCode, pageSize: '250', page: String(page), sortBy: 'CreateDate', sortDir: 'ASC' })
    if (from) p.set('createDateStart', from)
    if (to) p.set('createDateEnd', to)
    return `/shipments?${p}`
  }

  const head = await get(q(1))
  if (!head.ok) return { ok: false, error: head.error, rows: [] }
  const total = head.data?.total ?? 0
  const pages = Math.min(head.data?.pages ?? Math.ceil(total / 250), maxPages)

  const rows = []
  const take = (data) => {
    for (const s of data?.shipments || []) {
      const r = mapShipmentRow(s)
      if (r) rows.push(r)
    }
  }
  take(head.data)
  if (onPage) onPage({ page: 1, pages, rows: rows.length })

  for (let page = 2; page <= pages; page++) {
    const r = await get(q(page))
    if (!r.ok) return { ok: false, error: `page ${page}: ${r.error}`, rows, partial: true, total, pages }
    take(r.data)
    if (onPage) onPage({ page, pages, rows: rows.length })
  }
  return { ok: true, rows, total, pages, byAccount: countByAccount(rows) }
}

// The 20 columns each row supplies, in order. Named once so the INSERT column list,
// the placeholder builder and the value extractor cannot drift apart.
const COST_COLUMNS = [
  'tracking_number', 'ups_account', 'shipstation_id', 'order_number', 'carrier_code', 'service_code',
  'ship_date', 'create_date', 'weight_lb', 'length_in', 'width_in', 'height_in',
  'dest_postal', 'dest_state', 'dest_city', 'dest_residential',
  'shipment_cost', 'insurance_cost', 'voided', 'store_id',
]
const costValues = (r) => [
  r.trackingNumber, r.upsAccount, r.shipstationId, r.orderNumber, r.carrierCode, r.serviceCode,
  r.shipDate, r.createDate, r.weightLb, r.lengthIn, r.widthIn, r.heightIn,
  r.destPostal, r.destState, r.destCity, r.destResidential,
  r.shipmentCost, r.insuranceCost, r.voided, r.storeId,
]

// Upsert on the tracking number — a re-run of an overlapping window updates rather
// than duplicates, and a label voided after the fact corrects itself.
//
// Batched deliberately: a backfill is tens of thousands of rows, and one round trip
// per row to Neon turns a 5-minute job into an hour. 500 rows × 20 columns = 10,000
// bound parameters, comfortably under Postgres's 65,535 limit.
export async function loadShipmentCosts(rows, db, { batchSize = 500 } = {}) {
  const updates = COST_COLUMNS.filter((c) => c !== 'tracking_number')
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ')

  // A ShipStation page can repeat a tracking number (a multi-package shipment
  // shares one). Postgres rejects two updates to the same row in one statement
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so collapse
  // duplicates first, keeping the last occurrence.
  const deduped = [...new Map(rows.map((r) => [r.trackingNumber, r])).values()]

  let n = 0
  for (let i = 0; i < deduped.length; i += batchSize) {
    const chunk = deduped.slice(i, i + batchSize)
    const params = []
    const tuples = chunk.map((r) => {
      const vals = costValues(r)
      const start = params.length
      params.push(...vals)
      return `(${vals.map((_, k) => `$${start + k + 1}`).join(',')}, now())`
    })
    await db.query(
      `INSERT INTO ups_shipment_cost (${COST_COLUMNS.join(', ')}, synced_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (tracking_number) DO UPDATE SET ${updates}, synced_at = now()`,
      params,
    )
    n += chunk.length
  }
  return n
}

// Read back the billed history a rate lookup compares against. Scoped by account
// and service so the query stays small; the model does the geo/weight matching.
export async function fetchActuals({ account, serviceCode = null } = {}, db) {
  const params = [String(account || '').toUpperCase()]
  let sql = `SELECT tracking_number, ups_account, service_code, weight_lb,
                    dest_postal, dest_state, shipment_cost, ship_date, voided
               FROM ups_shipment_cost
              WHERE ups_account = $1 AND voided = false AND shipment_cost > 0`
  if (serviceCode) { params.push(String(serviceCode)); sql += ` AND service_code = $${params.length}` }
  const { rows } = await db.query(sql, params)
  return rows
}

export async function syncShipmentCosts({ from = null, to = null, carrierCode = 'ups', dryRun = false, onPage = null } = {}) {
  const pulled = await fetchShipments({ carrierCode, from, to, onPage })
  if (!pulled.ok && !pulled.rows.length) return pulled

  const { withTransaction } = await import('../db.js')
  const { recordSnapshot } = await import('./loadToDb.js')
  const ROLLBACK = Symbol('dry-run rollback')
  try {
    const loaded = await withTransaction(async (db) => {
      const n = await loadShipmentCosts(pulled.rows, db)
      await recordSnapshot('shipstationCosts', n, new Date(), db)
      if (dryRun) { const e = new Error('dry run'); e.code = ROLLBACK; e.partial = n; throw e }
      return n
    })
    return { ...pulled, ok: true, loaded }
  } catch (e) {
    if (e?.code === ROLLBACK) return { ...pulled, ok: true, loaded: e.partial, rolledBack: true }
    return { ok: false, error: e?.message || String(e), rows: pulled.rows }
  }
}
