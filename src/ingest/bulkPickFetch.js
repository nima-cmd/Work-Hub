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
                 tl.itemtype, tl.quantity, tl.isclosed
            FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
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
    itemtype: get('itemtype'),
    quantity: get('quantity'),
    isclosed: get('isclosed'),
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
