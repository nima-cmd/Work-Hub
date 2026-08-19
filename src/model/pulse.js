// src/model/pulse.js — "has anything changed?", cheaply.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// Nima, 2026-08-19: *"the information doesn't refresh unless we manual refresh the
// page … Whitworth getting scanned needed me to refresh to show it as in our
// possession and needing a label or routing."*
//
// He is right, and right about the reason too: this is our own Postgres, not a metered
// third-party API, so there is no budget excuse for a board that goes stale.
//
// ⚠️ BUT POLLING THE BOARD ITSELF IS NOT THE ANSWER. `App.jsx`'s refresh() fires 16
// requests; 7 of them measured 1.24 MB, so a full pass is ~1.5 MB and ~400 database
// queries. At 30s that is ~48,000 queries an hour FROM ONE OPEN TAB — which would
// roughly double the deploy's entire daily load, on a one-vCPU box. Free transfer is
// not free CPU.
//
// So the client polls this instead: a handful of MAX() lookups that answer one
// question in a few hundred bytes. The expensive refresh happens only when the answer
// changes — which is what "live" actually requires.
//
// The signals are chosen to cover the things a human does and then looks for:
//   order_events      every scan, departure confirmation, filing, custody change
//   orders            a NetSuite sync landing new or changed orders
//   fulfillments      a fulfilment marked packed/shipped
//   quest_task_activity  tasks opened, done, escalated
//
// ⚠️ NOT a count. A count is unchanged when a row is UPDATED in place, and "marked
// packed" is an update — the exact case Nima described. MAX(updated_at) moves; a count
// does not. (Same trap as CLAUDE.md's counter shapes: measuring something adjacent to
// the question instead of the question.)

/** The cheap change signals, as [label, SQL] — each one a single index lookup. */
export const PULSE_SOURCES = [
  ['events', 'SELECT MAX(id)::text AS v FROM order_events'],
  ['orders', 'SELECT MAX(updated_at)::text AS v FROM orders'],
  ['fulfillments', 'SELECT MAX(updated_at)::text AS v FROM fulfillments'],
  ['activity', 'SELECT MAX(id)::text AS v FROM quest_task_activity'],
]

/**
 * One opaque string from the parts. The client compares it for INEQUALITY only and
 * never parses it, so the format is free to change.
 *
 * ⚠️ A missing part becomes '-' rather than being dropped, so a table that goes empty
 * still changes the version instead of silently colliding with a previous one.
 */
export function pulseVersion(parts = {}) {
  return PULSE_SOURCES.map(([k]) => (parts[k] == null || parts[k] === '' ? '-' : String(parts[k]))).join('|')
}

/** Has it moved? Unknown-to-known is NOT a change — that is the first load. */
export function pulseChanged(previous, next) {
  if (previous == null) return false
  return previous !== next
}

/**
 * How often to ask, in ms.
 *
 * ⚠️ Paused when the tab is hidden — an unattended dashboard on a second monitor
 * should cost nothing. Verified against `document.visibilityState` in the hook.
 */
export const PULSE_INTERVAL_MS = 15_000
