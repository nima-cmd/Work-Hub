// src/model/transferMeter.js — how much are we actually reading out of Neon?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// Neon's Free plan allows 5 GB/month of public network transfer and SUSPENDS the
// compute when it runs out. On 2026-08-14 we were at 84% on the 14th, and the first
// email was the first anyone knew. A quota you only learn about at 84% is not a
// budget, it is a surprise — so this measures continuously and projects forward.
//
// ⚠️ THIS IS AN ESTIMATE, AND A LOWER BOUND. It counts the bytes of ROWS we receive,
// which is not what Neon bills: their figure includes TLS, the wire protocol's own
// framing, column metadata on every result, and connection setup. Treat this as
// "which of our processes is heavy, and roughly how heavy" — never as the invoice.
// The authority is always the Neon console.
//
// The number that matters is not the total, it is the SOURCE split: the whole
// question on 2026-08-14 was whether the burn was the deployed app, the unattended
// cron, or development. A total cannot answer that, so nothing here reports one
// without it.

/** Neon Free plan, public network transfer. */
export const MONTHLY_LIMIT_BYTES = 5 * 1024 ** 3

export const GB = (n) => n / 1024 ** 3
export const fmtBytes = (n) => {
  if (n == null) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/**
 * Roll daily per-source rows into a month view with a projection.
 *
 * @param rows  [{ day: 'YYYY-MM-DD', source, bytes, queries }]
 * @param opts.today       'YYYY-MM-DD' — passed in, never read from the clock, so
 *                         this stays pure and testable.
 * @param opts.knownUsed   bytes Neon itself reports, if we have it. When present it
 *                         REPLACES our estimate as the baseline, because their number
 *                         is the one that suspends the database.
 */
export function summarizeTransfer(rows = [], opts = {}) {
  const { today, monthStart = null, limitBytes = MONTHLY_LIMIT_BYTES, knownUsed = null } = opts
  const start = monthStart || (today ? today.slice(0, 7) + '-01' : null)
  const inMonth = start ? rows.filter((r) => r.day >= start) : rows

  const bySource = new Map()
  let measured = 0, queries = 0
  for (const r of inMonth) {
    const b = Number(r.bytes || 0)
    measured += b
    queries += Number(r.queries || 0)
    const cur = bySource.get(r.source) || { source: r.source, bytes: 0, queries: 0, days: 0 }
    cur.bytes += b
    cur.queries += Number(r.queries || 0)
    cur.days++
    bySource.set(r.source, cur)
  }

  const dayNum = today ? Number(today.slice(8, 10)) : null
  const daysInMonth = today ? new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate() : null
  const used = knownUsed != null ? Number(knownUsed) : measured

  // Today on its own — the question actually asked ("how much have I used today").
  const todayRows = inMonth.filter((r) => r.day === today)
  const todayBytes = todayRows.reduce((n, r) => n + Number(r.bytes || 0), 0)
  const todayBySource = [...todayRows
    .reduce((m, r) => m.set(r.source, (m.get(r.source) || 0) + Number(r.bytes || 0)), new Map())
    .entries()].map(([source, bytes]) => ({ source, bytes })).sort((a, b) => b.bytes - a.bytes)

  // ⚠️ THE RATE MUST DIVIDE BY DAYS WE ACTUALLY MEASURED, not by the day of the month.
  // The meter started mid-month on 2026-08-14. Dividing that day's 191 MB by 14 gave
  // "13.0 MB/day · runway 378 days" — a reassuring number, and wrong by more than an
  // order of magnitude: the honest reading of the same data is ~191 MB/day and about
  // 4 days of runway. A monitor that understates is worse than none, because it is
  // believed precisely when it should not be.
  const measuredDays = new Set(inMonth.map((r) => r.day)).size
  const perDay = measuredDays ? used / measuredDays : null
  // Straight-line from the month so far. Deliberately not clever: a fancier model
  // would imply a confidence this data does not support.
  const projected = perDay != null && daysInMonth ? perDay * daysInMonth : null
  const remaining = Math.max(0, limitBytes - used)
  const daysLeftAtRate = perDay > 0 ? remaining / perDay : null

  return {
    used, measured, queries, limitBytes, remaining,
    today: { day: today, bytes: todayBytes, bySource: todayBySource },
    // How much of the month this figure actually covers, so nothing reads a
    // part-month sample as a whole-month fact.
    measuredDays, partialMonth: !!(dayNum && measuredDays < dayNum),
    knownUsed: knownUsed != null ? Number(knownUsed) : null,
    isEstimate: knownUsed == null,
    pctUsed: limitBytes ? (used / limitBytes) * 100 : null,
    perDay, projected,
    pctProjected: projected != null && limitBytes ? (projected / limitBytes) * 100 : null,
    daysLeftAtRate,
    dayOfMonth: dayNum, daysInMonth,
    bySource: [...bySource.values()].sort((a, b) => b.bytes - a.bytes),
    verdict: verdictFor({ used, projected, limitBytes, daysLeftAtRate, daysInMonth, dayNum }),
    // ⚠️ Never let a caller print this as the bill.
    caveat: 'Estimated from row bytes received — excludes TLS and wire-protocol overhead, '
      + 'and only counts processes that report. Neon\'s console is the authority.',
  }
}

/**
 * ⚠️ Keyed on whether we run OUT, not on how much we have used. 84% on the 14th and
 * 84% on the 30th are the same percentage and completely different situations — the
 * first suspends the database mid-month, the second lands fine. The projection is the
 * signal; the percentage is just context.
 */
export function verdictFor({ used, projected, limitBytes, daysLeftAtRate, daysInMonth, dayNum }) {
  if (used >= limitBytes) {
    return { level: 'exceeded', headline: 'Transfer exhausted — Neon suspends the compute until the next billing period.' }
  }
  const daysRemaining = daysInMonth && dayNum ? daysInMonth - dayNum : null
  if (daysLeftAtRate != null && daysRemaining != null && daysLeftAtRate < daysRemaining) {
    const d = Math.floor(daysLeftAtRate)
    return {
      level: 'critical',
      headline: `At this rate the allowance runs out in ~${d} day${d === 1 ? '' : 's'}, `
        + `with ${daysRemaining} left in the month. Neon SUSPENDS the compute — the deployed app stops.`,
    }
  }
  if (projected != null && limitBytes && projected > limitBytes * 0.8) {
    return { level: 'warn', headline: `On track for ${(GB(projected)).toFixed(1)} GB this month, against a 5 GB cap.` }
  }
  return { level: 'ok', headline: 'Comfortably inside the monthly transfer allowance.' }
}
