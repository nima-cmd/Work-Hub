// src/ingest/netsuiteItemPrices.js — pull the price list out of NetSuite.
//
// The `pricing` sublist, one row per item per level. This is what the Munbyn hang tag
// needs (Retail Price) and what an order line should be checked against (Wholesale).
//
// ⚠️ Read-only against NetSuite; the only write is ns_item_price.
// ⚠️ It stores what NetSuite says, faithfully — zeros and negatives included. Judging a
// figure fit to show a customer is src/model/itemPrice.js's job, and filtering here
// would hide a data problem rather than report it.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { pool } from '../db.js'
import { LEVEL_NAME } from '../model/itemPrice.js'

// ⚠️ BUILTIN.DF resolves the price-level reference to its NAME, so the row says
// "Retail Price" rather than "2" — the id is an internal number that means nothing to
// anyone reading the table later, and nothing guarantees it is the same id forever.
const PRICE_SQL = `
  SELECT p.item AS internal_id,
         p.pricelevel AS price_level,
         BUILTIN.DF(p.pricelevel) AS level_name,
         p.unitprice AS unit_price,
         i.itemid AS sku
    FROM pricing p
    JOIN item i ON i.id = p.item`

// ⚠️ The NAME lives in its own table, not alongside each price row. Carrying it on
// ns_item_price would repeat it three times per item, and three copies of one fact can
// disagree the moment a sync half-completes.
const ITEM_SQL = `
  SELECT i.id AS internal_id, i.itemid AS sku, i.displayname AS display_name
    FROM item i
   WHERE i.isinactive = 'F'`

export async function syncItemPrices({ dryRun = false } = {}) {
  if (!netsuiteConfigured()) return { configured: false, fetched: 0, upserted: 0 }

  const q = await runSuiteQL(PRICE_SQL)
  const rows = (q.rows || []).map((r) => ({
    internalId: String(r.internal_id ?? '').trim(),
    priceLevel: String(r.price_level ?? '').trim(),
    levelName: r.level_name || LEVEL_NAME[String(r.price_level)] || null,
    unitPrice: r.unit_price === null || r.unit_price === undefined || r.unit_price === '' ? null : Number(r.unit_price),
    sku: r.sku || null,
  })).filter((r) => r.internalId && r.priceLevel)

  if (dryRun) return { configured: true, fetched: rows.length, upserted: 0, dryRun: true }

  // ⚠️ UPSERT, NEVER TRUNCATE-AND-LOAD. A truncate leaves the table EMPTY for the
  // length of the load, and anything reading it in that window — a label about to
  // print — sees "no price" for every item in the catalogue. It also destroys the
  // whole price list if the fetch half-fails.
  let upserted = 0
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const values = []
    const params = []
    batch.forEach((r, n) => {
      const b = n * 5
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, now())`)
      params.push(r.internalId, r.priceLevel, r.levelName, r.unitPrice, r.sku)
    })
    const res = await pool.query(
      `INSERT INTO ns_item_price (internal_id, price_level, level_name, unit_price, sku, observed_at)
       VALUES ${values.join(',')}
       ON CONFLICT (internal_id, price_level) DO UPDATE SET
         level_name = EXCLUDED.level_name,
         unit_price = EXCLUDED.unit_price,
         sku        = EXCLUDED.sku,
         observed_at = now()`, params)
    upserted += res.rowCount || 0
  }

  // ⚠️ A price REMOVED in NetSuite must stop being ours. Swept by stamp rather than by
  // diffing: anything this run did not touch no longer exists upstream. Guarded on the
  // run having found something, because a failed fetch returning zero rows would
  // otherwise delete the entire price list.
  let swept = 0
  if (rows.length) {
    const res = await pool.query(
      `DELETE FROM ns_item_price WHERE observed_at < now() - interval '1 minute'
         AND observed_at < (SELECT max(observed_at) FROM ns_item_price)`)
    swept = res.rowCount || 0
  }

  // ── item identity, for the hang tag's product name ────────────────────────
  const iq = await runSuiteQL(ITEM_SQL)
  const items = (iq.rows || [])
    .map((r) => ({ internalId: String(r.internal_id ?? '').trim(), sku: r.sku || null, displayName: r.display_name || null }))
    .filter((r) => r.internalId)
  let itemsUpserted = 0
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK)
    const values = []
    const params = []
    batch.forEach((r, n) => {
      const b = n * 3
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, now())`)
      params.push(r.internalId, r.sku, r.displayName)
    })
    const res = await pool.query(
      `INSERT INTO ns_item (internal_id, sku, display_name, observed_at)
       VALUES ${values.join(',')}
       ON CONFLICT (internal_id) DO UPDATE SET
         sku = EXCLUDED.sku, display_name = EXCLUDED.display_name, observed_at = now()`, params)
    itemsUpserted += res.rowCount || 0
  }

  return { configured: true, fetched: rows.length, upserted, swept, items: itemsUpserted }
}
