// src/ingest/bulkPickFetch.js — the SO lines a bulk pick ticket is built from.
//
// ⚠️ READ LIVE FROM NETSUITE, NOT FROM OUR OWN TABLES, and that is a deliberate
// departure from how the rest of this app works.
//
// Everything else here is ingest-then-serve, which is right for a board you read. A PICK
// TICKET IS NOT READ, IT IS ACTED ON: someone walks the floor pulling the quantities it
// names. Serving that from an hourly mirror means a line cancelled twenty minutes ago is
// still picked, and the person picking has no way to know. The Suitelet this replaces
// queries live for the same reason.
//
// The cost is honest and bounded: one SuiteQL round trip per ticket, and if NetSuite is
// unreachable the ticket REFUSES rather than printing yesterday's numbers.
//
// ⚠️ It also means no new table and no new sync surface — the app stores no sales-order
// lines today and this does not change that.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'

/**
 * ⚠️ PO NUMBERS ARE BOUND, NEVER INTERPOLATED. `otherrefnum` is free text a person types
 * into NetSuite, and this value arrives from a form. SuiteQL has no parameter binding in
 * this client, so each value is validated against a conservative shape and quoted —
 * anything else is refused by name rather than reaching the query.
 */
const PO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._/|-]{0,48}$/

export function poFilterError(po) {
  const s = String(po ?? '').trim()
  if (!s) return 'empty PO number'
  if (!PO_SHAPE.test(s)) return `"${s}" is not a PO number shape this can look up`
  return null
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`

export function bulkPickSql(pos = []) {
  const list = pos.map(quote).join(', ')
  // mainline='F' keeps the header row out; everything else the model decides.
  //
  // ⚠️ ALIASES ARE SNAKE_CASE BECAUSE SUITEQL LOWERCASES THEM. `AS "soStatus"` came back
  // as `sostatus` — quoting does not survive — so the model read undefined and a
  // fully-cancelled PO could not say WHY it was empty. Caught by printing the keys of a
  // real row rather than trusting the alias. `normaliseRow` maps them back.
  return `SELECT t.otherrefnum AS po, t.tranid, BUILTIN.DF(t.status) AS so_status,
                 BUILTIN.DF(t.entity) AS customer, BUILTIN.DF(tl.item) AS sku,
                 tl.item AS item_id,
                 tl.itemtype, tl.quantity, tl.isclosed,
                 tl.location AS location_id, l.fullname AS location_name
            FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
            LEFT JOIN location l ON l.id = tl.location
           WHERE t.type='SalesOrd' AND tl.mainline='F'
             AND UPPER(t.otherrefnum) IN (${list})`
}

/**
 * SuiteQL's row → the shape the model expects.
 *
 * ⚠️ Reads keys CASE-INSENSITIVELY. SuiteQL lowercases every alias, and the difference
 * between `soStatus` and `sostatus` is silent: the property is simply undefined and the
 * feature quietly loses a field. Doing the mapping here means the model never has to know.
 */
export function normaliseRow(row = {}) {
  // ⚠️ Compares with separators STRIPPED, not merely lowercased. The quoted alias
  // `"soStatus"` came back as `sostatus` and the snake_case one comes back as
  // `so_status` — matching on case alone would still miss one of them, which is the
  // same silent-undefined this function exists to prevent.
  const flat = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')
  const get = (name) => {
    const want = flat(name)
    const k = Object.keys(row).find((x) => flat(x) === want)
    return k === undefined ? null : row[k]
  }
  return {
    po: get('po'),
    tranid: get('tranid'),
    soStatus: get('so_status'),
    customer: get('customer'),
    sku: get('sku'),
    // ⚠️ The internal id rides along so the stock lookup joins on IT, not on the name.
    // `BUILTIN.DF(tl.item)` is a DISPLAY value; keying inventory on a display string is
    // the shape that has cost this repo before (fullname vs leaf, sku_key vs product_id).
    itemId: get('item_id'),
    itemtype: get('itemtype'),
    quantity: get('quantity'),
    isclosed: get('isclosed'),
    // ⚠️ THE ORDER'S OWN LOCATION, AND IT IS NOT "Warehouse". Measured live 2026-09-01:
    // every line of PO 7242978 sits in `Warehouse Bulk : Bloomingdale's` and every line
    // of PO 50073678 in `Warehouse Bulk : Nordstrom` — partner buckets that held 0 units
    // of 0 SKUs. Stock lives in Warehouse (2) and Virtual Warehouse (3) and is moved in
    // at pick time, which is the whole reason the ticket shows all three.
    locationId: get('location_id'),
    // ⚠️ `fullname`, NOT BUILTIN.DF. DF returns the LEAF ("Nordstrom"), which is
    // indistinguishable from the customer and from location 11 vs a partner name
    // elsewhere; fullname says "Warehouse Bulk : Nordstrom". Same trap as the inbound
    // containers destination.
    locationName: get('location_name'),
  }
}

/** Fetch the lines for these POs. Throws with a reason a person can act on. */
export async function fetchBulkPickLines(pos = [], { run = runSuiteQL } = {}) {
  if (!pos.length) throw new Error('no PO numbers given')
  for (const po of pos) {
    const why = poFilterError(po)
    if (why) throw new Error(why)
  }
  if (!netsuiteConfigured()) {
    // ⚠️ Says WHICH thing is missing. "Could not build the ticket" sends someone hunting.
    throw new Error('NetSuite is not configured on this host — a pick ticket must be live, so it cannot be built from our own tables')
  }
  const r = await run(bulkPickSql(pos.map((p) => String(p).trim().toUpperCase())))
  const rows = r?.items || r?.rows || (Array.isArray(r) ? r : [])
  return rows.map(normaliseRow)
}

// ── on-hand stock, for the transfer decision ─────────────────────────────────
//
// A second live round trip, scoped to the SKUs the ticket already found.
//
// ⚠️ ON HAND, NOT AVAILABLE — Nima's call, 2026-09-01, and his reasoning is the
// point: "if the sales order exists it's a good chance the units are allocated and
// they're already deducting from available". So `quantityavailable` double-penalises
// the very order being picked, and prints 0 against stock that is physically there.
// Measured the same day: SN37043NG-CHOCOLATE showed available 0 / on hand 29 at
// Warehouse. A ticket that says 0 sends someone to buy stock sitting on the shelf.
// On hand is the number that answers "is this run actually short?".
//
// ⚠️ `quantityonhand` COMES BACK NULL, not 0, for a stocked-elsewhere item-location
// row (Virtual Warehouse held one on PO 7242978's first SKU). Absent and zero mean the
// same thing to a picker, so both fold to 0 — but only after the read, never by
// filtering the row away, or a location would silently vanish from the sheet.
export const STOCK_LOCATIONS = [
  // Glendale, the two buckets stock actually lives in. Ids verified live 2026-09-01
  // against `location` (19 rows) — Warehouse 2, Virtual Warehouse 3.
  { id: 2, name: 'Warehouse' },
  { id: 3, name: 'Virtual Warehouse' },
]

const intOnly = (v) => (/^\d{1,9}$/.test(String(v ?? '').trim()) ? String(v).trim() : null)

/**
 * On-hand per item per location.
 *
 * ⚠️ ITEM IDS AND LOCATION IDS ARE INTEGER-CHECKED, NOT QUOTED. Both arrive from
 * NetSuite's own previous answer rather than from a person, but the ticket's PO numbers
 * do come from a form and reach the same query family — so the rule is the same one
 * `poFilterError` sets: a value that is not the shape it claims never reaches the SQL.
 */
export function pickStockSql(itemIds = [], locationIds = []) {
  const items = itemIds.map(intOnly).filter(Boolean)
  const locs = locationIds.map(intOnly).filter(Boolean)
  if (!items.length || !locs.length) return null
  return `SELECT il.item AS item_id, il.location AS location_id,
                 l.fullname AS location_name, il.quantityonhand AS qty_on_hand
            FROM aggregateItemLocation il
            JOIN location l ON l.id = il.location
           WHERE il.item IN (${items.join(', ')})
             AND il.location IN (${locs.join(', ')})`
}

export function normaliseStockRow(row = {}) {
  const flat = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')
  const get = (name) => {
    const want = flat(name)
    const k = Object.keys(row).find((x) => flat(x) === want)
    return k === undefined ? null : row[k]
  }
  return {
    itemId: get('item_id'),
    locationId: get('location_id'),
    locationName: get('location_name'),
    onHand: get('qty_on_hand'),
  }
}

/**
 * Fetch on-hand for these items at these locations.
 *
 * ⚠️ IT NEVER THROWS. The pick ticket is the deliverable; stock is the annotation. If
 * this query fails the sheet must still print, saying the stock column is unknown —
 * printing "0 everywhere" because a query died is how a real pull gets cancelled.
 */
export async function fetchPickStock(itemIds = [], locationIds = [], { run = runSuiteQL } = {}) {
  const sql = pickStockSql(itemIds, locationIds)
  if (!sql) return { rows: [], ok: true }
  if (!netsuiteConfigured()) return { rows: [], ok: false, error: 'NetSuite is not configured on this host' }
  try {
    const r = await run(sql)
    const rows = r?.items || r?.rows || (Array.isArray(r) ? r : [])
    return { rows: rows.map(normaliseStockRow), ok: true }
  } catch (e) {
    return { rows: [], ok: false, error: e.message }
  }
}
