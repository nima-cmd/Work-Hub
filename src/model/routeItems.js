// src/model/routeItems.js — the adapter from live Naghedi data → route items,
// plus the merge of a day's persisted overrides onto the computed plan.
//
// This was born inside FlightDeck.jsx as a local helper for the ephemeral
// "◈ PLAN" HUD. Promoted here (Nima, 2026-07-28) so the Daily Flight Plan view
// and the Flight Deck cockpit share ONE definition of "what's on today's plan,"
// and so it's unit-testable without React.
//
// Feeders (all three, per Nima 2026-07-28):
//   • tasks          — every open quest_task
//   • EDI actions    — routing that's due or past its cancel window
//   • shippable orders — orders sitting at "approved for shipping", plus the
//                        boutique invoices that were already here
//
// Deadlines/durations: a task uses its real due_at / duration_min when set,
// else falls back to an urgency-derived deadline + a per-kind default duration.
// computeRoute (EDF) does the sequencing; this file only shapes the items.

import { DEFAULT_DURATIONS_MIN } from './routePlan.js'
import { channelKey } from './channels.js'
import { STAGE } from './stages.js'

const dur = (k) => DEFAULT_DURATIONS_MIN[k] ?? DEFAULT_DURATIONS_MIN.default

// Classify a task into a work "kind" (drives its default duration + icon). Kept
// in sync with scripts/plan-route-demo.js.
export function taskKind(t) {
  const k = (t.recurringKey || '') + ' ' + (t.subject || '')
  if (/weaver/i.test(k)) return 'weaver_sync'
  if (/csv|upload/i.test(k)) return 'csv_upload'
  if (String(t.instanceKey || '').startsWith('edi:')) return 'edi_route'
  return 'email_reply'
}

// Urgency → a synthesized deadline when a task carries no real due_at. hi lands
// mid-afternoon (act today), mid/lo float (no hard cutoff). Times are relative
// to `now` so the plan re-anchors each day.
function urgencyDeadline(urgency, times) {
  if (urgency === 'hi') return times.THREE
  return null
}

const urgencyPriority = (u) => (u === 'hi' ? 0 : u === 'mid' ? 2 : 4)

// Build every candidate route item from the live data. `now` is injectable for
// tests. ediWork is the output of computeEdiWork (may be null).
export function buildRouteItems(orders = [], tasks = [], ediWork = null, opts = {}) {
  const now = opts.now ?? Date.now()
  const at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.getTime() }
  const times = { NOON: at(12), THREE: at(15) }
  const items = []

  // ── tasks ──
  for (const t of tasks.filter((t) => t.status === 'open')) {
    const kind = taskKind(t)
    // a real due_at wins; otherwise synthesize from urgency
    const deadline = t.dueAt ? new Date(t.dueAt).getTime() : urgencyDeadline(t.urgency, times)
    items.push({
      id: 'task-' + t.id, taskId: t.id, label: (t.subject || 'task').slice(0, 46), kind,
      deadline,
      durationMin: t.durationMin ?? dur(kind),
      priority: urgencyPriority(t.urgency),
      scheduled: t.dueAt != null,   // flags a hand-set due time vs a synthesized one
    })
  }

  // ── EDI routing actions ──
  for (const o of (ediWork?.orders || []).filter((o) => !o.work.closed)) {
    const partner = (o.tradingPartner || '').toLowerCase()
    const short = (o.tradingPartner || '').replace(/\s*\(.*$/, '')
    let deadline = null, priority = 3
    if (partner.includes('nordstrom') && o.stageRank < 3) { deadline = times.NOON; priority = 1 }
    else if (o.work.cancelState === 'passed') { deadline = now; priority = 0 }
    else if (o.work.cancelState === 'soon') { deadline = times.THREE; priority = 1 }
    else continue
    // lead with the PO so it's never lost to truncation (long partner names
    // like "Saks Fifth Avenue & Saks OFF 5th" would otherwise eat the number)
    items.push({
      id: 'edi-' + o.businessNumber,
      label: (o.businessNumber ? `PO ${o.businessNumber} · ${short} routing` : `${short} routing`).slice(0, 60),
      group: `${short} routing`,
      kind: 'edi_route', deadline, durationMin: dur('edi_route'), priority,
      nav: 'edi',
    })
  }

  // ── shippable orders + boutique invoices ──
  for (const o of orders) {
    // approved-for-shipping → a "ship it out" leg (deadline from its cancel
    // date if that's today, else lean on severity for the cutoff)
    if (o.stage === STAGE.APPROVED) {
      const cancelToday = o.cancelDate && sameDay(new Date(o.cancelDate), now)
      items.push({
        id: 'ship-' + o.soNumber, label: `${o.soNumber} · Ship ${o.customer || ''}`.slice(0, 60),
        group: 'Ship departures',
        kind: 'ship',
        deadline: cancelToday ? times.THREE : o.severity > 1 ? times.THREE : null,
        durationMin: dur('ship'), priority: o.severity > 1 ? 1 : 3,
        nav: 'ship',
      })
      continue
    }
    // boutique orders that still need an invoice (pre-existing behavior)
    const needsInvoice = o.stage && ![STAGE.SHIPPED, STAGE.INVOICED, STAGE.APPROVED].includes(o.stage)
    if (channelKey(o) === 'boutique' && needsInvoice && o.severity > 0) {
      items.push({
        id: 'inv-' + o.soNumber, label: `${o.soNumber} · Invoice ${o.customer}`.slice(0, 60),
        group: 'Boutique invoicing',
        kind: 'invoice', deadline: times.NOON, durationMin: dur('invoice'), priority: 2,
        nav: 'table',
      })
    }
  }
  return items
}

function sameDay(d, nowMs) {
  const n = new Date(nowMs)
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

// Merge a day's persisted overrides (day_plan_item rows) onto the freshly-built
// items, BEFORE they go through computeRoute. Returns { items, manualMode }.
//   • done: a task leg's done comes from quest_tasks.status (already reflected
//     by the task being filtered out when done — so here `done` only rides the
//     non-task legs from the plan rows). We still stamp it so the caller can
//     render a checked, struck-through row without dropping it from the day.
//   • manualMode: true if ANY row carries a sort_index. Then items are ordered
//     by that index (unknown items sink to the end, keeping their relative
//     order) and the caller passes preserveOrder:true to computeRoute.
export function applyDayPlan(items, planRows = []) {
  const byId = new Map(planRows.map((r) => [r.itemId, r]))
  const manualMode = planRows.some((r) => r.sortIndex != null)

  const merged = items.map((it) => {
    const row = byId.get(it.id)
    return { ...it, done: !!row?.done, sortIndex: row?.sortIndex ?? null }
  })

  if (manualMode) {
    merged.sort((a, b) => {
      const ai = a.sortIndex == null ? Infinity : a.sortIndex
      const bi = b.sortIndex == null ? Infinity : b.sortIndex
      return ai - bi
    })
  }
  return { items: merged, manualMode }
}
