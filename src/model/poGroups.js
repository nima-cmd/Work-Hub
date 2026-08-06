// src/model/poGroups.js — collapse the buyer-PO fan-out (Nima, 2026-07-09
// data-model decision, built 2026-07-17). NetSuite splits ONE customer PO into
// several Sales Orders — for Bloomingdale's/Nordstrom that's one PO per store
// location (e.g. PO 7590875 → 23 SOs), which inflates every list with no
// benefit. This rolls SOs that share a non-empty customer PO number
// (orders.po_number = otherRefNum) into one line, WITHOUT hiding the fan-out:
// each group keeps its member SOs (locations, IFs) for drill-down.
//
// Orders with no PO number stay individual. Within EDI, grouping is by po_number
// ALONE — the "customer" differs across a Bloomingdale's PO (store suffixes), so it
// can't be part of the key.
//
// ⚠️ GROUPING IS AN EDI CONCEPT AND IS NOW GATED ON IT (Nima, 2026-08-06).
//
// The paragraph above always said this rule exists for "Bloomingdale's/Nordstrom", but
// the code grouped by po_number for EVERYONE — a comment describing one mechanism while
// the code implemented a broader one. A boutique that happens to reuse a PO across two
// sales orders is TWO shipments, not one consolidated freight movement, and rolling
// them up hid that.
//
// Live when this was fixed: 5 boutique POs / 10 sales orders wrongly grouped —
// Four Seasons Maui PO05658, Four Seasons Hualalai PO15131, Julian Gold 72426N,
// Robertson Madison 80126, Joseph Wexner RBR-12.
//
// ⚠️ It also broke SCANNING, which is how Nima found it. A grouped card's custody is
// computed over ALL its members' fulfilments, so scanning ONE of two read as the whole
// group being back (see cardCustody in custody.js — the `returned` branch carried no
// fraction). Ungrouping makes a boutique scan unambiguous: one card, one IF.

import { STAGE_RANK } from './stages.js'

const sum = (arr, k) => arr.reduce((n, o) => n + (o[k] || 0), 0)

// Common customer label for a group: the token before the first " - " (store
// suffix) when every member shares it (→ "Bloomingdale's", "Nordstrom"),
// else a neutral label.
function commonCustomer(customers) {
  const bases = customers.map((c) => (c || '').split(' - ')[0].trim()).filter(Boolean)
  if (!bases.length) return 'Multiple'
  return bases.every((b) => b === bases[0]) ? bases[0] : 'Multiple customers'
}

// Union of member flags, deduped by key keeping the highest severity.
function mergeFlags(members) {
  const byKey = new Map()
  for (const f of members.flatMap((m) => m.flags || [])) {
    const prev = byKey.get(f.key)
    if (!prev || (f.severity || 0) > (prev.severity || 0)) byKey.set(f.key, f)
  }
  return [...byKey.values()].sort((a, b) => (b.severity || 0) - (a.severity || 0))
}

function mergeGroup(poNumber, members) {
  // lead = the member furthest along the pipeline; drives stage/next-action
  const lead = [...members].sort((a, b) => (STAGE_RANK[b.stage] || 0) - (STAGE_RANK[a.stage] || 0))[0]
  return {
    isGroup: true,
    poNumber,
    soNumber: poNumber, // React key / sort handle
    customer: commonCustomer(members.map((m) => m.customer)),
    memberCount: members.length,
    locations: members.map((m) => m.customer),
    soNumbers: members.map((m) => m.soNumber),
    stage: lead.stage,
    stageRank: STAGE_RANK[lead.stage] || 0,
    nextAction: lead.nextAction,
    location: lead.location,
    source: lead.source,
    severity: Math.max(0, ...members.map((m) => m.severity || 0)),
    daysPending: Math.max(0, ...members.map((m) => m.daysPending || 0)),
    qtyOrdered: sum(members, 'qtyOrdered'),
    qtyFulfilled: sum(members, 'qtyFulfilled'),
    fulfillments: members.flatMap((m) => m.fulfillments || []),
    invoices: members.flatMap((m) => m.invoices || []),
    flags: mergeFlags(members),
    // Every SO on a PO shares that PO's 850, so the EDI window is identical
    // across members — but their sales-order ship dates need not be. Take the
    // tightest deadline so a group never reads later than one of its members.
    shipWindow: tightestWindow(members),
    members,
  }
}

function tightestWindow(members) {
  const ws = members.map((m) => m.shipWindow).filter((w) => w && w.mustShipBy != null)
  if (!ws.length) return members.find((m) => m.shipWindow)?.shipWindow || null
  return ws.reduce((a, b) => (b.mustShipBy < a.mustShipBy ? b : a))
}

// Returns a flat list: orders with no PO pass through unchanged; POs with >1 SO
// become one group row carrying `members`. EDI orders (Nima, 2026-07-21) are
// ALWAYS referenced by their customer PO — never the sales order — so a
// single-SO EDI PO still becomes a (one-member) PO group rather than showing
// its SO number. Non-EDI single-SO POs keep passing through as their SO row.
export function groupOrdersByPo(orders = []) {
  const byPo = new Map()
  const out = []
  for (const o of orders) {
    const po = (o.poNumber || '').trim()
    if (!po) { out.push(o); continue }
    if (!byPo.has(po)) byPo.set(po, [])
    byPo.get(po).push(o)
  }
  for (const [po, members] of byPo) {
    // EDI POs always group — even a single-SO one, because the fan-out arrives over
    // time and the EDI board expects a group card. Everything else stays individual,
    // however many sales orders share the PO.
    const isEdi = members.some((m) => m.source === 'edi')
    if (!isEdi) { out.push(...members); continue }
    out.push(mergeGroup(po, members))
  }
  return out
}
