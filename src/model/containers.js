// src/model/containers.js
// Inbound containers — the arrival side of the pipeline, grouped the way the
// goods actually move (Nima, 2026-08-02):
//
//   "The PO due dates generally coincide with another shipment/container that is
//    to arrive. These POs can be split shipment and sent in multiple containers.
//    You may notice that several POs have the same due date. This indicates that
//    they are most likely to be grouped together into a container."
//
// So a container is not a record anywhere in NetSuite — it is the set of POs
// sharing a due date. The data agrees: open POs cluster 7/7/7/6/12 on single
// dates in the live window, and degrade to lone POs in the old tail.
//
// ── what this module is NOT ──────────────────────────────────────────────────
// It does NOT model the physical container. The Naghedi-Warehouse app owns that
// (its own Supabase `containers` table, the packing-slip breakdown, and
// exportGenerator.js which emits the Item Receipt and Inventory Transfer CSVs).
// Duplicating it here would create a second competing truth. This module answers
// only the question that app structurally cannot: a container exists over there
// once the packing slip arrives, so nothing there can tell you that a container
// was due five weeks ago and you have not started one for it yet.
//
// The full inbound flow, and who owns which step:
//   1 PO issued to the factory                    NetSuite  → synced here
//   2 POs grouped into a container by due date    THIS MODULE
//   3 packing slip + email confirm real contents  (manual)
//   4 Item Receipt against the PO                 Naghedi-Warehouse → NetSuite
//   5 Transfer Order China → final destination    Naghedi-Warehouse → NetSuite
//   6 stock lands, allocatable to OCs             ocPoMatch.js
//
// Pure: no DB, no clock of its own (`today` is injected), nothing written.

// ── what can and cannot be known ─────────────────────────────────────────────
// The app CANNOT tell "the container never arrived" apart from "it arrived, was
// received, and a few lines were never closed out in NetSuite". Both look
// identical from here: open PO lines past a due date. Only Nima knows which.
//
// So this does not guess with a cleverer threshold. It splits on the one thing
// that is unambiguous — age — exactly as the filing ledger splits `due` from
// `backlog` (src/model/filing.js), and states the uncertainty on the surface
// instead of hiding it behind a state name.

// Containers due within this window are the live board. Older open lines are
// almost certainly bookkeeping tails, not shipments still at sea: measured
// 2026-08-02, everything past it is 1–2 POs owing 1–75 units, against thousands
// of units per real container inside it. Same 120 days the ASN carton check uses.
export const LIVE_WINDOW_DAYS = 120

// A container whose units are nearly all received has landed and been receipted;
// what is left is a tail. Collapsed even when recent — PO1738 is 62 days past
// due at 99% received, which is a reconciliation job, not a missing shipment.
export const REMNANT_RECEIVED_PCT = 0.9

const iso = (d) => {
  if (!d) return null
  const s = typeof d === 'string' ? d : new Date(d).toISOString()
  return s.slice(0, 10)
}

const daysBetween = (from, to) =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

// Four states, in the order they're tested:
//   remnant  — ≥90% received. Landed; leftover units. Collapsed, never nags.
//   long-past — due more than LIVE_WINDOW_DAYS ago. Collapsed, never nags, and
//              labelled as unreconciled rather than overdue, because it most
//              likely already landed.
//   awaiting — due date still ahead. Nothing to do yet.
//   late     — past due, inside the window, still owing most of its units. The
//              only state that nags.
//
// Deliberately NOT a separate "partially received" state. A container 32 days
// past due with 6% of its units receipted is not being worked — it is late, and
// the headline says how much did arrive. An earlier cut of this filed both real
// containers under "receiving" on the strength of a rounding-error receipt while
// seven ancient one-unit dregs took the chip.
export function containerState(receivedPct, daysLate) {
  if (receivedPct >= REMNANT_RECEIVED_PCT) return 'remnant'
  if (daysLate > LIVE_WINDOW_DAYS) return 'long-past'
  if (daysLate <= 0) return 'awaiting'
  return 'late'
}

// The two collapsed states, kept in one bucket because they mean the same thing
// to Nima — an open line that is not a pending arrival — while keeping the
// reason on the row so the surface can say which.
export const COLLAPSED_STATES = ['remnant', 'long-past']

// pos: rows as fetchPurchaseOrders returns them
//   { poNumber, item, vendor, destination, status, expectedReceipt, qtyRemaining, ... }
// Returns containers newest-arrival-first, plus the two buckets that are
// deliberately kept out of the nag.
export function groupContainers(pos = [], { today = new Date() } = {}) {
  const asOf = iso(today)
  const open = pos.filter((p) => !p.dismissed && (Number(p.qtyRemaining) || 0) > 0)

  const byDate = new Map()
  const undated = []

  for (const p of open) {
    const eta = iso(p.expectedReceipt)
    // No due date means no container to belong to and, under the ledger's
    // honest-timestamp rule, no basis whatsoever for calling it late.
    if (!eta) { undated.push(p); continue }
    if (!byDate.has(eta)) {
      byDate.set(eta, {
        key: eta, expectedReceipt: eta, lines: [], poNumbers: new Set(),
        destinations: new Set(), vendors: new Set(),
        unitsOrdered: 0, unitsReceived: 0, unitsOpen: 0,
      })
    }
    const c = byDate.get(eta)
    c.lines.push(p)
    c.poNumbers.add(p.poNumber)
    // A PO with no Final Naghedi Destination cannot be matched to demand at all
    // — tracked as a count so the surface can say so rather than silently
    // showing a blank.
    if (p.destination) c.destinations.add(p.destination)
    if (p.vendor) c.vendors.add(p.vendor)
    c.unitsOrdered += Number(p.qtyOrdered) || 0
    c.unitsReceived += Number(p.qtyReceived) || 0
    c.unitsOpen += Number(p.qtyRemaining) || 0
  }

  const all = [...byDate.values()].map((c) => {
    const daysLate = daysBetween(c.expectedReceipt, asOf)
    // Guard the divide: a container of zero ordered units can't be a ratio.
    const receivedPct = c.unitsOrdered > 0 ? c.unitsReceived / c.unitsOrdered : 0
    return {
      key: c.key,
      expectedReceipt: c.expectedReceipt,
      daysLate,
      state: containerState(receivedPct, daysLate),
      receivedPct,
      poNumbers: [...c.poNumbers].sort(),
      poCount: c.poNumbers.size,
      lineCount: c.lines.length,
      unitsOrdered: c.unitsOrdered,
      unitsReceived: c.unitsReceived,
      unitsOpen: c.unitsOpen,
      destinations: [...c.destinations].sort(),
      unmatchableLines: c.lines.filter((l) => !l.destination).length,
      vendors: [...c.vendors].sort(),
    }
  })

  // Live board: most overdue first, then the soonest arrivals.
  const containers = all
    .filter((c) => !COLLAPSED_STATES.includes(c.state))
    .sort((a, b) => b.daysLate - a.daysLate || a.expectedReceipt.localeCompare(b.expectedReceipt))
  const unreconciled = all
    .filter((c) => COLLAPSED_STATES.includes(c.state))
    .sort((a, b) => b.daysLate - a.daysLate)

  return { containers, unreconciled, undated, asOf }
}

// The court-strip number. ONLY `late` counts, and it is NEVER summed with the
// unreconciled bucket — those are open lines from containers that most likely
// already landed, and folding them in would open the chip at a number Nima
// cannot clear, which is exactly the burying the strip exists to undo.
export function lateContainers(containers = []) {
  return containers.filter((c) => c.state === 'late')
}

// One line of plain English per container, so the surface never has to explain
// a state code and the chip's tooltip and the card can't drift apart.
export function containerHeadline(c) {
  const units = `${c.unitsOpen.toLocaleString()} unit${c.unitsOpen === 1 ? '' : 's'}`
  const pos = `${c.poCount} PO${c.poCount === 1 ? '' : 's'}`
  const d = (n) => `${n} day${n === 1 ? '' : 's'}`
  switch (c.state) {
    case 'late':
      return c.unitsReceived > 0
        ? `${pos}, ${units} still open — due ${d(c.daysLate)} ago, only ${c.unitsReceived.toLocaleString()} received so far`
        : `${pos}, ${units} — due ${d(c.daysLate)} ago and nothing received yet`
    case 'awaiting':
      return `${pos}, ${units} — expected in ${d(Math.abs(c.daysLate))}`
    case 'remnant':
      return `${pos}, ${units} left over from a container that already landed`
    default:
      return `${pos}, ${units} still open from a container due ${d(c.daysLate)} ago — probably landed and never closed out`
  }
}
