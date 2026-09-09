// src/model/packingSlipRevision.js — did this slip change since we last read it?
//
// ⚠️ WHY THIS IS ITS OWN RULE. Re-importing a container REPLACES its lines, which
// is right — the newest document is the truth. But a factory reissues a slip when a
// shipment actually changes, and a plain replace makes that change invisible: the
// totals move and nothing says they moved. The Item Receipt may already have gone
// to NetSuite against the old numbers.
//
// So a re-import that alters the totals is NEWS. It is recorded before the replace,
// and the caller is told, so "1,439 units" is always attributable to a document.
// Same standing rule as [[prefer-entered-over-derived]]: keep what was said, and when.
//
// ⚠️ AND A MATCHING RE-IMPORT IS SILENT. Dropping the same file in twice is a
// normal thing to do — checking you imported it, or re-running after a fix
// elsewhere. Logging that as a revision would fill the history with non-events and
// train everyone to ignore it.

// ⚠️ ASCII ARROWS, NOT "→". These strings reach the same print and PDF surfaces
// where pdfkit's built-in Helvetica rendered "⚠" as "&" — anything outside WinAnsi
// is silently mangled rather than throwing. Caught by this module's own test.
const num = (v) => (v == null ? null : Number(v))

/**
 * Compare an incoming parse against what is already stored.
 *
 * @param stored   the packing_slip row, or null when this container is new
 * @param incoming the freshly parsed container
 * @returns { isNew, changed, revision|null, changes[] }
 *   revision  the row to write BEFORE replacing lines, or null when nothing moved
 *   changes   human-readable, for the import screen
 */
export function slipRevision(stored, incoming, { sourceFilename = null } = {}) {
  if (!stored) {
    return { isNew: true, changed: false, revision: null, changes: [] }
  }
  const prevUnits = num(stored.unit_count ?? stored.unitCount)
  const newUnits = num(incoming.unitCount)
  const prevCartons = num(stored.carton_count ?? stored.cartonCount)
  const newCartons = num(incoming.cartonCount)

  const changes = []
  if (prevUnits !== newUnits) changes.push(`units ${prevUnits} -> ${newUnits}`)
  // ⚠️ null → 5 IS a change worth reporting (a master list replaced by the factory
  // slip, so cartons became knowable), but 5 → null is a LOSS of detail and worth
  // reporting even more loudly.
  if (prevCartons !== newCartons) {
    changes.push(prevCartons == null
      ? `cartons now known: ${newCartons}`
      : newCartons == null
        ? `cartons NO LONGER KNOWN (was ${prevCartons}) — a master list cannot carry them`
        : `cartons ${prevCartons} -> ${newCartons}`)
  }

  const prevPos = [...(stored.po_numbers ?? stored.poNumbers ?? [])].sort()
  const nextPos = [...(incoming.poNumbers ?? [])].sort()
  if (prevPos.join(',') !== nextPos.join(',')) {
    const gone = prevPos.filter((p) => !nextPos.includes(p))
    const added = nextPos.filter((p) => !prevPos.includes(p))
    // ⚠️ A DISAPPEARED PO IS THE SERIOUS ONE. Units for it may already be received
    // in NetSuite against the previous version of this slip.
    if (gone.length) changes.push(`PO no longer on the slip: ${gone.join(', ')} — check whether it was already received`)
    if (added.length) changes.push(`PO added: ${added.join(', ')}`)
  }

  if (!changes.length) return { isNew: false, changed: false, revision: null, changes: [] }
  return {
    isNew: false,
    changed: true,
    changes,
    revision: {
      containerNum: incoming.containerNum,
      prevUnits, newUnits, prevCartons, newCartons,
      sourceFilename,
      note: changes.join(' · '),
    },
  }
}
