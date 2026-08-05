// src/model/routeItems.js — the adapter from live Naghedi data → route items,
// plus the merge of a day's persisted overrides onto the computed plan.
//
// This was born inside FlightDeck.jsx as a local helper for the ephemeral
// "◈ PLAN" HUD. Promoted here (Nima, 2026-07-28) so the Daily Flight Plan view
// and the Flight Deck cockpit share ONE definition of "what's on today's plan,"
// and so it's unit-testable without React.
//
// Feeders (per Nima 2026-07-28, plus the label feeder added 2026-08-04):
//   • tasks          — every open quest_task
//   • EDI actions    — routing that's due or past its cancel window
//   • shippable orders — orders sitting at "approved for shipping", plus the
//                        boutique bench work behind everything below it
//   • label gaps     — packed parcels with no carrier label (opts.labelGaps)
//
// Deadlines/durations: a task uses its real due_at / duration_min when set,
// else falls back to an urgency-derived deadline + a per-kind default duration.
// computeRoute (EDF) does the sequencing; this file only shapes the items.

import { DEFAULT_DURATIONS_MIN } from './routePlan.js'
import { STAGE } from './stages.js'

const dur = (k) => DEFAULT_DURATIONS_MIN[k] ?? DEFAULT_DURATIONS_MIN.default

// Classify a task into a work "kind" (drives its default duration + icon).
//
// This used to say "kept in sync with scripts/plan-route-demo.js", which was a
// hope rather than a mechanism — the demo kept its own copy of this function AND
// of the leg rules, and by 2026-08-04 it had silently diverged (still emitting the
// old "Invoice <customer>" leg for picked orders). The demo now imports
// buildRouteItems instead, so there is nothing left to keep in sync.
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

// ── The bench: what a PICKED order actually needs (2026-08-04) ───────────────
//
// This replaces ONE leg that was 14-for-14 wrong. Every boutique order below
// INVOICED with any severity used to queue as `Invoice <customer>`, and live all
// 14 of those legs were PICKED orders — nothing can be invoiced before it's
// packed, so not one of them was doable. Their real next actions were sitting in
// their own flags the whole time.
//
// Keyed off the FLAG, not the stage, because "picked" doesn't say whose court
// it's in: WAREHOUSE_HOLDS is the warehouse's (8 live), while BACK_NOT_PACKED is
// a NetSuite keystroke of ours (6 live). Lumping them under one verb is exactly
// the never-lump rule the court strip already follows.
//
// `courtTheirs` marks a leg we can't finish alone. Nima's call (2026-08-04):
// keep them on the plan, marked as theirs — chasing IS our action even when the
// packing isn't.
const PICKED_LEGS = {
  WAREHOUSE_HOLDS:    { kind: 'chase',       group: 'Chase the warehouse',  courtTheirs: true },
  PICK_STALLED:       { kind: 'chase',       group: 'Chase the warehouse',  courtTheirs: true },
  BACK_NOT_PACKED:    { kind: 'mark_packed', group: 'Mark packed' },
  NEEDS_HANDOFF_SCAN: { kind: 'handoff',     group: 'Hand off to warehouse' },
}

// Highest severity wins, so an order carrying two of these leads with the one
// that's actually urgent rather than whichever flag happened to be pushed first.
// Returns null when a picked order has no outstanding action of its own — an IF
// scanned out less than 3 days ago (WITH_WAREHOUSE, severity 0) is in flight, not
// late, and must not be queued as work.
export function pickedWorkLeg(o) {
  const f = (o?.flags || [])
    .filter((x) => PICKED_LEGS[x.key])
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))[0]
  if (!f) return null
  // The leg's sentence IS the flag's own label — ONE source, so a leg can never
  // describe work its flag doesn't. Same lesson as src/model/labelGap.js, one
  // surface over: three chip bugs in a row were a label and a count derived
  // separately and allowed to drift.
  return { ...PICKED_LEGS[f.key], label: f.label, severity: f.severity ?? 0 }
}

// Build every candidate route item from the live data. `now` is injectable for
// tests. ediWork is the output of computeEdiWork (may be null).
export function buildRouteItems(orders = [], tasks = [], ediWork = null, opts = {}) {
  const now = opts.now ?? Date.now()
  const at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.getTime() }
  const times = { NOON: at(12), THREE: at(15) }
  const items = []

  // Which orders are still waiting on a carrier label. Used to hold the invoice
  // leg back — see the PACKED branch below for why the sequence matters.
  const needsLabel = opts.labelGaps?.needsLabel || []
  const awaitingLabel = new Set(needsLabel.map((g) => g.soNumber).filter(Boolean))

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
    const short = (o.tradingPartner || '').replace(/\s*\(.*$/, '')
    let deadline = null, priority = 3
    // ⚠️ ORDER MATTERS, and it used to be wrong. The first test was
    // `partner.includes('nordstrom') && stageRank < 3` → a blanket noon cutoff,
    // which (a) measured 18-for-18 FALSE on 2026-08-04 — 14 of those POs had cancel
    // dates 380–534 days PAST and 4 cancelled 36–118 days out, none due today — and
    // (b) being tested FIRST, it SWALLOWED `cancelState === 'passed'`, so the 14
    // genuinely blown POs were handed a noon deadline at priority 1 instead of
    // priority 0. The same "answered the wrong question first" shape as the label
    // vs payment ordering (PR #49).
    //
    // Now the real deadline decides, and the partner cutoff only applies when it is
    // actually the operative one — Nordstrom's noon is a next-day-pickup cutoff, so
    // it binds the day before the cancel date, not every day forever.
    if (o.work.cancelState === 'passed') { deadline = now; priority = 0 }
    else if (o.work.routeState === 'passed') { deadline = now; priority = 0 }
    else if (o.work.routeState === 'soon') {
      // The partner's own cutoff instant when they have one (noon for Nordstrom),
      // else lean on the afternoon cutoff the rest of the board uses.
      deadline = o.work.routeBy ?? times.THREE
      priority = 1
    } else if (o.work.cancelState === 'soon') { deadline = times.THREE; priority = 1 }
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

  // ── labels: the FIRST step of the ship sequence ──
  // The day plan had never mentioned labels, even though the court strip calls
  // them "the quickest win on the board" and the board's oldest actionable item
  // lives there (IF7414, 6 days, $90,654 owed). `labelGaps` was already a prop on
  // the Flight Plan view and simply went unread.
  //
  // Only the parcel lane: `needsLabel` already excludes EDI freight, which moves
  // on a BOL and never carries a tracking number (src/model/labelGap.js).
  for (const g of needsLabel) {
    const aged = (g.ageDays ?? 0) >= 1
    items.push({
      id: 'label-' + g.ifNumber,
      label: `${g.ifNumber} · Label ${g.customer || ''}`.trim().slice(0, 60),
      group: 'Labels',
      kind: 'label',
      // Age is the honest urgency here — nothing downstream can start until the
      // label exists, so a day-old gap has already cost a day.
      deadline: aged ? times.THREE : null,
      durationMin: dur('label'),
      priority: aged ? 1 : 3,
      nav: 'ship',
    })
  }

  // ── FOB: in China, awaiting collection ──
  // Not a label and not a BOL. The China warehouse confirms the pickup and the NY
  // office holds the thread (Nima, 2026-08-04), so chasing that confirmation is
  // the only part of this lane anyone here touches — hence a `chase` leg in their
  // court, exactly like an IF the warehouse is sitting on.
  //
  // ⚠️ These rows were `needsLabel` until 2026-08-04, so the label feeder above
  // was queueing a 3pm cutoff on work that will never be done: IF7414 ($90,654,
  // the largest balance on the board) led that queue.
  for (const g of (opts.labelGaps?.fobPickup || [])) {
    items.push({
      id: 'fob-' + g.ifNumber,
      label: `${g.ifNumber} · Confirm China pickup · ${g.customer || ''}`.trim().slice(0, 60),
      group: 'FOB pickups',
      kind: 'chase',
      // No cutoff of ours to miss — the truck is theirs to send. Age is what
      // keeps it from being forgotten, and the strip's chip carries that.
      deadline: null,
      durationMin: dur('chase'),
      priority: 3,
      courtTheirs: true,
      nav: 'ship',
    })
  }

  // ── shippable orders + the boutique bench ──
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
    // The bench covers the PARCEL lane only. An EDI order below PACKED moves on
    // routing and a BOL and already has its own leg from the ediWork feeder above
    // — queueing the ~50 EDI fulfilments here too would bury the day.
    //
    // ⚠️ Tested on `source`, NOT on channelKey. The old leg asked
    // `channelKey(o) === 'boutique'`, and channels.js is a DISPLAY classifier
    // whose own header says as much ("source.js stays the thing the pipeline keys
    // off; this is purely for display"). Its finer buckets silently dropped real
    // parcel-lane wholesale: live, SO12344 (Saint Bernard) reads channel
    // 'saint-bernard' and was invisible to the day plan while carrying STALE +
    // BACK_NOT_PACKED at severity 3. `holt` and `china` fall the same way.
    if (o.source === 'edi') continue

    // Picked, not packed: whichever of its own flags names the outstanding action.
    if (o.stage === STAGE.PICKED) {
      const leg = pickedWorkLeg(o)
      if (leg) {
        items.push({
          id: 'bench-' + o.soNumber,
          label: `${o.soNumber} · ${leg.label}`.slice(0, 60),
          group: leg.group,
          kind: leg.kind,
          deadline: leg.severity >= 3 ? times.THREE : null,
          durationMin: dur(leg.kind),
          priority: leg.severity >= 3 ? 1 : 2,
          courtTheirs: !!leg.courtTheirs,
          nav: 'kanban',
        })
      }
      continue
    }

    // Packed with nothing to invoice. `stage === PACKED` IS "packed and holding no
    // invoice" as of PR #48 — the promotion to INVOICED derives from the order's
    // invoice number, so an invoiced order cannot sit here.
    //
    // NO severity gate. That gate is precisely why the 2 genuine rows were the
    // only ones missing: both are severity 0, which is what an order looks like
    // when invoicing is still ON TIME. Waiting for it to age before mentioning it
    // is how it ages.
    //
    // Held back while the same order still needs a LABEL. Nima's sequence is
    // label → invoice → ship decision, so naming the invoice first silences the
    // earlier step — the exact bug PR #49 fixed on the court strip, one surface
    // over. Live today this leg is EMPTY: both packed rows (IF7410, IF7411) carry
    // zero labels, so the label leg above owns them and this one honestly says
    // nothing rather than asking for step 2 before step 1.
    if (o.stage === STAGE.PACKED && !awaitingLabel.has(o.soNumber)) {
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
