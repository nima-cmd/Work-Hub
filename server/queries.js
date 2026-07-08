// server/queries.js — read orders (+ their fulfillments) from Neon and enrich
// each with the SAME pipeline flags the CLI analyzer uses, so UI and analyzer
// never disagree.

import { pool } from '../src/db.js'
import { computeFlags } from '../src/model/pipeline.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'

export async function getOrders() {
  const { rows } = await pool.query(`
    SELECT o.*,
      COALESCE(
        json_agg(
          json_build_object(
            'ifNumber', f.if_number, 'status', f.status,
            'packedStatus', f.packed_status, 'daysPending', f.days_pending,
            'invoice', f.invoice_number
          ) ORDER BY f.if_number
        ) FILTER (WHERE f.if_number IS NOT NULL),
        '[]'::json
      ) AS fulfillments,
      MAX(f.days_pending) AS days_pending
    FROM orders o
    LEFT JOIN fulfillments f ON f.so_number = o.so_number
    GROUP BY o.so_number
  `)

  const today = new Date()
  return rows.map((r) => {
    const o = {
      soNumber: r.so_number,
      customer: r.customer,
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
      cancelDate: r.cancel_date,
      daysPending: r.days_pending,
      notes: r.notes,
      fulfillments: r.fulfillments,
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

export async function getFreshness() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (source) source, imported_at, file_modified
    FROM import_snapshots
    ORDER BY source, imported_at DESC
  `)
  if (!rows.length) return { status: 'none', sources: [] }

  const now = Date.now()
  const sources = rows.map((r) => ({
    source: r.source,
    fileModified: r.file_modified,
    importedAt: r.imported_at,
    ageHours: r.file_modified ? (now - new Date(r.file_modified).getTime()) / 3.6e6 : null,
  }))
  const ages = sources.map((s) => s.ageHours).filter((a) => a != null)
  const maxAgeHours = ages.length ? Math.max(...ages) : null
  const status =
    maxAgeHours == null ? 'unknown' : maxAgeHours > STALE_HOURS ? 'stale' : maxAgeHours > WARN_HOURS ? 'warn' : 'fresh'

  return { status, maxAgeHours, warnHours: WARN_HOURS, staleHours: STALE_HOURS, sources }
}
