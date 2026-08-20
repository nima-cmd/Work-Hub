// src/model/viewUsage.js — WHICH VIEWS DOES NIMA ACTUALLY USE?
//
// Nima, 2026-08-20:
//
//   "We are noticing there too many view many of which aren't even used. Putting
//    together things is optimal. … can we track how much we use certain view and
//    record it somewhere for our own knowledge to give you a better idea of what is
//    and what isn't being used"
//
// Twenty views exist. He named five he actually looks at. Rather than consolidate on
// a guess about the other fifteen, this measures it — the same instinct as the rest of
// the repo: a number beats an opinion, and "I think you don't use Calendar" is exactly
// the kind of claim that turns out to be wrong about the one view someone opens every
// Friday.
//
// ── TWO NUMBERS, BECAUSE ONE OF THEM LIES ───────────────────────────────────
//
// OPENS alone is not usage. Two ways it misleads, both real here:
//
//   1. THE DEFAULT VIEW IS OPENED BY EVERY PAGE LOAD, by nobody's decision. Command
//      is the landing view, so its open count includes every refresh, every restart,
//      every time the dev server reloaded. Counting that as "he chose Command" is
//      precisely the counter-bug shape this repo keeps paying for — a number that
//      answers a different question from the one on the screen. So the default is
//      flagged and its opens are reported as NOT COMPARABLE, never quietly ranked
//      alongside the rest.
//   2. A view opened and left in two seconds is a misclick, not a habit.
//
// So DWELL (time visible) is tracked alongside, and the verdict below reads dwell as
// the primary signal with opens as support. A view with many opens and no dwell is
// somewhere he lands, not somewhere he works.
//
// ⚠️ WHERE THIS IS STORED IS A COMPROMISE, ON PURPOSE. It lives as one JSON row in
// `sync_meta` rather than in its own table, because `db/schema.sql` was being edited
// by another session's uncommitted Weaver work when this was written and `git add` on
// that file would have committed their work-in-progress inside this change. A real
// table (one row per view per day, so trends are visible) is the right home and this
// should move there once schema.sql is uncontested. What is lost meanwhile: per-day
// granularity. What is kept: totals, first seen, last seen — enough to answer the
// question he actually asked.

/** The sync_meta key the counters live under. */
export const USAGE_KEY = 'view_usage'

/** Below this, a visit is a misclick rather than a look. */
export const GLANCE_MS = 3000

/**
 * Fold the stored blob into a sorted, labelled report.
 *
 * @param usage  { [viewKey]: { opens, dwellMs, firstAt, lastAt } }
 * @param views  [{ key, label }] — the app's own view list, so a view that exists but
 *               has never been opened still appears. A report that only lists what was
 *               used cannot answer "what is unused", which is the question.
 * @param defaultView  the view every page load lands on
 */
export function usageReport(usage = {}, views = [], { defaultView = null, now = Date.now() } = {}) {
  const rows = views.map((v) => {
    const u = usage[v.key] || {}
    const opens = Number(u.opens) || 0
    const dwellMs = Number(u.dwellMs) || 0
    const isDefault = v.key === defaultView
    return {
      key: v.key,
      label: v.label || v.key,
      opens,
      dwellMs,
      // Average time per visit — what separates "somewhere he works" from
      // "somewhere he lands". Null rather than 0 when never opened, so the UI can
      // say "never" instead of printing a real-looking zero.
      avgMs: opens ? Math.round(dwellMs / opens) : null,
      firstAt: u.firstAt || null,
      lastAt: u.lastAt || null,
      daysSince: u.lastAt ? Math.floor((now - new Date(u.lastAt).getTime()) / 86400000) : null,
      isDefault,
      // ⚠️ The default view's opens count every page load, so they are NOT a measure
      // of choosing it. Flagged, never silently ranked against the others.
      opensComparable: !isDefault,
      verdict: verdictFor({ opens, dwellMs, isDefault }),
    }
  })
  // Dwell descending — the honest ranking. Ties fall back to opens, then name, so the
  // order is stable across renders rather than whatever the object happened to hold.
  rows.sort((a, b) => b.dwellMs - a.dwellMs || b.opens - a.opens || a.label.localeCompare(b.label))
  return {
    rows,
    totals: {
      views: rows.length,
      neverOpened: rows.filter((r) => !r.opens).length,
      glanceOnly: rows.filter((r) => r.verdict === 'glanced').length,
      trackedSince: rows.reduce((min, r) => (r.firstAt && (!min || r.firstAt < min) ? r.firstAt : min), null),
    },
  }
}

/**
 * What this row says about the view. Deliberately coarse: with a handful of days of
 * data, anything finer than these four would be reading noise.
 *
 * ⚠️ 'unused' is a claim about the DATA, not about the view's worth — a view added
 * yesterday is unused and fine. The UI must show `trackedSince` next to it, or this
 * word will retire something that never had a chance to be opened.
 */
export function verdictFor({ opens = 0, dwellMs = 0, isDefault = false } = {}) {
  if (isDefault) return 'default'
  if (!opens) return 'unused'
  if (dwellMs < GLANCE_MS) return 'glanced'
  return 'used'
}

export const VERDICT_LABEL = {
  used: 'used',
  glanced: 'opened, not read',
  unused: 'never opened',
  default: 'the landing view',
}

/**
 * Merge one visit into the blob. Pure, so the increment rule is testable — the SQL
 * does the same thing atomically (see recordViewVisit) and these two must agree.
 */
export function applyVisit(usage = {}, { view, dwellMs = 0, at = new Date().toISOString() } = {}) {
  if (!view) return usage
  const prev = usage[view] || {}
  return {
    ...usage,
    [view]: {
      opens: (Number(prev.opens) || 0) + 1,
      // Clamped at 0: a negative dwell means the clock moved (a sleep/wake, a clock
      // change), and adding it would silently subtract real time already recorded.
      dwellMs: (Number(prev.dwellMs) || 0) + Math.max(0, Number(dwellMs) || 0),
      firstAt: prev.firstAt || at,
      lastAt: at,
    },
  }
}

/** Human duration, for the Health panel. */
export function humanMs(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return '0s'
  const s = Math.round(n / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
