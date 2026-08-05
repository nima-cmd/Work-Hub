// src/model/shipWindow.js — when an order may ship, when it MUST, and how much
// of that runway is already gone.
//
// ── Why the sales order can't answer this on its own ─────────────────────────
//
// `orders.ship_date` is a NetSuite field somebody typed. For a boutique order
// that's the whole story. For an EDI order it is NOT the deadline — the deadline
// is the ship window the partner sent us on their own 850, and the two disagree.
// Measured 2026-08-02 across every open EDI order (79 SOs / 12 POs, all of which
// carry an 850): the SO ship date differs from the partner's cancel-after on
// **12 of 12**, and on 8 of them (71 of the 79 SOs) the SO date falls AFTER the
// cancel date — PO 50073677 by 12 days, PO 8040313 by 11.
//
// That is the dangerous direction. A future-dated SO produces no overdue flag,
// so the board reads calm while the order is already past the contractual
// window and earning a chargeback. So for EDI the binding date is `cancelAfter`
// (Nima, 2026-08-02: "we want to make sure we don't have any cancel dates
// missed… if we're in danger of missing a cancel date on a PO we'd want to
// prioritize it"). The SO date is still shown, and disagreeing with the partner
// raises its own flag, because that's a NetSuite data problem to go fix.
//
// ── Partners do not read their own start date the same way ───────────────────
//
// Nima, same conversation:
//
//   • **Bloomingdale's** — "start dates is in DC and we can work on those up to
//     a week in advance of the start dates". Their start date is DC ARRIVAL, so
//     work may legitimately begin `DC_HEADSTART_DAYS` before it.
//   • **Nordstrom** — "more rigid and tight with their dates so the start is the
//     start date". No headstart; the window opens when it says it opens.
//   • Everyone else defaults to rigid. Assuming a headstart we haven't been told
//     about is the error that ships early and gets refused at the door.
//
// Only the OPEN side moves. A headstart says when we may START, never that the
// cancel date is secretly earlier — shifting a deadline earlier by inference
// would invent urgency the partner never asked for.
//
// ── Packing takes a day or two ───────────────────────────────────────────────
//
// Nima: "it could take a day or two to pack these orders". So the last honest
// moment to START is the deadline minus PACK_LEAD_DAYS, and inside that runway
// there is no slack left — which is exactly the ≤2-day caution tier he picked.
// The two numbers coincide on purpose: the caution tier IS the pack lead.

import { STAGE } from './stages.js'

export const PACK_LEAD_DAYS = 2
export const DC_HEADSTART_DAYS = 7
export const WATCH_DAYS = 7

const DAY = 86400000

// Bloomingdale's is the only partner whose start date we may front-run, and
// only because it names DC arrival rather than departure.
const HEADSTART = { bloomingdales: DC_HEADSTART_DAYS }

// ── The routing deadline (Nima, 2026-08-04) ──────────────────────────────────
//
// The question this settles had been open for thirteen sessions: is
// Bloomingdale's CANCEL date also a DC-arrival date? It is not.
//
//   "Bloomingdales cancel date is cancel date, the start date is arrival in DC
//    date. So the start date is the date that they want in their possesion, we
//    can route up to a week in advance. Anytime we route a bloomingdales its 3
//    business days before we can route it. So if a PO has a cancel date of
//    August 7 we need to have routed it by August 4."
//
// So the cancel date stands as the cancel date — but a SECOND, EARLIER deadline
// exists that the board never modelled: the routing request. Routing must be in
// 3 BUSINESS days ahead of the cancel date.
//
// ⚠️ BUSINESS days, and the distinction is the whole point. Nima's own example
// spans no weekend (Fri cancel → Tue deadline, which calendar math also gets
// right), so a naive `-3 days` looks correct on it and then quietly fails the
// moment a weekend intervenes: a MONDAY cancel is due Wednesday, where calendar
// math says Friday. That is two days of false comfort on a chargeback clock.
//
// ⚠️ Only Bloomingdale's, because only Bloomingdale's has been specified. The
// module's existing rule for headstarts applies in mirror image here: inventing a
// lead time we were not told about would fabricate urgency, exactly as assuming a
// headstart would ship early. Other partners get 0 until Nima says otherwise.
export const ROUTING_LEAD_BUSINESS_DAYS = { bloomingdales: 3 }

export function routingLeadDays(order) {
  return ROUTING_LEAD_BUSINESS_DAYS[partnerKey(order)] || 0
}

// Walk back n business days, skipping Saturday and Sunday. Holidays are NOT
// modelled — we hold no holiday calendar, and inventing one would move a real
// deadline on a guess. The error direction is therefore a deadline that reads one
// day later than the partner's own cut-off across a holiday week, which is a
// known gap rather than a silent one.
export function minusBusinessDays(t, n) {
  if (t == null) return null
  let d = t, left = n
  while (left > 0) {
    d -= DAY
    const w = new Date(d).getDay()
    if (w !== 0 && w !== 6) left--
  }
  return d
}

// Matches src/model/channels.js's keys without importing its presentation
// concerns — this module is a rule table, not a palette.
export function partnerKey({ location, customer } = {}) {
  const s = `${location || ''} ${customer || ''}`
  if (/nordstrom/i.test(s)) return 'nordstrom'
  if (/bloomingdale/i.test(s)) return 'bloomingdales'
  if (/shopbop/i.test(s)) return 'shopbop'
  return 'other'
}

export function headstartDays(order) {
  return HEADSTART[partnerKey(order)] || 0
}

// Parse a date-ish value to a day-precision timestamp. Takes the 'YYYY-MM-DD'
// prefix so a UTC-midnight DATE isn't dragged back a day by a US timezone —
// the same trap fmtShortDate guards in the client.
export function toDay(v) {
  if (!v) return null
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : String(v)
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const d = new Date(v)
  if (isNaN(d)) return null
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const addDays = (t, n) => (t == null ? null : t + n * DAY)
const daysTo = (from, to) => (from == null || to == null ? null : Math.round((to - from) / DAY))
export const isoDay = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 10))

/**
 * The order's ship window.
 *
 * @param order  { customer, location, shipDate, ediWindow? }
 *               ediWindow = { shipNotBefore, cancelAfter } off the newest 850.
 * @param today  Date
 *
 * Returns null only when there is no honest date anywhere — never a guessed
 * one. A missing window must leave the board silent, not invent a deadline.
 */
export function shipWindow(order, today = new Date()) {
  const now = toDay(today)
  const edi = order?.ediWindow || null
  const snb = toDay(edi?.shipNotBefore)
  const cancel = toDay(edi?.cancelAfter)
  const soShip = toDay(order?.shipDate)

  // The binding date: the partner's cancel-after when they sent one, else the
  // sales order's own ship date.
  const mustShipBy = cancel ?? soShip
  if (mustShipBy == null && snb == null) return null

  const headstart = headstartDays(order)
  const opens = snb == null ? null : addDays(snb, -headstart)

  // The routing request has to be in before the shipment does. Computed off the
  // partner's own cancel date only — never off the sales order's date, which for
  // EDI disagrees with the partner on 12 of 12 open POs and usually reads LATER,
  // so deriving a routing deadline from it would push the deadline out rather
  // than pull it in. No cancelAfter → no routing deadline, not a guessed one.
  const routeLead = routingLeadDays(order)
  const routeBy = routeLead && cancel != null ? minusBusinessDays(cancel, routeLead) : null

  // Already gone → the deadline is moot. Worth stating rather than assuming:
  // the OVERDUE flag this module replaced did NOT check, so a shipped order
  // whose ship date was months back read "53d overdue" forever (SO11975 and 30
  // others on 2026-08-02). A window that has been met is not a window missed.
  const shipped = order?.stage === STAGE.SHIPPED ||
    (order?.fulfillments || []).some((f) => f.actualShipDate)

  return {
    shipped,
    source: cancel != null ? 'edi' : 'so',   // which document set the deadline
    partner: partnerKey(order),
    headstartDays: headstart,
    opens,                                    // earliest we may start work
    shipNotBefore: snb,                       // the partner's stated start date
    mustShipBy,
    startBy: addDays(mustShipBy, -PACK_LEAD_DAYS),
    soShipDate: soShip,
    // The routing request's own, earlier deadline. null for every partner but
    // Bloomingdale's, and null with no partner cancel date to count back from.
    routingLeadDays: routeLead,
    routeBy,
    daysToRoute: daysTo(now, routeBy),        // negative = already late to route
    daysToShip: daysTo(now, mustShipBy),      // negative = the date has passed
    daysToOpen: daysTo(now, opens),
    notOpenYet: opens != null && opens > now,
    // The SO promising a date the partner already cancels on. EDI-only: with no
    // 850 there are not two dates to disagree.
    soPastCancel: cancel != null && soShip != null && soShip > cancel,
  }
}

// Flags for computeFlags to append. Kept here so the rule and its rationale
// live together, and so the CLI analyzer (no DB, so no ediWindow) degrades to
// the plain sales-order date instead of losing the flags entirely.
export function shipWindowFlags(order, today = new Date()) {
  const w = shipWindow(order, today)
  if (!w || w.shipped) return []
  const flags = []
  const d = w.daysToShip
  const by = isoDay(w.mustShipBy)
  const edi = w.source === 'edi'

  if (d != null) {
    if (d < 0) {
      flags.push({
        key: 'OVERDUE',
        label: edi ? `Cancel date passed ${-d}d ago` : `Ship date ${-d}d overdue`,
        severity: 3,
      })
    } else if (d === 0) {
      flags.push({
        key: 'DUE_TODAY',
        label: edi ? 'Cancels today — ship it' : 'Ship date is today',
        severity: 2,
      })
    } else if (d <= PACK_LEAD_DAYS) {
      // Inside the pack lead there is no slack left, so this reads as an
      // instruction rather than a date.
      flags.push({
        key: 'PACK_NOW',
        label: `${edi ? 'Cancels' : 'Ships'} in ${d}d (${by}) — pack now`,
        severity: 2,
      })
    } else if (d <= WATCH_DAYS) {
      flags.push({
        key: 'DUE_SOON',
        label: `${edi ? 'Cancels' : 'Ships'} in ${d}d (${by})`,
        severity: 1,
      })
    }
  }

  // Severity 0: not a problem, but the reason NOT to pull this card forward.
  // Bloomingdale's goes quiet a week earlier than Nordstrom by design.
  if (w.notOpenYet) {
    flags.push({
      key: 'WINDOW_NOT_OPEN',
      label: `Window opens ${isoDay(w.opens)}${w.headstartDays ? ` (${w.headstartDays}d DC headstart)` : ''}`,
      severity: 0,
    })
  }

  if (w.soPastCancel) {
    flags.push({
      key: 'SO_PAST_CANCEL',
      label: `SO ship date ${isoDay(w.soShipDate)} is after the partner's ${by} cancel — fix in NetSuite`,
      severity: 2,
    })
  }

  return flags
}
