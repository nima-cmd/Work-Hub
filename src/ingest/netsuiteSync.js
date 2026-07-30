// src/ingest/netsuiteSync.js — the live NetSuite order-lifecycle pull.
//
// Read-only SuiteQL (see netsuiteApi.js) mapped into the SAME partial-record
// shape the CSV mappers in savedSearches.js emit, so it flows through the
// existing buildPipeline → loadToDb path untouched. The CSV import stays as the
// fallback; whichever ran most recently wins per natural key.
//
// Why this exists: the saved-search CSVs export OPEN work only, so an order that
// completes between manual uploads drops off the export and `pruneOrders` then
// deletes it — the app never sees it finish. Querying live lets us ask for "open
// PLUS anything that changed in the last N days", so terminal states are
// observed instead of vanishing.
//
// All status codes below were measured against the live account 2026-07-30 (see
// docs/netsuite-api-integration.md); NetSuite exposes them as single letters.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { STAGE } from '../model/stages.js'
import { cleanName } from './savedSearches.js'
import { buildPipeline } from '../model/pipeline.js'
import { deriveSource } from '../model/source.js'
// NOTE: db.js / loadToDb.js are imported LAZILY inside syncFromNetsuite. db.js
// throws at import time when DATABASE_URL is unset, and `npm test` runs without
// --env-file — so a top-level import here would break the "unit tests need no DB"
// contract just by importing this module's pure mappers.

// ── status maps (live-measured) ──────────────────────────────────────────────
// Sales Order. B/D/F are still in the open pipeline; G/H are terminal.
export const SO_STATUS = {
  A: 'Pending Approval',
  B: 'Pending Fulfillment',
  D: 'Partially Fulfilled',
  E: 'Pending Billing/Partially Fulfilled',
  F: 'Pending Billing',
  G: 'Billed',
  H: 'Closed',
}
export const SO_OPEN_CODES = ['A', 'B', 'D', 'E', 'F']
export const SO_TERMINAL_CODES = ['G', 'H']

// Item Fulfillment. This is the ONLY reliable shipped signal —
// transaction.shipstatus 500s, so read transaction.status.
export const IF_STATUS = { A: 'Picked', B: 'Packed', C: 'Shipped' }

// Invoice.
export const INV_STATUS = { A: 'Open', B: 'Paid In Full' }

const nOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 'YYYY-MM-DD' N days before today (UTC-ish; a day either side is harmless for a
// look-back window). Injectable `now` keeps it testable.
export function windowStart(days, now = new Date()) {
  const d = new Date(now.getTime() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

// ── mappers: SuiteQL row → partial pipeline record ───────────────────────────

// A Sales Order row. Mirrors fromOpenSalesOrders' output contract.
// `stage` from this row alone: terminal → SHIPPED, an invoice → INVOICED
// (buildPipeline may promote it via shippingStatus), on-hold → ON_HOLD, else
// OPEN. Picked/Packed/Shipped from the IF records merge in by SO# via
// furthestStage, exactly as with the CSVs.
export function mapOrderRow(row) {
  const code = row.status || ''
  const terminal = SO_TERMINAL_CODES.includes(code)
  const soStatus = SO_STATUS[code] || code || ''

  let stage = STAGE.OPEN
  if (terminal) stage = STAGE.SHIPPED
  else if (code === 'A') stage = STAGE.ON_HOLD

  return {
    source: 'NetSuiteLive',
    stage,
    soNumber: String(row.tranid || '').toUpperCase(),
    // NetSuite prefixes the entity id ("533 Centre Point Nantucket"); the CSV
    // path stores it stripped, so match that or every customer name would churn.
    customer: cleanName(row.customer || ''),
    location: row.location || '',
    poNumber: row.otherrefnum || '',
    soStatus,
    // The ATS custom field isn't reachable over SuiteQL yet, so leave it null —
    // loadOrders COALESCEs is_ats so a null preserves whatever the CSV knew.
    isAts: null,
    shipDate: row.shipdate || null,
    startDate: row.trandate || null,
    // Order value; feeds the shipped-$ credit fallback.
    amountPaid: nOrNull(row.foreigntotal),
    // Terminal orders are, by definition, fully billed — that's what makes the
    // recently-closed window able to close an order out instead of losing it.
    billingStatus: terminal ? 'Fully Billed' : null,
    netsuiteStatusCode: code,
    terminal,
  }
}

// An Item Fulfillment row. status C (Shipped) also supplies actualShipDate —
// which is what stamps the SHIPPED_VALUE credit.
export function mapFulfillmentRow(row) {
  const code = row.status || ''
  const ifStatus = IF_STATUS[code] || code || ''
  const shipped = code === 'C'
  return {
    source: 'NetSuiteLive',
    stage: shipped ? STAGE.SHIPPED : code === 'B' ? STAGE.PACKED : STAGE.PICKED,
    soNumber: String(row.so_number || '').toUpperCase(),
    ifNumber: String(row.if_number || '').toUpperCase(),
    ifStatus,
    date: row.trandate || null,
    actualShipDate: shipped ? row.trandate || null : null,
  }
}

// An Invoice row. amountRemaining is what's still owed (0 once paid);
// amountTotal is the stable value the credit falls back to.
export function mapInvoiceRow(row) {
  const code = row.status || ''
  return {
    source: 'NetSuiteLive',
    soNumber: String(row.so_number || '').toUpperCase(),
    invoice: String(row.inv_number || '').toUpperCase(),
    invoiceStatus: INV_STATUS[code] || code || '',
    amountRemaining: nOrNull(row.foreignamountunpaid),
    amountTotal: nOrNull(row.foreigntotal),
    shipDate: row.shipdate || null,
  }
}

// ── queries ──────────────────────────────────────────────────────────────────
// Kept deliberately simple: SuiteQL 500s on GROUP BY BUILTIN.DF over large sets,
// and `createdfrom` isn't queryable (join PreviousTransactionLineLink instead).
// The link table is LINE-level, so every child join needs DISTINCT.

const openOrRecent = (since) =>
  `(t.status IN (${SO_OPEN_CODES.map((c) => `'${c}'`).join(',')}) OR t.lastmodifieddate >= TO_DATE('${since}','YYYY-MM-DD'))`

export function orderSql(since) {
  return `SELECT t.tranid, BUILTIN.DF(t.entity) AS customer, t.status,
                 TO_CHAR(t.trandate,'YYYY-MM-DD') AS trandate,
                 TO_CHAR(t.shipdate,'YYYY-MM-DD') AS shipdate,
                 t.foreigntotal, t.otherrefnum
          FROM transaction t
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// One location per SO, off the lines (the header has none). Multiple lines can
// disagree; we keep the first non-null, same as the CSV's "Maximum of Location".
export function locationSql(since) {
  return `SELECT DISTINCT t.tranid, BUILTIN.DF(tl.location) AS location
          FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
          WHERE t.type='SalesOrd' AND tl.mainline='F' AND ${openOrRecent(since)}`
}

export function fulfillmentSql(since) {
  return `SELECT DISTINCT c.tranid AS if_number, t.tranid AS so_number, c.status,
                 TO_CHAR(c.trandate,'YYYY-MM-DD') AS trandate
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='ItemShip'
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// Tracking numbers per IF. NetSuite exposes these ONLY via the TrackingNumberMap
// join (transaction.trackingnumbers / linkedtrackingnumbers are not queryable
// fields — both fail as unknown identifiers). One IF can have several rows when the
// shipment is multi-box.
export function trackingSql(since) {
  return `SELECT DISTINCT c.tranid AS if_number, tn.trackingnumber
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='ItemShip'
          JOIN TrackingNumberMap m ON m.transaction = c.id
          JOIN trackingnumber tn ON tn.id = m.trackingnumber
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

export function invoiceSql(since) {
  return `SELECT DISTINCT c.tranid AS inv_number, t.tranid AS so_number, c.status,
                 c.foreigntotal, c.foreignamountunpaid,
                 TO_CHAR(c.shipdate,'YYYY-MM-DD') AS shipdate
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='CustInvc'
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// ── the pull ─────────────────────────────────────────────────────────────────
// Returns { ok, records, soNumbers, ifNumbers, counts, truncated, warnings }.
// `records` is the flat partial-record list to hand to buildPipeline.
// Soft-fails (never throws) so a scheduled run can log and leave data intact.
export async function fetchOrderLifecycle({ closedWithinDays = 30, now } = {}) {
  if (!netsuiteConfigured()) return { ok: false, configured: false, records: [] }
  const since = windowStart(closedWithinDays, now)
  const warnings = []

  const run = async (label, sql) => {
    const r = await runSuiteQL(sql)
    if (!r.ok) return { fail: `${label}: ${r.needsAuth ? 'auth rejected' : r.error || 'failed'}` }
    if (r.truncated) warnings.push(`${label}: hit the page cap — result is INCOMPLETE`)
    return { rows: r.rows }
  }

  const orders = await run('orders', orderSql(since))
  if (orders.fail) return { ok: false, error: orders.fail, records: [] }
  const locs = await run('locations', locationSql(since))
  if (locs.fail) return { ok: false, error: locs.fail, records: [] }
  const ifs = await run('fulfillments', fulfillmentSql(since))
  if (ifs.fail) return { ok: false, error: ifs.fail, records: [] }
  const invs = await run('invoices', invoiceSql(since))
  if (invs.fail) return { ok: false, error: invs.fail, records: [] }
  const track = await run('tracking', trackingSql(since))
  if (track.fail) return { ok: false, error: track.fail, records: [] }

  // first non-null location per SO
  const locBySo = new Map()
  for (const r of locs.rows) {
    const so = String(r.tranid || '').toUpperCase()
    if (r.location && !locBySo.has(so)) locBySo.set(so, r.location)
  }

  // tracking numbers grouped per IF (multi-box shipments have several)
  const trackByIf = new Map()
  for (const r of track.rows) {
    const k = String(r.if_number || '').toUpperCase()
    if (!k || !r.trackingnumber) continue
    if (!trackByIf.has(k)) trackByIf.set(k, [])
    const arr = trackByIf.get(k)
    if (!arr.includes(r.trackingnumber)) arr.push(r.trackingnumber)
  }

  const orderRecords = orders.rows.map((r) =>
    mapOrderRow({ ...r, location: locBySo.get(String(r.tranid || '').toUpperCase()) || '' }),
  )
  const ifRecords = ifs.rows.map(mapFulfillmentRow).map((f) => ({
    ...f,
    trackingNumbers: trackByIf.get(f.ifNumber) || null,
  }))
  const invRecords = invs.rows.map(mapInvoiceRow)

  return {
    ok: true,
    records: [...orderRecords, ...ifRecords, ...invRecords],
    soNumbers: orderRecords.map((o) => o.soNumber),
    ifNumbers: ifRecords.map((f) => f.ifNumber),
    counts: {
      orders: orderRecords.length,
      terminal: orderRecords.filter((o) => o.terminal).length,
      fulfillments: ifRecords.length,
      invoices: invRecords.length,
    },
    since,
    warnings,
  }
}

// ── the sync ─────────────────────────────────────────────────────────────────
// Pull → buildPipeline → load, all inside ONE transaction (same contract as
// importer.js: a bad row rolls the whole sync back rather than half-writing).
//
// Deliberately does NOT call pruneOrders. That prunes by ABSENCE from the master
// export and cascades to fulfillments — safe for a full open-orders CSV, but a
// live window is a different set, so pruning against it could delete live data.
// The live pull doesn't need it: it observes an order's REAL terminal status and
// records it (stage SHIPPED + Fully Billed), which is the whole point — the app
// sees orders finish instead of having them vanish.
//
// dryRun rolls the transaction back at the end, so every statement is exercised
// against real data and nothing persists.
export async function syncFromNetsuite({ closedWithinDays = 30, dryRun = false } = {}) {
  const pulled = await fetchOrderLifecycle({ closedWithinDays })
  if (!pulled.ok) return { ok: false, configured: pulled.configured, error: pulled.error }

  const orders = buildPipeline(pulled.records, { today: new Date() })
  for (const o of orders) o.source = deriveSource(o.customer, o.location)

  const { withTransaction } = await import('../db.js')
  const {
    loadOrders, loadFulfillments, loadInvoices, recordSnapshot,
    stampApprovedForShipping, stampShippedValue, clearDepartedCustody,
    reconcileFulfillments,
  } = await import('./loadToDb.js')

  const ROLLBACK = Symbol('dry-run rollback')
  let result
  try {
    result = await withTransaction(async (db) => {
      const nOrders = await loadOrders(orders, db)
      const nFul = await loadFulfillments(pulled.records, db)
      const nInv = await loadInvoices(pulled.records, db)
      await stampApprovedForShipping(pulled.records, db)
      const nCredits = await stampShippedValue(pulled.records, db)
      await clearDepartedCustody(pulled.records, db)
      // Kill fulfillments that no longer exist in NetSuite, scoped to the SOs we
      // actually pulled (see reconcileFulfillments — never a whole-table prune).
      const nPhantoms = await reconcileFulfillments(pulled.soNumbers, pulled.ifNumbers, db)
      await recordSnapshot('netsuiteLive', orders.length, new Date(), db)
      const out = { nOrders, nFul, nInv, nCredits, nPhantoms }
      if (dryRun) {
        const e = new Error('dry run')
        e.code = ROLLBACK
        e.partial = out
        throw e
      }
      return out
    })
  } catch (e) {
    if (e?.code === ROLLBACK) {
      return { ok: true, dryRun: true, ...e.partial, counts: pulled.counts, since: pulled.since, warnings: pulled.warnings, rolledBack: true }
    }
    return { ok: false, error: e?.message || String(e) }
  }

  return { ok: true, ...result, counts: pulled.counts, since: pulled.since, warnings: pulled.warnings }
}
