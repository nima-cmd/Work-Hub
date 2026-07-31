// src/ingest/ediPackagesLive.js — the live EDI routing-carton feed.
//
// Replaces the last CSV-only source in the app. The routing board's cartons used
// to arrive by exporting NetSuite saved search customsearch3947 "EDI Packages
// Volume" to CSV and importing it; this reads the same underlying data over the
// read-only SuiteQL connection instead, so the board is current without anyone
// exporting anything.
//
// Where the data actually lives (Nima, 2026-08-01 — worth not rediscovering):
//   • One row per CARTON in the custom record `customrecord_hb_edi_packages`,
//     carrying weight, unit count, the SSCC/UCC label, the ZPL, and a reference
//     to a Package Definition (the box type, whose display name IS its
//     dimensions, e.g. "24x16x17").
//   • NOT the standard ItemFulfillmentPackage table — that exists but holds
//     different weights (they don't reconcile), because Naghedi's packing writes
//     the custom EDI record.
//   • The PO-DC grouping key is `custbody_po_cd_identifier` on the fulfilment
//     ("7242978-SC"). The saved search's own BOL formula concatenates two other
//     fields (custbody_if_po_number/custbody_if_dc_code) that SuiteQL does not
//     expose at all — this identifier is the reachable equivalent.
//
// Reproducing the search exactly (validated against all 6 live PO-DCs):
//   • cartons = COUNT of carton rows, weight/units = SUM of their fields.
//   • The search drops fulfilments whose status IS Shipped, which is what makes
//     a routed PO leave the feed. We mirror that (`status <> 'C'`), and it is
//     also why the load REPLACES the feed rather than upserting — a PO-DC absent
//     from the pull has shipped. Leaving stale rows would merge a shipped PO into
//     a live DC group, change its dcPoKey, and detach the archived BOL.
//   • Cubic feet is stored per box type on the Package Definition record, which
//     SuiteQL can't reach by name, so it's computed from the dimensions in the
//     display name: L×W×H/1728 per carton, ROUNDED TO 1 DP PER CARTON, then
//     summed. Per-carton rounding is not cosmetic — summing raw and rounding
//     once comes out 0.1–0.2 light on every group. "Cubic Feet (Rounded)" is the
//     sum of per-carton CEILINGS. Both were checked against the search's own
//     numbers on all six PO-DCs.
import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'

// Fulfilments still in the routing pipeline: they carry a PO-DC identifier (only
// EDI-routed fulfilments do, which is what scopes this to the EDI partners) and
// have not shipped. Status C = Shipped; see netsuiteSync.js IF_STATUS.
export const ifSql = () => `
  SELECT id, tranid, status, custbody_po_cd_identifier AS po_dc
    FROM transaction
   WHERE type='ItemShip'
     AND custbody_po_cd_identifier IS NOT NULL
     AND status <> 'C'`

// How many units the fulfilment itself says it is shipping — the other half of
// the pack check (Nima, 2026-08-02).
//
// ⚠️ An Item Fulfilment writes THREE transactionlines per item (-qty, +qty,
// -qty) to record the inventory movement, so SUM(ABS(quantity)) triples every
// count. Verified on IF7420: 21 lines across 7 items summing to 36 by ABS, but
// 12 real units. Only the POSITIVE InvtPart lines are the shipped quantity.
// itemtype also excludes the ShipItem line (the 'LTL' freight line).
export const ifUnitsSql = (ifIds) => `
  SELECT tl.transaction AS if_id, SUM(tl.quantity) AS if_units
    FROM transactionline tl
   WHERE tl.itemtype = 'InvtPart'
     AND tl.quantity > 0
     AND tl.transaction IN (${ifIds.join(',')})
   GROUP BY tl.transaction`

// The carton rows for those fulfilments. BUILTIN.DF resolves the Package
// Definition reference to its display name, which is the box's dimensions.
export const packageSql = (ifIds) => `
  SELECT custrecord_hb_edi_pack_related_iff AS if_id,
         custrecord_hb_edi_package_carton_no AS carton_no,
         COALESCE(TO_NUMBER(custrecord_hb_edi_package_weight),0) AS weight,
         COALESCE(TO_NUMBER(custrecord_hb_edi_package_total_qty),0) AS units,
         custrecord_hb_edi_package_ucc AS ucc,
         BUILTIN.DF(custrecord_hb_edi_package_definition) AS box
    FROM customrecord_hb_edi_packages
   WHERE isinactive = 'F'
     AND custrecord_hb_edi_pack_related_iff IN (${ifIds.join(',')})`

// "24x16x17" (or "24X14X4") → [24,16,17]. Returns null when the box type's name
// isn't dimensional, so the caller can report it instead of silently scoring 0.
export function parseBoxDims(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const round1 = (n) => Math.round(n * 10) / 10

// A PO-DC identifier is only usable with BOTH halves present — the live data
// contains junk keys ("-", "KSA-") from fulfilments with no PO or no DC.
export function splitPoDc(poDc) {
  const s = String(poDc || '').trim()
  const dash = s.indexOf('-')
  if (dash < 1) return null
  const poNumber = s.slice(0, dash).trim()
  const dc = s.slice(dash + 1).trim()
  return poNumber && dc ? { poNumber, dc } : null
}

// Pure: SuiteQL rows → the same record shape fromEdiPackagesVolume emits, so the
// existing loadEdiPackages and the whole routing model stay untouched.
// Kept free of network/DB so it's unit-testable.
export function mapEdiPackageRows({ ifs = [], packages = [], ifUnits = [] } = {}) {
  const poDcOfIf = new Map()
  for (const r of ifs) poDcOfIf.set(String(r.id), r.po_dc ?? r.poDc)

  // Per-fulfilment pack reconciliation (Nima, 2026-08-02). Built alongside the
  // PO-DC rollup because both need the same carton rows; the rollup sums them
  // away, and "which IF is short" is only answerable before that happens.
  const unitsOfIf = new Map()
  for (const r of ifUnits) unitsOfIf.set(String(r.if_id ?? r.ifId), Number(r.if_units ?? r.ifUnits) || 0)
  const perIf = new Map()
  for (const r of ifs) {
    const parts = splitPoDc(r.po_dc ?? r.poDc)
    if (!parts) continue // no usable PO-DC → not EDI-routed, nothing to reconcile
    perIf.set(String(r.id), {
      ifNumber: r.tranid ?? null, poDc: r.po_dc ?? r.poDc,
      poNumber: parts.poNumber, dc: parts.dc,
      ifUnits: unitsOfIf.get(String(r.id)) || 0, packedUnits: 0, cartons: 0,
    })
  }

  const agg = new Map()
  const unparseableBoxes = new Set()
  let orphanCartons = 0

  for (const p of packages) {
    const ifId = String(p.if_id ?? p.ifId)
    const f = perIf.get(ifId)
    if (f) { f.cartons++; f.packedUnits += Number(p.units) || 0 }
    const key = poDcOfIf.get(ifId)
    const parts = key ? splitPoDc(key) : null
    if (!parts) { orphanCartons++; continue }
    let e = agg.get(key)
    if (!e) {
      e = {
        poDc: key, poNumber: parts.poNumber, dc: parts.dc,
        cartons: 0, weight: 0, units: 0, cubicFeetRaw: 0, cubicFeetRounded: 0,
        suggestedBol: `${parts.poNumber}DC${parts.dc}`,
      }
      agg.set(key, e)
    }
    e.cartons++
    e.weight += Number(p.weight) || 0
    e.units += Number(p.units) || 0
    const d = parseBoxDims(p.box)
    if (!d) { unparseableBoxes.add(String(p.box || '(blank)')); continue }
    const cu = (d[0] * d[1] * d[2]) / 1728
    e.cubicFeetRaw += round1(cu)      // per-carton rounding, then sum
    e.cubicFeetRounded += Math.ceil(cu)
  }

  const rows = [...agg.values()].map((e) => ({ ...e, cubicFeetRaw: round1(e.cubicFeetRaw) }))
  rows.sort((a, b) => a.poDc.localeCompare(b.poDc))
  const fulfilments = [...perIf.values()].sort((a, b) => String(a.ifNumber).localeCompare(String(b.ifNumber)))
  return { rows, fulfilments, unparseableBoxes: [...unparseableBoxes], orphanCartons }
}

export async function fetchEdiPackagesLive() {
  if (!netsuiteConfigured()) return { ok: false, configured: false, rows: [] }
  const ifs = await runSuiteQL(ifSql())
  if (!ifs.ok) return { ok: false, error: `fulfilments: ${ifs.error || 'failed'}`, rows: [] }
  const ids = ifs.rows.map((r) => r.id).filter(Boolean)
  if (!ids.length) return { ok: true, rows: [], unparseableBoxes: [], orphanCartons: 0, ifCount: 0 }
  // Deliberately SEQUENTIAL, not Promise.all (Nima, 2026-08-02). NetSuite
  // governs SuiteTalk by CONCURRENT requests, and that allowance is shared with
  // Celigo, whose integrations outrank this app. Running one query at a time
  // means we never occupy more than a single slot; the extra second costs a
  // background sync nothing.
  const pk = await runSuiteQL(packageSql(ids))
  if (!pk.ok) return { ok: false, error: `cartons: ${pk.error || 'failed'}`, rows: [] }
  const un = await runSuiteQL(ifUnitsSql(ids))
  // The pack check is an add-on: if the line query fails, the carton feed (and
  // therefore routing) must still load — the check just can't be shown.
  const out = mapEdiPackageRows({ ifs: ifs.rows, packages: pk.rows, ifUnits: un.ok ? un.rows : [] })
  return {
    ok: true, ...out, ifCount: ids.length, cartonCount: pk.rows.length,
    unitsError: un.ok ? null : (un.error || 'if-unit query failed'),
  }
}

// Pull and REPLACE the feed. dryRun rolls the transaction back after exercising
// every statement, matching syncFromNetsuite's contract.
export async function syncEdiPackagesLive({ dryRun = false } = {}) {
  const pulled = await fetchEdiPackagesLive()
  if (!pulled.ok) return pulled
  if (!pulled.rows.length) {
    // Never blank the feed off an empty pull — that reads identically to "every
    // carton shipped" and would wipe live routing work on a transient failure.
    return { ...pulled, skipped: 'empty pull — feed left untouched', loaded: 0, removed: [] }
  }

  const { withTransaction, pool } = await import('../db.js')
  const { loadEdiPackages, loadFulfilmentPack, recordSnapshot } = await import('./loadToDb.js')
  const { rows: existing } = await pool.query('SELECT po_dc FROM edi_packages')
  const incoming = new Set(pulled.rows.map((r) => r.poDc))
  const removed = existing.map((r) => r.po_dc).filter((k) => !incoming.has(k))

  const ROLLBACK = Symbol('dry-run rollback')
  try {
    const loaded = await withTransaction(async (db) => {
      await db.query('DELETE FROM edi_packages')
      const n = await loadEdiPackages(pulled.rows, db)
      // Same transaction as the carton feed: the pack check compares against
      // those exact cartons, so the two must never be written apart.
      await loadFulfilmentPack(pulled.fulfilments || [], db)
      await recordSnapshot('ediPackagesLive', n, new Date(), db)
      if (dryRun) { const e = new Error('dry run'); e.code = ROLLBACK; e.partial = n; throw e }
      return n
    })
    return { ...pulled, loaded, removed }
  } catch (e) {
    if (e?.code === ROLLBACK) return { ...pulled, loaded: e.partial, removed, rolledBack: true }
    return { ok: false, error: e?.message || String(e) }
  }
}
