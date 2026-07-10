// src/model/ocPoMatch.js
// The OC↔PO allocation matcher. Groups open demand (Order Confirmations) and
// open supply (Purchase Orders) by the confirmed join key — item + location
// (OC) vs item + destination (PO), see naghedi-locations memory — and splits
// EVERY still-open line into exactly one bucket, so nothing silently drops
// out of view:
//   - suggestedMatches: unambiguous 1:1, fully covered — ready to commit
//   - candidates: CONTENTION (>1 OC or >1 PO sharing a key) or SHORTAGE
//     (1:1 but the PO can't fully cover) — needs a human decision
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

    if (ocLines.length === 1 && poLines.length === 1) {
      const [oc] = ocLines
      const [po] = poLines
      if (po.remaining >= oc.remaining) {
        suggestedMatches.push({
          ocNumber: oc.ocNumber, poNumber: po.poNumber, item: oc.item,
          allocatedQty: oc.remaining, reason: 'UNAMBIGUOUS_1TO1',
        })
      } else {
        candidates.push({
          item: oc.item, location: oc.location, reason: 'SHORTAGE', ocs: ocLines, pos: poLines,
        })
      }
    } else {
      candidates.push({
        item: ocLines[0].item, location: ocLines[0].location, reason: 'CONTENTION', ocs: ocLines, pos: poLines,
      })
    }
  }

  const unmatchedPos = []
  for (const [k, poLines] of posByKey) {
    if (!visitedPoKeys.has(k)) unmatchedPos.push(...poLines) // open supply, no demand claiming it yet
  }

  return { suggestedMatches, candidates, unmatchedOcs, unmatchedPos }
}
