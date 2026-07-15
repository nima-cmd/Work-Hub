// src/model/ocPoContainers.js
// Location-first view of the OC↔PO allocation queue (Nima, 2026-07-10):
//   Location (final destination) → PO "containers" → line items → contending OCs
// This sits ALONGSIDE computeOcPoMatches (src/model/ocPoMatch.js), which stays
// the source of truth for the 1:1 suggestion / contention / shortage logic and
// keeps its own tests. This module regroups the same open OC/PO/link data by
// place and by PO number so the review page can start from "which location
// needs attention" and drill into "how full is this container" before ever
// touching a single line — same match key (item + location/destination), just
// a different lens. Nothing here writes anything either.

const key = (item, place) => `${item}@@${place || ''}`
const UNASSIGNED = '(no destination yet)'

export function computeContainerView({ ocs = [], pos = [], links = [] } = {}) {
  const allocatedByOc = new Map()
  const allocatedByPo = new Map()
  for (const l of links) {
    // Postgres numeric columns come back as strings — cast before summing or
    // `0 + "23"` silently concatenates instead of adding.
    const q = Number(l.allocatedQty) || 0
    allocatedByOc.set(`${l.ocNumber}@@${l.item}`, (allocatedByOc.get(`${l.ocNumber}@@${l.item}`) || 0) + q)
    allocatedByPo.set(`${l.poNumber}@@${l.item}`, (allocatedByPo.get(`${l.poNumber}@@${l.item}`) || 0) + q)
  }

  // Open demand: every non-dismissed, non-fully-allocated OC line.
  const openOcs = ocs
    .filter((o) => !o.dismissed && o.status === 'Open')
    .map((o) => ({ ...o, remaining: (Number(o.qty) || 0) - (allocatedByOc.get(`${o.ocNumber}@@${o.item}`) || 0) }))
    .filter((o) => o.remaining > 0)

  const ocsByKey = new Map()
  for (const o of openOcs) {
    const k = key(o.item, o.location)
    if (!ocsByKey.has(k)) ocsByKey.set(k, [])
    ocsByKey.get(k).push(o)
  }

  // PO lines keep every non-dismissed row (even fully-consumed ones) so a
  // container shows 100% full instead of the line vanishing.
  const poLines = pos
    .filter((p) => !p.dismissed)
    .map((p) => {
      const originalQty = Number(p.qtyRemaining) || 0
      const allocated = allocatedByPo.get(`${p.poNumber}@@${p.item}`) || 0
      return { ...p, originalQty, allocated, openQty: Math.max(0, originalQty - allocated) }
    })

  // ── Containers: one per PO number ──────────────────────────────────────────
  const containersByPo = new Map()
  for (const p of poLines) {
    if (!containersByPo.has(p.poNumber)) containersByPo.set(p.poNumber, [])
    containersByPo.get(p.poNumber).push(p)
  }

  const containers = [...containersByPo.entries()].map(([poNumber, lines]) => {
    const destination = lines[0].destination || UNASSIGNED
    const items = lines.map((p) => {
      const contendingOcs = (ocsByKey.get(key(p.item, p.destination)) || [])
        .map((o) => ({ ocNumber: o.ocNumber, customer: o.customer, remaining: o.remaining }))
      const demand = contendingOcs.reduce((sum, o) => sum + o.remaining, 0)
      const status =
        p.openQty <= 0 ? 'FULL' :
        contendingOcs.length === 0 ? 'NO_DEMAND' :
        demand > p.openQty ? 'SHORTAGE' :
        contendingOcs.length === 1 ? 'READY' : 'CONTENTION'
      return { item: p.item, originalQty: p.originalQty, allocated: p.allocated, openQty: p.openQty, contendingOcs, status }
    })
    const totalCapacity = items.reduce((sum, i) => sum + i.originalQty, 0)
    const totalAllocated = items.reduce((sum, i) => sum + i.allocated, 0)
    return {
      poNumber, destination, vendor: lines[0].vendor, expectedReceipt: lines[0].expectedReceipt,
      totalCapacity, totalAllocated,
      fillPct: totalCapacity > 0 ? Math.round((totalAllocated / totalCapacity) * 100) : 0,
      shortItemCount: items.filter((i) => i.status === 'SHORTAGE').length,
      items,
    }
  })

  // ── Unassigned demand: open OC lines with no PO at all sharing item+place ──
  const posByKey = new Map()
  for (const p of poLines) {
    const k = key(p.item, p.destination)
    if (!posByKey.has(k)) posByKey.set(k, [])
    posByKey.get(k).push(p)
  }
  const unassignedOcs = openOcs.filter((o) => !posByKey.has(key(o.item, o.location)))

  // ── Location hub: one tile per distinct place seen on either side ──────────
  const places = new Set([...openOcs.map((o) => o.location), ...poLines.map((p) => p.destination || UNASSIGNED)])
  const locations = [...places].map((place) => {
    const ocsHere = openOcs.filter((o) => o.location === place)
    const poItemsHere = containers.filter((c) => c.destination === place).flatMap((c) => c.items)
    return {
      location: place,
      openOcCount: ocsHere.length,
      openOcUnits: ocsHere.reduce((sum, o) => sum + o.remaining, 0),
      openPoCount: poItemsHere.filter((i) => i.openQty > 0).length,
      openPoUnits: poItemsHere.reduce((sum, i) => sum + i.openQty, 0),
      containerCount: containers.filter((c) => c.destination === place).length,
      shortItemCount: poItemsHere.filter((i) => i.status === 'SHORTAGE').length,
      unassignedOcCount: unassignedOcs.filter((o) => o.location === place).length,
    }
  }).sort((a, b) => (b.openOcUnits + b.openPoUnits) - (a.openOcUnits + a.openPoUnits))

  return { locations, containers, unassignedOcs }
}
