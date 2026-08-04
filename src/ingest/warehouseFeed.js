// src/ingest/warehouseFeed.js — push NetSuite mirrors into the Naghedi-Warehouse
// app's Supabase, replacing its manual CSV imports. Two feeds live here:
//
//   ns_open_po_lines       one row per open PO ITEM LINE (the receiving dock)
//   ns_item_location_qtys  one row per stocked item-location (the inventory view)
//
// The warehouse app (~/src/Naghedi-Warehouse) generates NetSuite Item Receipt +
// Inventory Transfer CSVs off PO line data, and fills its SKU catalog +
// per-location quantities, from hand-exported saved searches. These feeds write
// the same facts into tables that app will read instead.
//
// Ownership: Work-Hub OWNS the two ns_* tables and writes NOTHING else in that
// project. The app's own tables (purchase_orders, bins, bin_skus, containers,
// sku_catalog, location_qtys, app_meta, …) are never touched — bin_skus in
// particular is their app-authoritative physical count, and their catalog
// import already full-wipes purchase_orders on its own schedule; two writers
// on one table was the clobber risk this design removes. sku_catalog and
// location_qtys stay theirs for the same reason: the inventory feed writes the
// NEW table, and reading it (vs the CSV) is the app's call, not ours.
//
// The receiving-side spec this implements (Nima, 2026-08-03) had four gotchas,
// each one already paid for in the warehouse app:
//   1. "Order Line" on an Item Receipt import is the position among ITEM lines
//      only. Live today: 17 open POs carry an expense line ("dye webbing fee",
//      "sample charge") at raw line-sequence 1, shifting every item line's raw
//      number off by one. We compute item_line_position ourselves — a running
//      counter over item lines in line-sequence order — and ALSO send the raw
//      line_seq + item_type so the consumer can renumber if it ever disagrees.
//      (The one TaxItem line in scope, PO1760's CA_ZR, sits LAST and has no
//      itemid, so it never shifts positions; it is excluded like the fee lines.)
//   2. qty_received rides on every line so the app can drop fully-received
//      lines from its Receive=F placeholder rows (a closed line breaks the
//      import). Lines are NOT filtered here: position numbering must count
//      fully-received lines too, exactly as the CSV parser did.
//   3. No collapsing by SKU — the same SKU on two lines stays two rows (the
//      app flags those POs for manual receipt). This is why the feed has its
//      own query instead of reusing purchaseOrderSql/foldPurchaseOrderLines,
//      which deliberately fold to one row per (PO, item).
//   4. final_destination is `custbody_acs_final_destination` resolved through
//      location.fullname — the FULL path ("Warehouse Bulk : Shopbop"); the
//      leaf form aims Inventory Transfers at the wrong location. Blank on 20
//      of 86 open POs at build time, sent as NULL, never guessed.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'

// ── config ────────────────────────────────────────────────────────────────────
// WAREHOUSE_* is the canonical name (declared in render.yaml); the VITE_* pair
// is the fallback because both repos' .env.local already carry it — it is the
// warehouse app's own anon key, whose writes that project accepts ungated.
export function warehouseSupabaseCreds(env = process.env) {
  const url = env.WAREHOUSE_SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.WAREHOUSE_SUPABASE_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return { url: String(url).replace(/\/+$/, ''), key }
}

export function warehouseFeedConfigured(env = process.env) {
  return !!warehouseSupabaseCreds(env)
}

// ── the pull ──────────────────────────────────────────────────────────────────
// Scope is the receiving dock's: B Pending Receipt + D Partially Received.
// Deliberately NARROWER than PO_OPEN_CODES (B/D/F): F "Pending Bill" is fully
// received — nothing left for the dock — and the spec says exclude it.
export const WAREHOUSE_PO_STATUS_CODES = ['B', 'D']

// Line location COALESCEs line-over-header, the same pattern (and the same
// fullname-not-leaf trap) as orderConfirmationSql. ORDER BY keeps pagination
// stable; the mapper re-sorts per PO anyway before numbering positions.
export function warehousePoLineSql() {
  const codes = WAREHOUSE_PO_STATUS_CODES.map((c) => `'${c}'`).join(',')
  return `SELECT t.id AS po_id, t.tranid AS po_number,
                 BUILTIN.DF(t.entity) AS vendor, BUILTIN.DF(t.status) AS status,
                 TO_CHAR(t.duedate,'YYYY-MM-DD') AS duedate, t.memo AS header_memo,
                 fd.fullname AS final_destination,
                 COALESCE(lloc.fullname, hloc.fullname) AS po_location,
                 tl.linesequencenumber AS line_seq, tl.itemtype, tl.isclosed,
                 tl.item AS item_id, i.itemid AS sku, tl.memo AS line_memo,
                 tl.quantity AS qty_ordered, tl.quantityshiprecv AS qty_received,
                 tl.rate
          FROM transaction t
          JOIN transactionline tl ON tl.transaction = t.id
          LEFT JOIN item i ON i.id = tl.item
          LEFT JOIN location fd ON fd.id = t.custbody_acs_final_destination
          LEFT JOIN location lloc ON lloc.id = tl.location
          LEFT JOIN location hloc ON hloc.id = t.location
          WHERE t.type='PurchOrd' AND tl.mainline='F'
            AND t.status IN (${codes})
          ORDER BY t.id, tl.linesequencenumber`
}

// An item line is one that occupies a position on the PO's Items sublist —
// which is what the Item Receipt import's "Order Line" counts. Expense lines
// have no item join (null sku); the auto-added tax line is excluded explicitly.
function isItemLine(row) {
  return !!String(row.sku || '').trim() && row.itemtype !== 'TaxItem'
}

// SuiteQL rows → flat push rows, one per item line, positions computed per PO.
// Also returns how many non-item lines were skipped — a silent drop here would
// read as "covered everything" when it didn't.
export function mapWarehousePoLines(rows = []) {
  const byPo = new Map()
  for (const row of rows) {
    const poId = String(row.po_id || '').trim()
    if (!poId) continue
    if (!byPo.has(poId)) byPo.set(poId, [])
    byPo.get(poId).push(row)
  }

  const out = []
  let skippedNonItem = 0
  for (const lines of byPo.values()) {
    lines.sort((a, b) => Number(a.line_seq) - Number(b.line_seq))
    let position = 0
    for (const row of lines) {
      if (!isItemLine(row)) { skippedNonItem++; continue }
      position++
      const ordered = Number(row.qty_ordered) || 0
      const received = Number(row.qty_received) || 0
      const rate = Number(row.rate)
      out.push({
        po_id: String(row.po_id).trim(),
        line_seq: Number(row.line_seq),
        po_number: String(row.po_number || '').trim(),
        vendor: String(row.vendor || '').trim() || null,
        // BUILTIN.DF prefixes the record type ("Purchase Order : Pending
        // Receipt") — strip it, same as mapPurchaseOrderRow, so the app's
        // normalizeStatus sees the bare status the CSV always carried.
        status: String(row.status || '').replace(/^Purchase Order\s*:\s*/i, '').trim() || null,
        expected_receipt: row.duedate || null,
        header_memo: String(row.header_memo || '').trim() || null,
        final_destination: String(row.final_destination || '').trim() || null,
        po_location: String(row.po_location || '').trim() || null,
        item_line_position: position,
        item_type: row.itemtype || null,
        item_id: String(row.item_id || '').trim(),
        sku: String(row.sku).trim(),
        line_memo: String(row.line_memo || '').trim() || null,
        qty_ordered: ordered,
        qty_received: received,
        line_closed: row.isclosed === 'T',
        unit_rate: Number.isFinite(rate) ? rate : null,
      })
    }
  }
  return { rows: out, skippedNonItem, poCount: byPo.size }
}

// ── the push ──────────────────────────────────────────────────────────────────
// Upsert-then-sweep, NEVER delete-first. The app's own CSV import wipes its
// table before inserting — fine for a human watching a progress message, wrong
// for an unattended sync, where a failure between the wipe and the insert
// leaves the dock reading an empty table. Here every row upserts carrying this
// batch's synced_at, and only after EVERY batch has landed do we sweep rows
// with an older stamp (POs that closed, lines that left the open scope). Any
// failure aborts before the sweep: the table keeps serving the previous
// complete snapshot plus whatever fresher rows already landed.

const BATCH = 500

function restHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

// Stamp → batch-upsert → sweep, shared by both feeds. Returns
// { ok, pushed, swept, syncedAt } or { ok:false, error, pushed? }.
async function pushSnapshot({ table, conflict, rows, creds, _fetch = fetch, now = () => new Date() }) {
  const syncedAt = now().toISOString()
  const stamped = rows.map((r) => ({ ...r, synced_at: syncedAt }))
  const base = `${creds.url}/rest/v1/${table}`

  for (let i = 0; i < stamped.length; i += BATCH) {
    let res
    try {
      res = await _fetch(`${base}?on_conflict=${conflict}`, {
        method: 'POST',
        headers: restHeaders(creds.key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(stamped.slice(i, i + BATCH)),
      })
    } catch (e) {
      return { ok: false, configured: true, error: `supabase network: ${e?.message || e}` }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, configured: true, error: `supabase upsert batch ${i}: ${res.status} ${body.slice(0, 300)}` }
    }
  }

  // All batches landed — retire everything older than this batch.
  let swept = 0
  let res
  try {
    res = await _fetch(`${base}?synced_at=lt.${encodeURIComponent(syncedAt)}`, {
      method: 'DELETE',
      headers: restHeaders(creds.key, { Prefer: 'return=headers-only,count=exact' }),
    })
  } catch (e) {
    return { ok: false, configured: true, error: `supabase sweep network: ${e?.message || e}`, pushed: stamped.length }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, configured: true, error: `supabase sweep: ${res.status} ${body.slice(0, 300)}`, pushed: stamped.length }
  }
  // With count=exact the affected total is after the slash: "0-11/12", "*/0".
  const range = res.headers?.get?.('content-range') || ''
  const m = range.match(/\/(\d+)$/)
  if (m) swept = Number(m[1])

  return { ok: true, pushed: stamped.length, swept, syncedAt }
}

export async function pushWarehousePoLines({ _fetch = fetch, _nsFetch = fetch, env = process.env, now = () => new Date() } = {}) {
  const creds = warehouseSupabaseCreds(env)
  if (!creds) return { ok: false, configured: false }
  if (!netsuiteConfigured(env)) return { ok: false, configured: false }

  const pulled = await runSuiteQL(warehousePoLineSql(), { env, _fetch: _nsFetch })
  if (!pulled.ok) {
    return { ok: false, configured: true, error: pulled.needsAuth ? 'NetSuite auth rejected' : pulled.error || 'NetSuite pull failed' }
  }
  // A truncated pull must never replace the mirror — the sweep would delete
  // real open lines that merely fell off the last page (same rule as
  // prunePurchaseOrders).
  if (pulled.truncated) {
    return { ok: false, configured: true, error: 'NetSuite pull hit the page cap — INCOMPLETE, not pushing' }
  }

  const { rows, skippedNonItem, poCount } = mapWarehousePoLines(pulled.rows)
  // Zero open POs would mean the warehouse has nothing inbound at all —
  // implausible enough that an empty result is treated as a broken pull, not a
  // reason to empty the dock's table (mirrors the never-prune-against-empty
  // guard on our own tables).
  if (!rows.length) {
    return { ok: false, configured: true, error: 'pull returned 0 open PO lines — refusing to replace the mirror' }
  }

  const pushed = await pushSnapshot({ table: 'ns_open_po_lines', conflict: 'po_id,line_seq', rows, creds, _fetch, now })
  if (!pushed.ok) return pushed
  return { ...pushed, poCount, skippedNonItem }
}

// ── the inventory feed ────────────────────────────────────────────────────────
// One row per stocked item-location, replacing the app's manual "Warehouse
// Item View" CSV (which fills sku_catalog/location_qtys). aggregateItemLocation
// is NetSuite's per-location balance table — verified exposed to the bot role
// 2026-08-03 (~1,875 stocked rows live). Both qty measures ride along because
// the CSV pivot never said which one it carried: `available` subtracts
// commitments, `on_hand` is the physical count. Scope is any row with a
// NONZERO on-hand or available qty — negatives included (an oversold location
// is a fact, not noise; the reader clamps if it wants to).
export function warehouseInventorySql() {
  return `SELECT il.item AS item_id, i.itemid AS sku, i.displayname AS display_name,
                 i.itemtype AS item_type, il.location AS location_id,
                 l.fullname AS location_name,
                 il.quantityavailable AS qty_available, il.quantityonhand AS qty_on_hand
          FROM aggregateItemLocation il
          JOIN item i ON i.id = il.item
          JOIN location l ON l.id = il.location
          WHERE il.quantityonhand <> 0 OR il.quantityavailable <> 0
          ORDER BY il.item, il.location`
}

// SuiteQL rows → flat push rows. No filtering by SKU shape or item type — the
// reader owns its own catalog rules (its CSV parser already skips non-SKU
// rows); a feed that pre-filters would silently hide rows the app could see in
// its own export. Rows with no itemid at all can't key anything and are
// counted, not dropped silently.
export function mapWarehouseInventory(rows = []) {
  const out = []
  let skippedNoSku = 0
  for (const row of rows) {
    const sku = String(row.sku || '').trim()
    const itemId = String(row.item_id || '').trim()
    const locationId = String(row.location_id || '').trim()
    if (!sku || !itemId || !locationId) { skippedNoSku++; continue }
    out.push({
      item_id: itemId,
      location_id: locationId,
      sku,
      display_name: String(row.display_name || '').trim() || null,
      item_type: row.item_type || null,
      location_name: String(row.location_name || '').trim() || null,
      qty_available: Number(row.qty_available) || 0,
      qty_on_hand: Number(row.qty_on_hand) || 0,
    })
  }
  return { rows: out, skippedNoSku }
}

export async function pushWarehouseInventory({ _fetch = fetch, _nsFetch = fetch, env = process.env, now = () => new Date() } = {}) {
  const creds = warehouseSupabaseCreds(env)
  if (!creds) return { ok: false, configured: false }
  if (!netsuiteConfigured(env)) return { ok: false, configured: false }

  const pulled = await runSuiteQL(warehouseInventorySql(), { env, _fetch: _nsFetch })
  if (!pulled.ok) {
    return { ok: false, configured: true, error: pulled.needsAuth ? 'NetSuite auth rejected' : pulled.error || 'NetSuite pull failed' }
  }
  if (pulled.truncated) {
    return { ok: false, configured: true, error: 'NetSuite pull hit the page cap — INCOMPLETE, not pushing' }
  }

  const { rows, skippedNoSku } = mapWarehouseInventory(pulled.rows)
  // An empty warehouse is as implausible as zero inbound POs — treat it as a
  // broken pull, never a reason to sweep the mirror empty.
  if (!rows.length) {
    return { ok: false, configured: true, error: 'pull returned 0 stocked item-locations — refusing to replace the mirror' }
  }

  const pushed = await pushSnapshot({ table: 'ns_item_location_qtys', conflict: 'item_id,location_id', rows, creds, _fetch, now })
  if (!pushed.ok) return pushed
  return { ...pushed, skippedNoSku }
}
