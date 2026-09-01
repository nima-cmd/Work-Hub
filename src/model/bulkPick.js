// src/model/bulkPick.js — the bulk pick ticket: how many of each SKU, across a set of POs.
//
// Replaces a NetSuite Suitelet ("Bulk Pick & Ship Manifest") that Nima opens whenever a
// partner PO is split across many stores: you paste PO numbers, it totals the units per
// SKU so the floor can pull them in one pass. His words, 2026-08-31: "we use it to make a
// bulk pull for our PO in netsuite mainly for when its multiple stores… just to know the
// number of units total for a po."
//
// Live shape of the problem: PO 7242978 is 23 sales orders across 23 stores and 684
// units; PO 50073678 is 25 stores.
//
// ── ⚠️ THE RULES ARE WORK-HUB'S, NOT THE SUITELET'S, AND THEY DIFFER ─────────
//
// Measured across all 135 POs since 2026-05-01 (4,202 lines) before writing this:
//
//   · CLOSED LINES ARE DROPPED. The Suitelet has no isclosed filter. 332 closed goods
//     lines carrying 1,745 units would otherwise land on pick tickets. ⚠️ On LIVE work
//     the two rule sets agree exactly (PO 7242978: 684 = 684) — every one of the 27
//     disagreeing POs is on a sales order already at "Sales Order : Closed". So this is
//     a guard against typing a dead PO, not a fix for everyday numbers. PO 40847685
//     would otherwise ask for 650 units across three fully-closed orders.
//
//   · ITEM TYPES ARE A DENY LIST, not `InvtPart` only. Same rule as the order roll-up:
//     an unknown type counts as goods, so the day an Assembly or Kit appears its units
//     land in the pick instead of vanishing. An overcount announces itself on the floor;
//     an undercount does not. ⚠️ Zero non-InvtPart goods lines exist today, so this
//     changes nothing now — it is insurance, and it is honest to say so.
//
//   · QUANTITIES ARE ABS'd. `tl.quantity` comes back NEGATIVE for sales orders in
//     SuiteQL (1,884 of 1,884 open lines) while the saved search the Suitelet uses
//     returns positive. Porting without this would produce a pick ticket of negatives.
//
// ⚠️ A PO WHOSE LINES ARE ALL CLOSED REPORTS ZERO **AND SAYS WHY** (Nima's call). A blank
// sheet and "this PO is cancelled" look identical on paper, and only one of them tells
// you that you typed the wrong number.

import { NON_ITEM_LINE_TYPES } from '../ingest/netsuiteSync.js'

const isClosedLine = (v) => v === true || v === 'T' || v === 't' || v === 'true'
const units = (v) => Math.abs(Number(v) || 0)
const norm = (v) => String(v ?? '').trim()
const key = (v) => norm(v).toUpperCase()

/** Split a pasted list of PO numbers. Commas, newlines or whitespace all work. */
export function parsePoInput(text) {
  const seen = new Set()
  const out = []
  for (const raw of String(text ?? '').split(/[,\n\r\t]+/)) {
    const po = norm(raw)
    if (!po || seen.has(key(po))) continue
    seen.add(key(po))
    out.push(po)
  }
  return out
}

/** Is this line goods on a shelf? */
export const isGoodsLine = (line = {}) => !NON_ITEM_LINE_TYPES.includes(line.itemtype)

/**
 * Fold SO lines into a bulk pick ticket.
 *
 * @param lines  [{ po, tranid, soStatus, sku, itemtype, quantity, isclosed }]
 * @param asked  the PO numbers the user typed, so absent ones can be named
 */
export function bulkPick(lines = [], asked = []) {
  const wanted = asked.length ? new Set(asked.map(key)) : null
  const rows = lines.filter((l) => !wanted || wanted.has(key(l.po)))

  // Per-PO bookkeeping, kept for EVERY asked PO — including the ones that turn out to
  // have nothing pickable, because those are the ones worth explaining.
  const poStats = new Map()
  const statFor = (po) => {
    const k = key(po)
    if (!poStats.has(k)) {
      poStats.set(k, { po: norm(po), units: 0, cancelledUnits: 0, salesOrders: new Set(), stores: new Set(), statuses: new Set() })
    }
    return poStats.get(k)
  }
  for (const po of asked) statFor(po)

  const bySku = new Map()
  // ⚠️ WHAT THE HEADLINE COUNTS IS WHAT IS BEING PICKED, NOT WHAT WAS ASKED ABOUT.
  // The first cut summed every PO's orders and stores, so a ticket for 684 pickable units
  // headlined "26 sales orders · 26 stores" — 23 real ones plus the 3 fully-cancelled
  // orders on a dead PO that contribute nothing. That is the counts-something-other-than-
  // its-label shape, on the number a person reads before walking the floor. The cancelled
  // PO gets its own banner; it does not get to inflate the pick.
  const pickedSos = new Set()
  const pickedStores = new Set()
  // ⚠️ The locations the PICKED lines sit in — not every location on every asked PO. A
  // fully-cancelled PO must not add a column to the stock table for a location nothing
  // is being pulled from (the same counts-what-it-says rule as `pickedSos`).
  const orderLocations = new Map()
  for (const l of rows) {
    const st = statFor(l.po)
    if (l.tranid) st.salesOrders.add(norm(l.tranid))
    if (l.customer) st.stores.add(storeOf(l.customer))
    if (l.soStatus) st.statuses.add(norm(l.soStatus))
    if (!isGoodsLine(l)) continue
    const qty = units(l.quantity)
    // ⚠️ Cancelled demand is COUNTED SEPARATELY, never silently discarded — it is the
    // number that explains a PO reporting zero.
    if (isClosedLine(l.isclosed)) { st.cancelledUnits += qty; continue }
    const sku = norm(l.sku)
    if (!sku) continue
    st.units += qty
    if (l.tranid) pickedSos.add(norm(l.tranid))
    const store = storeOf(l.customer)
    if (store) pickedStores.add(store)
    if (norm(l.locationId)) {
      orderLocations.set(norm(l.locationId), { id: norm(l.locationId), name: norm(l.locationName) || norm(l.locationId) })
    }
    if (!bySku.has(sku)) bySku.set(sku, { sku, itemId: norm(l.itemId) || null, total: 0, byPo: {} })
    const g = bySku.get(sku)
    // A SKU reached by more than one line keeps the first item id it was given; they are
    // the same item by definition, since the id is what NetSuite resolved the name from.
    if (!g.itemId && norm(l.itemId)) g.itemId = norm(l.itemId)
    g.total += qty
    g.byPo[norm(l.po)] = (g.byPo[norm(l.po)] || 0) + qty
  }

  const pos = [...poStats.values()].map((s) => ({
    po: s.po,
    units: s.units,
    cancelledUnits: s.cancelledUnits,
    salesOrders: s.salesOrders.size,
    stores: s.stores.size,
    // ⚠️ Three DIFFERENT ways a PO can contribute nothing, named apart rather than
    // lumped into one empty row (the never-lump rule):
    //   missing    — NetSuite has no sales order carrying this PO at all: a typo, or
    //                the order has not been entered yet.
    //   allClosed  — the orders exist and every unit on them is cancelled.
    //   empty      — the orders exist, are open, and carry no goods lines.
    verdict: s.salesOrders.size === 0 ? 'missing'
      : s.units === 0 && s.cancelledUnits > 0 ? 'allClosed'
      : s.units === 0 ? 'empty' : 'ok',
    statuses: [...s.statuses].sort(),
  })).sort((a, b) => a.po.localeCompare(b.po))

  const skus = [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku))
  return {
    skus,
    pos,
    // The PO columns the ticket needs, in the order the POs are listed.
    poColumns: pos.filter((p) => p.units > 0).map((p) => p.po),
    totalUnits: skus.reduce((a, s) => a + s.total, 0),
    skuCount: skus.length,
    // ⚠️ Only the orders and stores that actually contribute units — see above.
    salesOrders: pickedSos.size,
    stores: pickedStores.size,
    missing: pos.filter((p) => p.verdict === 'missing').map((p) => p.po),
    allClosed: pos.filter((p) => p.verdict === 'allClosed'),
    // ⚠️ NOT "Warehouse". Measured live 2026-09-01: a multi-store partner PO's lines sit
    // in `Warehouse Bulk : Bloomingdale's` / `Warehouse Bulk : Nordstrom`, buckets that
    // held ZERO units of every SKU on the order. Naming the order's own location is the
    // difference between "you have none" and "you have none HERE".
    orderLocations: [...orderLocations.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * The store a line is for.
 *
 * ⚠️ THE SUITELET'S RULE IS A NO-OP ON THIS ACCOUNT'S DATA. It does
 * `entity.split(' : ').pop()`, taking the last child of NetSuite's "Parent : Child"
 * customer hierarchy. Measured 2026-08-31 across three real multi-store POs: **0 of 51
 * distinct customers contain " : "**. They are all of the form
 * "425 Nordstrom - 425 - Valley Fair", so that split returns the whole string unchanged.
 *
 * It is not producing wrong answers — every store IS a distinct customer, so grouping on
 * the full name still groups by store. But the code says it is parsing a hierarchy and it
 * is not, which is the comment-describing-a-mechanism-no-code-implements shape.
 *
 * So this handles what the data actually looks like, and falls back to the whole name
 * rather than guessing: an unrecognised format is its own store, never an error.
 */
export function storeOf(customer) {
  const raw = norm(customer)
  if (!raw) return ''
  // The hierarchy form, if this account ever starts using it.
  if (raw.includes(' : ')) return norm(raw.split(' : ').pop())
  // "425 Nordstrom - 425 - Valley Fair" → "Valley Fair".
  const dash = raw.split(' - ')
  if (dash.length >= 3) return norm(dash[dash.length - 1])
  return raw
}

/** One line per SKU, for a printed sheet. */
export const pickLines = (ticket) =>
  ticket.skus.map((s) => ({ sku: s.sku, qty: s.total }))
