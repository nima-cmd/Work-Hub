// src/model/calendarAgenda.js — WHAT IS COMING, and what already happened.
//
// Nima, 2026-08-21, on the Calendar as it stood:
//
//   "the dots mean nothing to me really and not working and i was hoping for the
//    calendar to give me more of a view of what is upcoming in terms of work that we
//    need to do. right now the view is just a calendar with dots and a date."
//
// He is right, and the reason is not the design. ⚠️ THE OLD CALENDAR PLOTTED A
// FABRICATED DATE. It keyed its two deadline dots on `orders.ship_date` and
// `orders.cancel_date`, and measured on live data: cancel_date is NULL on all 121
// unshipped orders, and ALL 121 ship_dates are the NetSuite `trandate + 28` default —
// zero genuinely set. So 81 orders showed a future "Ship due" that was their creation
// date plus four weeks. PR #94 stopped the pipeline flags trusting that field; the
// calendar never got the message. See fieldAssumptions.js.
//
// So this file rebuilds the agenda on signals that are actually populated, and each one
// says which column it came from. Measured 2026-08-21:
//
//   orders.window_end          43 (38 ahead)   NetSuite's real `enddate`, PR #118
//   orders.window_start        34
//   edi_transactions.cancel_after  331 (20 ahead)  the partner's own 850 cancel-after
//   purchase_orders.expected_receipt  1,436 lines over only 6 distinct future DATES
//   quest_tasks.due_at         0 of 11 open     ⚠️ empty today, and that is not a bug
//
// ── ONE ENTRY IS A DAY'S WORK OF ONE KIND, NOT ONE ROW ──────────────────────
//
// He asked for "the number of boutiques about to close" rather than a list, because
// boutique windows overlap and 23 of them close on one day. So entries GROUP: per day,
// per kind, per channel or partner. 1,436 PO lines become six container arrivals. The
// items are carried along so a click can open any of them as a data packet — which he
// called "the most important version of any bit of information".

const DAY = 86_400_000

/** The kinds of dated work. Each is a different question and a different person. */
export const AGENDA = {
  WINDOW_CLOSE: 'window_close',
  WINDOW_OPEN: 'window_open',
  EDI_CANCEL: 'edi_cancel',
  EDI_NOT_BEFORE: 'edi_not_before',
  CONTAINER_ARRIVAL: 'container_arrival',
  TASK_DUE: 'task_due',
}

export const AGENDA_META = {
  [AGENDA.WINDOW_CLOSE]: { label: 'ship window closes', tone: 'mid', urgent: true },
  [AGENDA.WINDOW_OPEN]: { label: 'ship window opens', tone: 'arrive', urgent: false },
  [AGENDA.EDI_CANCEL]: { label: 'partner cancel-after', tone: 'edi', urgent: true },
  [AGENDA.EDI_NOT_BEFORE]: { label: 'partner ship-not-before', tone: 'edi', urgent: false },
  [AGENDA.CONTAINER_ARRIVAL]: { label: 'container due in', tone: 'money', urgent: false },
  [AGENDA.TASK_DUE]: { label: 'task due', tone: 'go', urgent: true },
}

/** YYYY-MM-DD in UTC. ⚠️ Not local — a Postgres DATE arrives as UTC midnight, and
 *  comparing it against a local day is what made a fulfilment created today read as a
 *  day old elsewhere in this repo (see pipeline.js daysSinceDate). */
export const isoDay = (d) => {
  if (!d) return null
  const t = new Date(d)
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10)
}

const dayDiff = (fromIso, toIso) =>
  Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / DAY)

const shipped = (s) => /shipped/i.test(String(s || ''))

// ── Building the agenda ─────────────────────────────────────────────────────

/**
 * @param orders        /api/orders rows (need windowEnd, windowStart, source, stage)
 * @param ediCancels    [{ day, partner, count, businessNumbers }] pre-grouped in SQL
 * @param ediNotBefore  same shape
 * @param arrivals      [{ day, pos, lines, units }] pre-grouped in SQL
 * @param tasks         open tasks carrying dueAt
 * @param today         injectable
 *
 * Grouping happens in SQL for the two feeds that are naturally per-row-per-day (EDI
 * and PO lines) because they are large; orders are already in memory, so they group
 * here. Both routes produce the same entry shape.
 */
export function buildAgenda({
  orders = [], ediCancels = [], ediNotBefore = [], arrivals = [], tasks = [], today = new Date(),
} = {}) {
  const todayIso = isoDay(today)
  const out = []

  // ── Ship windows, grouped per day per CHANNEL ────────────────────────────
  // "in the case of boutiques there overlapping one and they exist in the warehouse so
  // we can have the number of boutiques about to close" — so one entry per day per
  // channel carrying its count, not 23 rows.
  const windowBuckets = new Map()
  for (const o of orders) {
    if (shipped(o.stage)) continue
    for (const [field, kind] of [['windowEnd', AGENDA.WINDOW_CLOSE], ['windowStart', AGENDA.WINDOW_OPEN]]) {
      const day = isoDay(o[field])
      if (!day) continue
      const channel = o.source || 'other'
      const key = `${day}|${kind}|${channel}`
      if (!windowBuckets.has(key)) windowBuckets.set(key, { day, kind, channel, items: [] })
      windowBuckets.get(key).items.push(o)
    }
  }
  for (const b of windowBuckets.values()) {
    out.push(entry({
      day: b.day, kind: b.kind, group: b.channel, count: b.items.length,
      headline: `${b.items.length} ${b.channel}`,
      items: b.items.map((o) => ({ docType: 'SO', docNumber: o.soNumber, label: o.customer })),
      todayIso,
    }))
  }

  // ── The partner's own dates, off their 850 ───────────────────────────────
  // ⚠️ NOT orders.cancel_date, which is null on every unshipped order. The cancel-after
  // that matters is the one the partner sent, and it lives on the EDI transaction.
  for (const [feed, kind] of [[ediCancels, AGENDA.EDI_CANCEL], [ediNotBefore, AGENDA.EDI_NOT_BEFORE]]) {
    for (const r of feed) {
      const day = isoDay(r.day)
      if (!day) continue
      out.push(entry({
        day, kind, group: r.partner || 'EDI', count: Number(r.count) || 0,
        // A deadline on a PO nobody has entered yet is a different job from one already
        // in NetSuite, and saying so is the difference between a date and a task.
        headline: `${r.count} ${shortPartner(r.partner)}${r.needsEntering ? ' — not entered yet' : ''}`,
        items: (r.businessNumbers || []).map((n) => ({ docType: 'THEIR_PO', docNumber: n, label: r.partner })),
        needsEntering: !!r.needsEntering,
        todayIso,
      }))
    }
  }

  // ── Containers ───────────────────────────────────────────────────────────
  // A container IS the POs sharing a due date (ocPoContainers.js). 1,436 open PO lines
  // collapse to six dates, which is what makes this legible at all.
  for (const r of arrivals) {
    const day = isoDay(r.day)
    if (!day) continue
    const pos = Number(r.pos) || 0
    out.push(entry({
      day, kind: AGENDA.CONTAINER_ARRIVAL, group: 'inbound', count: pos,
      headline: `${pos} PO${pos === 1 ? '' : 's'} · ${Math.round(Number(r.units) || 0)} units`,
      items: (r.poNumbers || []).map((n) => ({ docType: 'PO', docNumber: n, label: 'purchase order' })),
      todayIso,
    }))
  }

  // ── Tasks with a due date ────────────────────────────────────────────────
  // ⚠️ ZERO of 11 open tasks carry one today. The lane exists so a due date shows up
  // the day it is set; an empty lane here is a fact about the data, not a gap in this
  // model, and the view must not present it as a loading state.
  const taskBuckets = new Map()
  for (const t of tasks) {
    const day = isoDay(t.dueAt || t.due_at)
    if (!day || t.status === 'done') continue
    if (!taskBuckets.has(day)) taskBuckets.set(day, [])
    taskBuckets.get(day).push(t)
  }
  for (const [day, items] of taskBuckets) {
    out.push(entry({
      day, kind: AGENDA.TASK_DUE, group: 'desk', count: items.length,
      headline: items.length === 1 ? items[0].subject : `${items.length} tasks`,
      items: items.map((t) => ({ docType: 'TASK', docNumber: String(t.id), label: t.subject })),
      todayIso,
    }))
  }

  // Soonest first, and within a day the urgent kinds lead.
  out.sort((a, b) => a.day.localeCompare(b.day)
    || Number(b.urgent) - Number(a.urgent)
    || b.count - a.count)
  return out
}

function entry({ day, kind, group, count, headline, items, todayIso, needsEntering = false }) {
  const meta = AGENDA_META[kind] || {}
  const inDays = dayDiff(todayIso, day)
  return {
    id: `${day}|${kind}|${group}`,
    day, kind, group, count, headline, items, needsEntering,
    label: meta.label,
    tone: meta.tone || 'muted',
    urgent: !!meta.urgent,
    inDays,
    // `overdue` only means something for a kind that is a DEADLINE. A container that
    // arrived last week is history, not a failure, and a window that opened is not late.
    overdue: !!meta.urgent && inDays < 0,
    today: inDays === 0,
  }
}

const shortPartner = (p) => String(p || 'EDI').replace(/\s*\(.*\)\s*$/, '').trim() || 'EDI'

/**
 * Two tabs, his structure: "two tabbed version perhaps one looking forward one to
 * review the past". Today belongs to FORWARD — it is still actionable.
 *
 * ⚠️ An OVERDUE deadline stays in forward however old it is. A cancel-after that
 * passed is not history; it is the most urgent thing on the board, and filing it under
 * "review the past" is how it stops being chased.
 */
export function splitAgenda(entries = []) {
  const forward = []
  const past = []
  for (const e of entries) {
    if (e.inDays >= 0 || e.overdue) forward.push(e)
    else past.push(e)
  }
  past.reverse()          // most recent first when looking back
  return { forward, past }
}

/** Entries indexed by day, for a grid to read. */
export function byDay(entries = []) {
  const m = new Map()
  for (const e of entries) {
    if (!m.has(e.day)) m.set(e.day, [])
    m.get(e.day).push(e)
  }
  return m
}

/** A week's worth of ISO days starting Monday. */
export function weekDays(anchor = new Date()) {
  const d = new Date(`${isoDay(anchor)}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7          // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow)
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d)
    x.setUTCDate(x.getUTCDate() + i)
    return isoDay(x)
  })
}

/** The calendar-grid days for a month, padded to whole Monday-start weeks. */
export function monthDays(anchor = new Date()) {
  const a = new Date(`${isoDay(anchor)}T00:00:00Z`)
  const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1))
  const last = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0))
  const start = weekDays(first)[0]
  const days = []
  const cur = new Date(`${start}T00:00:00Z`)
  const endIso = weekDays(last)[6]
  for (;;) {
    const iso = isoDay(cur)
    days.push(iso)
    if (iso === endIso) break
    cur.setUTCDate(cur.getUTCDate() + 1)
    if (days.length > 45) break        // belt and braces; a month is never 6+ weeks
  }
  return days
}

/** Totals a header can show without lying about what it counted. */
export function agendaSummary(entries = []) {
  const s = { entries: entries.length, overdue: 0, today: 0, next7: 0, byKind: {} }
  for (const e of entries) {
    if (e.overdue) s.overdue++
    if (e.today) s.today++
    if (e.inDays >= 0 && e.inDays <= 7) s.next7++
    s.byKind[e.kind] = (s.byKind[e.kind] || 0) + 1
  }
  return s
}
