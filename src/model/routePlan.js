// src/model/routePlan.js — the "hyperspace route" planner (Nima, 2026-07-21).
// Orders a set of work items into an optimal single-operator sequence for the
// day and projects when each one runs, flagging any that can't make its cutoff.
//
// Method: earliest-deadline-first (EDF). On a single machine EDF is provably
// optimal for MINIMIZING MAXIMUM LATENESS — i.e. it gives every deadline the
// best possible shot, which is exactly "arrive at our destination on time."
// Ties (same deadline, or both deadline-free) break by priority, then by the
// shorter job first so quick wins don't sit behind a long one.
//
// Deadlines/durations are supplied by the caller (see the deadline rules that
// map Naghedi work → items). Durations start as per-type defaults and are meant
// to be refined from measured actuals over time (feeds player-card stats too).

export const DEFAULT_DURATIONS_MIN = {
  edi_route: 10,        // send an EDI 856/routing
  invoice: 8,           // generate an invoice
  pack: 20,             // pick/pack a fulfillment
  weaver_sync: 15,      // Weaver → NetSuite push
  csv_upload: 10,       // saved-search CSV refresh
  email_reply: 5,       // reply / acknowledge
  planning: 30,         // PO/OC / container planning
  ship: 12,             // generate label + hand off
  // The bench work behind a PICKED order, plus the label that opens the ship
  // sequence (added 2026-08-04 with the day-plan leg split — see routeItems.js).
  // These are deliberately SHORT: none of them is physical packing.
  label: 6,             // make a carrier label for a packed IF
  chase: 5,             // call/email the warehouse about an IF it's holding
  mark_packed: 3,       // flip a returned IF to Packed in NetSuite — a keystroke
  handoff: 6,           // print the custody label and scan it OUT
  close_out: 4,         // decide-and-close a PO whose window died long ago
  default: 10,
}

const MIN = 60000

// items: [{ id, label, kind, deadline (ms epoch | null), durationMin (number),
//           priority (0 = highest) }]
// opts:  { now (ms), dayStartHour = 9, dayEndHour = 17,
//          preserveOrder = false }
//
// preserveOrder: when the plan is in MANUAL mode (the operator reordered it by
// hand), we keep the given order and only project clock times + at-risk onto
// it, instead of re-sorting by EDF. Times/slack/at-risk are still computed the
// same way, so a hand-sequenced plan honestly shows the cutoffs it now misses.
export function computeRoute(items = [], opts = {}) {
  const now = opts.now ?? Date.now()
  const dayStartHour = opts.dayStartHour ?? 9
  // start no earlier than the workday start today, never in the past
  const dayStart = new Date(now); dayStart.setHours(dayStartHour, 0, 0, 0)
  const startFloor = Math.max(now, dayStart.getTime())

  const ordered = opts.preserveOrder
    ? [...items]
    : [...items].sort((a, b) => {
        const da = a.deadline ?? Infinity, db = b.deadline ?? Infinity
        if (da !== db) return da - db
        const pa = a.priority ?? 5, pb = b.priority ?? 5
        if (pa !== pb) return pa - pb
        return (a.durationMin ?? 10) - (b.durationMin ?? 10)
      })

  let cursor = startFloor
  let maxLatenessMin = 0
  const route = ordered.map((it, i) => {
    const dur = (it.durationMin ?? 10) * MIN
    const start = cursor
    const end = start + dur
    cursor = end
    const deadline = it.deadline ?? null
    const slackMin = deadline != null ? Math.round((deadline - end) / MIN) : null
    const atRisk = deadline != null && end > deadline
    if (atRisk) maxLatenessMin = Math.max(maxLatenessMin, Math.round((end - deadline) / MIN))
    return { ...it, seq: i + 1, start, end, slackMin, atRisk }
  })

  return {
    route,
    summary: {
      count: route.length,
      atRisk: route.filter((r) => r.atRisk).length,
      finishesAt: route.length ? route[route.length - 1].end : startFloor,
      totalMin: route.reduce((n, r) => n + (r.durationMin ?? 10), 0),
      maxLatenessMin,
    },
  }
}
