// src/ingest/fulfillmentDc.js — the durable IF → (PO, DC) link.
//
// Why a separate pull from the carton feed (ediPackagesLive.js): that one is
// scoped to `status <> 'C'` because a fulfilment LEAVING the feed is how the app
// learns freight shipped, and its table is replaced wholesale each sync. Both
// behaviours are correct there and both destroy exactly what a departure count
// needs — the DC of something that has already gone.
//
// So this pulls every EDI fulfilment regardless of status and UPSERTS. Rows are
// never deleted; a shipped fulfilment keeps its DC forever.
//
// API cost (Nima asked, 2026-08-02): ONE additional SuiteQL query per cycle,
// scoped by lastmodifieddate so a routine run returns a handful of rows. The
// full history (~3,400 rows) is a one-off backfill, run explicitly. Sequential
// with the other calls — NetSuite governs by concurrency and Celigo shares that
// allowance ([[work-hub-capacity-limits]]).
import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { splitPoDc } from './ediPackagesLive.js'

// `since` null = every EDI fulfilment ever (the backfill). Otherwise only those
// touched since that date, which is what the scheduled sync wants.
export const fulfillmentDcSql = (since = null) => `
  SELECT tranid, custbody_po_cd_identifier AS po_dc
    FROM transaction
   WHERE type='ItemShip'
     AND custbody_po_cd_identifier IS NOT NULL
     ${since ? `AND lastmodifieddate >= TO_DATE('${since}','YYYY-MM-DD')` : ''}`

// Rows → storable shape, dropping the junk keys the live data carries ("-",
// "KSA-") the same way the carton feed does.
export function mapFulfillmentDcRows(rows = []) {
  const out = []
  let unusable = 0
  for (const r of rows) {
    const poDc = r.po_dc ?? r.poDc
    const parts = splitPoDc(poDc)
    if (!parts || !r.tranid) { unusable++; continue }
    out.push({ ifNumber: r.tranid, poDc, poNumber: parts.poNumber, dc: parts.dc })
  }
  return { rows: out, unusable }
}

export async function syncFulfillmentDc({ since = null, dryRun = false } = {}) {
  if (!netsuiteConfigured()) return { ok: false, configured: false, loaded: 0 }
  const r = await runSuiteQL(fulfillmentDcSql(since))
  if (!r.ok) return { ok: false, error: r.error || 'fulfilment-DC query failed', loaded: 0 }

  const { rows, unusable } = mapFulfillmentDcRows(r.rows)
  // An empty incremental pull is normal (nothing changed) — unlike the carton
  // feed, there is nothing to blank here, so it is simply a no-op.
  if (!rows.length) return { ok: true, loaded: 0, unusable, pulled: r.rows.length }

  const { withTransaction } = await import('../db.js')
  const { loadFulfillmentDc } = await import('./loadToDb.js')
  const ROLLBACK = Symbol('dry-run rollback')
  try {
    const loaded = await withTransaction(async (db) => {
      const n = await loadFulfillmentDc(rows, db)
      if (dryRun) { const e = new Error('dry run'); e.code = ROLLBACK; e.partial = n; throw e }
      return n
    })
    return { ok: true, loaded, unusable, pulled: r.rows.length }
  } catch (e) {
    if (e?.code === ROLLBACK) return { ok: true, loaded: e.partial, unusable, pulled: r.rows.length, rolledBack: true }
    return { ok: false, error: e?.message || String(e), loaded: 0 }
  }
}
