// src/model/poGroups.js — collapse the buyer-PO fan-out (Nima, 2026-07-09
// data-model decision, built 2026-07-17). NetSuite splits ONE customer PO into
// several Sales Orders — for Bloomingdale's/Nordstrom that's one PO per store
// location (e.g. PO 7590875 → 23 SOs), which inflates every list with no
// benefit. This rolls SOs that share a non-empty customer PO number
// (orders.po_number = otherRefNum) into one line, WITHOUT hiding the fan-out:
// each group keeps its member SOs (locations, IFs) for drill-down.
//
// Orders with no PO number stay individual. Grouping is by po_number ALONE —
// the "customer" differs across a Bloomingdale's PO (store suffixes), so it
// can't be part of the key.

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
    members,
  }
}

// Returns a flat list: single orders (no PO, or a PO with one SO) pass through
// unchanged; POs with >1 SO become one group row carrying `members`.
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
    out.push(members.length === 1 ? members[0] : mergeGroup(po, members))
  }
  return out
}
