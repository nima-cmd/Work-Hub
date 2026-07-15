// server/queries.js — read orders (+ their fulfillments) from Neon and enrich
// each with the SAME pipeline flags the CLI analyzer uses, so UI and analyzer
// never disagree.

import { pool } from '../src/db.js'
import { computeFlags } from '../src/model/pipeline.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'
import { SOURCE_LABELS, REQUIRED_SOURCES } from '../src/ingest/detect.js'
import {
  fetchOrderConfirmations, fetchPurchaseOrders, fetchOcPoLinks,
  upsertOcPoLink, deleteOcPoLink, dismissOrderConfirmation, dismissPurchaseOrder,
} from '../src/ingest/loadToDb.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeContainerView } from '../src/model/ocPoContainers.js'
import { computeEdiPipeline } from '../src/model/ediPipeline.js'
import { fetchEdiTransactions, syncOrderful, fetchEdiDocumentPoRefs } from '../src/ingest/orderful.js'
import {
  fetchEdiFulfillments, fetchEdiManualLinks, upsertEdiManualLink, deleteEdiManualLink,
} from '../src/ingest/loadToDb.js'

export async function getOrders() {
  // Subqueries (not joins+GROUP BY) for fulfillments and invoices: both are
  // one-to-many off orders, and joining both at once would cross-multiply
  // (2 fulfillments x 3 invoices = 6 rows) before aggregation.
  const { rows } = await pool.query(`
    SELECT o.*,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'ifNumber', f.if_number, 'status', f.status,
            'packedStatus', f.packed_status, 'daysPending', f.days_pending,
            'invoice', f.invoice_number, 'actualShipDate', f.actual_ship_date,
            'ifDate', f.if_date
          ) ORDER BY f.if_number
        )
        FROM fulfillments f WHERE f.so_number = o.so_number
      ), '[]'::json) AS fulfillments,
      (SELECT MAX(f.days_pending) FROM fulfillments f WHERE f.so_number = o.so_number) AS days_pending,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'invNumber', i.inv_number, 'status', i.status,
            'shippingStatus', i.shipping_status,
            'amountRemaining', i.amount_remaining, 'shipDate', i.ship_date
          ) ORDER BY i.inv_number
        )
        FROM invoices i WHERE i.so_number = o.so_number
      ), '[]'::json) AS invoices
    FROM orders o
  `)

  const today = new Date()
  return rows.map((r) => {
    const o = {
      soNumber: r.so_number,
      customer: r.customer,
      location: r.location,
      isAts: r.is_ats,
      source: r.source,
      stage: r.stage,
      stageLabel: STAGE_LABEL[r.stage] || r.stage,
      stageRank: STAGE_RANK[r.stage] || 0,
      nextAction: NEXT_ACTION[r.stage] || '',
      poNumber: r.po_number,
      soStatus: r.so_status,
      qtyOrdered: num(r.qty_ordered),
      qtyAllocated: num(r.qty_allocated),
      qtyFulfilled: num(r.qty_fulfilled),
      shippingStatus: r.shipping_status,
      shipDate: r.ship_date,
      startDate: r.start_date,
      endDate: r.end_date,
      cancelDate: r.cancel_date,
      daysPending: r.days_pending,
      notes: r.notes,
      approvalStatus: r.approval_status,
      billingStatus: r.billing_status,
      amountPaid: num(r.amount_paid),
      fulfillments: r.fulfillments,
      invoices: r.invoices,
    }
    o.flags = computeFlags(o, today)
    o.severity = o.flags.reduce((m, f) => Math.max(m, f.severity), 0)
    return o
  })
}

const num = (v) => (v == null ? null : Number(v))

// Data-freshness: how old is the underlying export data? Uses the most recent
// snapshot per source and reports the STALEST one. Thresholds are the initial
// guess (warn 24h, stale 48h) — tune later once the real refresh cadence is known.
const WARN_HOURS = 24
const STALE_HOURS = 48

// Per-source freshness. Reports EVERY required export (not just ones we've
// seen) so a never-uploaded search shows as 'missing' rather than silently
// absent — that's how you know which export to go pull.
const STATUS_RANK = { missing: 4, stale: 3, warn: 2, unknown: 1, fresh: 0 }

export async function getFreshness() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (source) source, imported_at, file_modified
    FROM import_snapshots
    ORDER BY source, imported_at DESC
  `)
  const bySource = new Map(rows.map((r) => [r.source, r]))
  const now = Date.now()

  const sources = REQUIRED_SOURCES.map((key) => {
    const snap = bySource.get(key)
    const label = SOURCE_LABELS[key] || key
    if (!snap) return { key, label, status: 'missing', ageHours: null, fileModified: null, importedAt: null }
    const ageHours = snap.file_modified ? (now - new Date(snap.file_modified).getTime()) / 3.6e6 : null
    const status =
      ageHours == null ? 'unknown' : ageHours > STALE_HOURS ? 'stale' : ageHours > WARN_HOURS ? 'warn' : 'fresh'
    return { key, label, status, ageHours, fileModified: snap.file_modified, importedAt: snap.imported_at }
  })

  // Overall = the worst single source, so the header pill reflects the weakest link.
  const status = sources.reduce(
    (worst, s) => (STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst),
    'fresh',
  )
  const ages = sources.map((s) => s.ageHours).filter((a) => a != null)
  const maxAgeHours = ages.length ? Math.max(...ages) : null

  return { status, maxAgeHours, warnHours: WARN_HOURS, staleHours: STALE_HOURS, sources }
}

// ── OC↔PO allocation review — the "open task" queue ──────────────────────────
// Kept entirely manual (Nima, 2026-07-09): this reads current state and runs
// the matcher, but nothing here writes anything. Every OC/PO line that isn't
// yet committed to a link AND isn't dismissed shows up somewhere in this
// response — suggestedMatches, candidates, or unmatchedOcs/unmatchedPos — so
// the queue can't silently lose track of an order the way loose spreadsheets do.
export async function getOcPoReview() {
  const [ocs, pos, links] = await Promise.all([
    fetchOrderConfirmations(),
    fetchPurchaseOrders(),
    fetchOcPoLinks(),
  ])
  const { suggestedMatches, candidates, unmatchedOcs, unmatchedPos } = computeOcPoMatches({ ocs, pos, links })
  const { locations, containers, unassignedOcs } = computeContainerView({ ocs, pos, links })
  return { suggestedMatches, candidates, unmatchedOcs, unmatchedPos, links, locations, containers, unassignedOcs }
}

// ── EDI (Orderful) review — mirrors Airtable's 850 Tracker/856, pulled live
// from Orderful's API into Neon instead of via CSV → Airtable. ──────────────
// EDI-sourced orders only: their po_number reliably matches an Orderful
// business number, unlike boutique orders' free-text PO/check numbers.
async function fetchEdiSourcedOrders() {
  const { rows } = await pool.query(
    `SELECT o.po_number AS "poNumber", o.so_number AS "soNumber", o.stage,
      COALESCE((
        SELECT json_agg(json_build_object(
          'ifNumber', f.if_number, 'status', f.status,
          'actualShipDate', f.actual_ship_date, 'invoiceNumber', f.invoice_number
        ))
        FROM fulfillments f WHERE f.so_number = o.so_number
      ), '[]'::json) AS "itemFulfillments",
      COALESCE((
        SELECT json_agg(json_build_object(
          'invNumber', i.inv_number, 'status', i.status, 'amountRemaining', i.amount_remaining
        ))
        FROM invoices i WHERE i.so_number = o.so_number
      ), '[]'::json) AS "invoices"
     FROM orders o WHERE o.source = 'edi' AND o.po_number IS NOT NULL`,
  )
  // Same stage/next-action language the rest of the app uses (Dashboard,
  // Kanban) — Nima asked for "needs printed/packed/shipped/invoiced" per PO,
  // which IS this shared model, not something EDI-specific to invent.
  return rows.map((r) => ({ ...r, stageLabel: STAGE_LABEL[r.stage] || r.stage, nextAction: NEXT_ACTION[r.stage] || '—' }))
}

export async function getEdiReview() {
  const [transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs] = await Promise.all([
    fetchEdiTransactions(), fetchEdiFulfillments(), fetchEdiSourcedOrders(), fetchEdiManualLinks(), fetchEdiDocumentPoRefs(),
  ])
  return computeEdiPipeline(transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs)
}

export async function linkEdiTransaction({ transactionId, businessNumber, note }) {
  await upsertEdiManualLink({ transactionId, businessNumber, note })
  return getEdiReview()
}

export async function unlinkEdiTransaction(transactionId) {
  await deleteEdiManualLink(transactionId)
  return getEdiReview()
}

export async function syncEdi() {
  if (!process.env.ORDERFUL_API_KEY) throw new Error('ORDERFUL_API_KEY is not set in .env.local')
  return syncOrderful(process.env.ORDERFUL_API_KEY)
}

export async function commitOcPoLink(payload) {
  return upsertOcPoLink(payload)
}

export async function undoOcPoLink(id) {
  return deleteOcPoLink(id)
}

// type: 'oc' | 'po'. dismissed=false lets a mistaken close be reversed.
export async function dismissOcPoLine({ type, ocNumber, poNumber, item, note, dismissed }) {
  if (type === 'oc') return dismissOrderConfirmation({ ocNumber, item, note, dismissed })
  if (type === 'po') return dismissPurchaseOrder({ poNumber, item, note, dismissed })
  throw new Error(`unknown dismiss type: ${type}`)
}
