// src/model/ocPoMatch.js
// The OC↔PO allocation matcher. Groups open demand (Order Confirmations) and
// open supply (Purchase Orders) by the confirmed join key — item + location
// (OC) vs item + destination (PO), see naghedi-locations memory — and splits
// EVERY still-open line into exactly one bucket, so nothing silently drops
// out of view:
//   - suggestedMatches: supply covers the demand on that key — ready to commit
//   - candidates: SHORTAGE — the open POs can't cover the open OCs on that key.
//     The only genuine human decision: who gets the units, or buy more.
//   - unmatchedOcs / unmatchedPos: open demand/supply with no counterpart at
//     all yet — nothing to commit, but still an open task (wait, or dismiss)
//
// Decision (Nima, 2026-07-09): kept entirely manual at this stage — even the
// unambiguous matches are SUGGESTIONS, not auto-committed. Nothing writes to
// oc_po_links without an explicit human action (see scripts/commit-oc-po.js
// and the /api/oc-po/commit endpoint).
//
// Pure function: no DB access, so it's fully unit-testable. The caller reads
// current rows + existing links and decides what (if anything) to write back.

const key = (item, place) => `${item}@@${place || ''}`

export function computeOcPoMatches({ ocs = [], pos = [], links = [] } = {}) {
  // Net out quantity already committed in oc_po_links, per OC line and per PO
  // line, so re-running the matcher after partial allocations sees the true
  // remaining demand/supply rather than double-allocating.
  const allocatedByOc = new Map()
  const allocatedByPo = new Map()
  for (const l of links) {
    const q = l.allocatedQty || 0
    const ocKey = `${l.ocNumber}@@${l.item}`
    const poKey = `${l.poNumber}@@${l.item}`
    allocatedByOc.set(ocKey, (allocatedByOc.get(ocKey) || 0) + q)
    allocatedByPo.set(poKey, (allocatedByPo.get(poKey) || 0) + q)
  }

  const openOcs = ocs
    .filter((o) => !o.dismissed && o.status === 'Open')
    .map((o) => ({ ...o, remaining: (o.qty || 0) - (allocatedByOc.get(`${o.ocNumber}@@${o.item}`) || 0) }))
    .filter((o) => o.remaining > 0)

  const openPos = pos
    .filter((p) => !p.dismissed)
    .map((p) => ({ ...p, remaining: (p.qtyRemaining || 0) - (allocatedByPo.get(`${p.poNumber}@@${p.item}`) || 0) }))
    .filter((p) => p.remaining > 0)

  const ocsByKey = new Map()
  for (const o of openOcs) {
    const k = key(o.item, o.location)
    if (!ocsByKey.has(k)) ocsByKey.set(k, [])
    ocsByKey.get(k).push(o)
  }
  const posByKey = new Map()
  for (const p of openPos) {
    const k = key(p.item, p.destination)
    if (!posByKey.has(k)) posByKey.set(k, [])
    posByKey.get(k).push(p)
  }

  const suggestedMatches = []
  const candidates = []
  const unmatchedOcs = []
  const visitedPoKeys = new Set()

  for (const [k, ocLines] of ocsByKey) {
    const poLines = posByKey.get(k) || []
    if (!poLines.length) {
      unmatchedOcs.push(...ocLines) // open demand, nothing matching it yet
      continue
    }
    visitedPoKeys.add(k)

    // One incoming PO is SUPPOSED to cover several order confirmations (Nima,
    // 2026-08-02) — that's how non-ATS demand is funded, not a conflict. So the
    // question on a key is only ever "does the open supply cover the open
    // demand?", never "how many OCs are there?". Treating multi-OC as contention
    // filed 166 of 212 candidates (78%) as decisions that had nothing to decide,
    // and hid the 46 real shortages inside the same bucket.
    const demand = ocLines.reduce((sum, o) => sum + o.remaining, 0)
    const supply = poLines.reduce((sum, p) => sum + p.remaining, 0)

    if (supply < demand) {
      candidates.push({
        item: ocLines[0].item, location: ocLines[0].location, reason: 'SHORTAGE',
        demand, supply, shortBy: demand - supply, ocs: ocLines, pos: poLines,
      })
      continue
    }

    // Covered. Draw each OC's units from the POs arriving soonest, so the
    // earliest container funds the earliest need and a suggestion names a real
    // PO rather than an aggregate. Still only a SUGGESTION — nothing writes to
    // oc_po_links without an explicit human action (decision, 2026-07-09).
    const supplyQueue = [...poLines]
      .sort((a, b) => String(a.expectedReceipt || '9999').localeCompare(String(b.expectedReceipt || '9999')))
      .map((p) => ({ po: p, left: p.remaining }))
    const oneToOne = ocLines.length === 1 && poLines.length === 1
    for (const oc of ocLines) {
      let need = oc.remaining
      for (const slot of supplyQueue) {
        if (need <= 0) break
        if (slot.left <= 0) continue
        const take = Math.min(need, slot.left)
        slot.left -= take
        need -= take
        suggestedMatches.push({
          ocNumber: oc.ocNumber, poNumber: slot.po.poNumber, item: oc.item,
          allocatedQty: take, reason: oneToOne ? 'UNAMBIGUOUS_1TO1' : 'COVERED_BY_INCOMING',
        })
      }
    }
  }

  const unmatchedPos = []
  for (const [k, poLines] of posByKey) {
    if (!visitedPoKeys.has(k)) unmatchedPos.push(...poLines) // open supply, no demand claiming it yet
  }

  return { suggestedMatches, candidates, unmatchedOcs, unmatchedPos }
}
