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
import { resolveFulfilmentRows, missingIdentifier } from '../model/poDcIdentifier.js'

// Fulfilments still in the routing pipeline: they carry a PO-DC identifier (only
// EDI-routed fulfilments do, which is what scopes this to the EDI partners) and
// have not shipped. Status C = Shipped; see netsuiteSync.js IF_STATUS.
//
// ⚠️ IT NO LONGER REQUIRES THE IDENTIFIER TO BE PRESENT, and that is the whole fix.
// The old `custbody_po_cd_identifier IS NOT NULL` made an EMPTY FIELD INDISTINGUISHABLE
// FROM NO WORK: on 2026-09-01 eleven Bloomingdale's fulfilments sat packed on the floor
// — 13 cartons, 111 units — and the feed returned nothing at all, so Routing showed a
// week-old snapshot and nobody could tell the difference. The two halves the identifier
// is built from now ride along so `resolvePoDc` can fall back to them, and so a row
// whose field is genuinely empty can be REPORTED rather than silently dropped.
//
// ⚠️ The SO join can return a fulfilment more than once; `resolveFulfilmentRows` folds
// the duplicates and refuses to derive when two links disagree about the PO.
export const ifSql = () => `
  SELECT t.id, t.tranid, t.status, t.custbody_po_cd_identifier AS po_dc,
         so.otherrefnum AS so_po, c.custentity_dc_location AS cust_dc
    FROM transaction t
    LEFT JOIN nexttransactionlink ntl ON ntl.nextdoc = t.id
    LEFT JOIN transaction so ON so.id = ntl.previousdoc AND so.type = 'SalesOrd'
    LEFT JOIN customer c ON c.id = t.entity
   WHERE t.type='ItemShip'
     AND t.status <> 'C'
     AND (t.custbody_po_cd_identifier IS NOT NULL
          OR (so.otherrefnum IS NOT NULL AND c.custentity_dc_location IS NOT NULL))`

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
//
// Splits on the LAST dash, not the first, and requires the DC to actually look
// like one (2026-08-02). Both matter because purchase orders contain dashes:
// Rustan's "720-0326-19551-" was being read as PO "720" in DC "0326-19551-",
// which invented a freight destination for what is really a parcel and made it
// count as its own departure. Real DC codes are short and alphanumeric —
// Bloomingdale's are two letters (SC/ST/JP/CI/CG/HA/CL), Nordstrom three digits
// (569/584/799/089…) — so anything with spaces or punctuation is not a DC.
const DC_SHAPE = /^[A-Za-z0-9]{1,6}$/
export function splitPoDc(poDc) {
  const s = String(poDc || '').trim()
  const dash = s.lastIndexOf('-')
  if (dash < 1) return null
  const poNumber = s.slice(0, dash).trim()
  const dc = s.slice(dash + 1).trim()
  if (!poNumber || !DC_SHAPE.test(dc)) return null
  return { poNumber, dc }
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
  // The carton rows themselves, kept rather than only summed (Nima, 2026-08-05:
  // "i do need how each carton in the shipment its weight and dimension"). The
  // rollup below still sums them; this simply stops throwing the detail away.
  const cartons = []

  for (const p of packages) {
    const ifId = String(p.if_id ?? p.ifId)
    const f = perIf.get(ifId)
    if (f) { f.cartons++; f.packedUnits += Number(p.units) || 0 }
    const key = poDcOfIf.get(ifId)
    const parts = key ? splitPoDc(key) : null
    if (!parts) { orphanCartons++; continue }
    const dims = parseBoxDims(p.box)
    cartons.push({
      ifNumber: f?.ifNumber ?? null,
      cartonNo: String(p.carton_no ?? p.cartonNo ?? ''),
      poDc: key, poNumber: parts.poNumber, dc: parts.dc,
      weightLb: Number(p.weight) || null,
      units: Number(p.units) || null,
      ucc: p.ucc ?? null,
      boxName: p.box ?? null,
      // NULL rather than 0 when the box type's name isn't dimensional — a zero
      // dimension on a carrier label is a rejected shipment, not a small box.
      lengthIn: dims ? dims[0] : null,
      widthIn: dims ? dims[1] : null,
      heightIn: dims ? dims[2] : null,
    })
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
  cartons.sort((a, b) => String(a.ifNumber).localeCompare(String(b.ifNumber)) || String(a.cartonNo).localeCompare(String(b.cartonNo)))
  return { rows, fulfilments, cartons, unparseableBoxes: [...unparseableBoxes], orphanCartons }
}

export async function fetchEdiPackagesLive() {
  if (!netsuiteConfigured()) return { ok: false, configured: false, rows: [] }
  const raw = await runSuiteQL(ifSql())
  if (!raw.ok) return { ok: false, error: `fulfilments: ${raw.error || 'failed'}`, rows: [] }
  // ⚠️ FOLD THE DUPLICATE SO LINKS AND RESOLVE THE IDENTIFIER BEFORE ANYTHING ELSE SEES
  // THE ROWS. Everything downstream — the rollup, the pack check, the carton detail —
  // reads `po_dc`, so resolving it once here is what keeps them from disagreeing.
  const ifs = { ok: true, rows: resolveFulfilmentRows(raw.rows) }
  // ⚠️ THE WARNING IS COMPUTED EVEN WHEN WE COULD FILL THE GAP OURSELVES. A derived
  // value restores OUR view; the ASN is still built from the empty NetSuite field.
  const missing = missingIdentifier(ifs.rows)
  const ids = ifs.rows.map((r) => r.id).filter(Boolean)
  if (!ids.length) return { ok: true, rows: [], unparseableBoxes: [], orphanCartons: 0, ifCount: 0, missingIdentifier: missing }
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
    missingIdentifier: missing,
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
    //
    // ⚠️ BUT STILL STAMP THAT WE RAN (2026-08-19). Returning here skipped
    // recordSnapshot, so a successful run that legitimately found nothing was
    // INDISTINGUISHABLE FROM A SYNC THAT NEVER RAN. Health read
    // "EDI cartons · STOPPED ARRIVING · 4d 23h" for five days while the hourly cron
    // was working perfectly — the stamp simply could not advance.
    //
    // Nima called it: *"the staleness may be a false flag because nothing packed."* He
    // was right about the symptom. The cause was narrower — the only unshipped
    // fulfilments carrying cartons were IF7405 (Saint Bernard, 6) and IF7508 (Gee
    // Beauty Canada, 2), both BOUTIQUE, both `po_dc = '-'`, both correctly skipped
    // because they are not EDI-routed. Nothing was wrong except the reporting.
    //
    // The freshness question is "did this sync run", not "did it find anything". Same
    // shape as CLAUDE.md's counter bugs: measuring something adjacent to the question.
    try {
      const { recordSnapshot } = await import('./loadToDb.js')
      await recordSnapshot('ediPackagesLive', 0, new Date())
    } catch { /* a stamp failing must not turn a good run into a reported failure */ }
    return { ...pulled, skipped: 'empty pull — feed left untouched (run recorded)', loaded: 0, removed: [] }
  }

  const { withTransaction, pool } = await import('../db.js')
  const { loadEdiPackages, loadFulfilmentPack, loadEdiCartons, recordSnapshot } = await import('./loadToDb.js')
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
      // Same transaction again: the rollup, the pack check and the carton detail all
      // derive from ONE pull of the same carton rows, so writing them apart would let
      // a label sheet disagree with the BOL it ships under.
      await loadEdiCartons(pulled.cartons || [], db)
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
