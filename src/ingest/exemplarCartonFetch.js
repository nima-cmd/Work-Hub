// src/ingest/exemplarCartonFetch.js — the carton contents, read LIVE from NetSuite.
//
// ⚠️ LIVE, NOT FROM OUR MIRROR, AND FOR THE SAME REASON THE PICK TICKET IS. These
// rows become a physical label glued to a box and a slip handed to a receiver, and
// §9.1 audits the packing slip against the GS1-128 against the units on a monthly
// error rate — 2% puts us on a $1,000/month programme. An hourly mirror would print
// yesterday's pack.
//
// ⚠️ TWO ROUND TRIPS, ON PURPOSE. The carton record carries a UPC or an item id, not a
// style, so the item master has to be asked separately. Batching them into one join
// against `item` was the obvious move and SuiteQL 500s on a GROUP BY over this custom
// record, so the simple two-query shape is the one that actually works.

import { runSuiteQL } from './netsuiteApi.js'
import { lookupKeys, resolveCartonContents } from '../model/cartonContents.js'

const quote = (v) => `'${String(v).replace(/'/g, "''")}'`

/** The carton rows for one Item Fulfilment, contents included. */
export async function fetchCartonRows(ifId) {
  const q = await runSuiteQL(`
    SELECT custrecord_hb_edi_package_carton_no AS carton_no,
           COALESCE(TO_NUMBER(custrecord_hb_edi_package_total_qty),0) AS units,
           COALESCE(TO_NUMBER(custrecord_hb_edi_package_weight),0) AS weight,
           custrecord_hb_edi_package_ucc AS ucc,
           custrecord_pkg_upc_or_mixed AS contents,
           custrecord_pkg_total_num_cartons AS total_cartons,
           -- The box's dimensions, needed to say WHERE the label goes on it.
           BUILTIN.DF(custrecord_hb_edi_package_definition) AS box
      FROM customrecord_hb_edi_packages
     WHERE isinactive = 'F' AND custrecord_hb_edi_pack_related_iff = ${Number(ifId)}`)
  if (!q.ok) return { ok: false, error: q.error }
  const rows = q.rows
    .map((r) => ({
      carton: Number(r.carton_no), units: Number(r.units) || 0,
      weightLb: Number(r.weight) || 0, sscc: r.ucc, contents: r.contents ?? null,
      box: r.box ?? null,
      totalCartons: Number(r.total_cartons) || q.rows.length,
    }))
    .sort((a, b) => a.carton - b.carton)
  return { ok: true, rows }
}

/** The item master for the UPCs and item ids those cartons name. */
export async function fetchItems({ upcs = [], itemIds = [] } = {}) {
  const clauses = []
  if (upcs.length) clauses.push(`upccode IN (${upcs.map(quote).join(',')})`)
  if (itemIds.length) clauses.push(`UPPER(itemid) IN (${itemIds.map((i) => quote(String(i).toUpperCase())).join(',')})`)
  if (!clauses.length) return { ok: true, rows: [] }
  const q = await runSuiteQL(`SELECT upccode AS upc, itemid, displayname FROM item WHERE ${clauses.join(' OR ')}`)
  if (!q.ok) return { ok: false, error: q.error }
  return { ok: true, rows: q.rows }
}

/**
 * Everything both documents need for one fulfilment, or the reason they cannot print.
 *
 * ⚠️ A FAILED READ IS NOT AN EMPTY PACK. If NetSuite is unreachable this returns the
 * error; rendering "0 cartons" would be a blank pallet's worth of missing labels
 * presented as a finished job.
 */
export async function fetchCartonContents(ifId) {
  const c = await fetchCartonRows(ifId)
  if (!c.ok) return { ok: false, error: `could not read the carton records: ${c.error}` }
  if (!c.rows.length) return { ok: false, error: `NetSuite has no carton records for fulfilment ${ifId}` }
  const i = await fetchItems(lookupKeys(c.rows))
  if (!i.ok) return { ok: false, error: `could not read the item master: ${i.error}` }
  return { ok: true, ...resolveCartonContents(c.rows, i.rows) }
}
