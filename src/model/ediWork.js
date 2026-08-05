// src/model/ediWork.js — the work layer on top of computeEdiPipeline (Nima,
// 2026-07-18: "EDI is too basic to function as is"). For every EDI PO it
// answers the two questions that matter:
//   1. Is this OPEN (work left to do) or CLOSED (done)?
//   2. If open — what exactly is needed next?
// Plus the two failure modes that hurt:
//   • MISSED 850 — a PO arrived, days passed, and there's still no matching
//     NetSuite order and no manual resolution: nobody ever entered it.
//   • CANCEL DANGER — the 850's cancel-after date is passing/passed while the
//     order still isn't shipped: ship it or lose it (chargeback bait).
//
// `resolutions` is the manual override table (edi_po_resolutions): a human
// connecting a PO to NetSuite reality the saved searches can't see — a
// NetSuite ref while it stays open, or closing it out entirely (with a note).
// A resolution always wins over inference, and is always visibly flagged.

import { poVersionInfo } from './ediPoDiff.js'
import { routingDeadline, routingCutoffHour } from './shipWindow.js'

// The routing deadline for one EDI order, or null when the partner has no stated
// routing lead or sent no cancel date.
//
// `order.tradingPartner` is what names the partner here — partnerKey reads
// location+customer, and an EDI review order carries the partner instead.
export function routeByFor(order, cancelAfter) {
  return routingDeadline({ customer: order?.tradingPartner || '' }, cancelAfter)
}

// Does this partner's deadline carry a time of day (Nordstrom's noon) rather than
// being "some time that day"? Decides whether lateness is judged to the hour.
export function routeCutoffHourFor(order) {
  return routingCutoffHour({ customer: order?.tradingPartner || '' })
}

// How the deadline reads on a card. Names the date, and the hour only when the
// partner actually has a cutoff — saying "by 12pm" to a partner with no stated
// cutoff would invent a precision we were never given.
export function routeDeadlineText(routeBy, cutoffHour) {
  if (routeBy == null) return 'routing'
  const d = new Date(routeBy)
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  if (cutoffHour == null) return date
  const hour = cutoffHour % 12 === 0 ? 12 : cutoffHour % 12
  return `${date} ${hour}${cutoffHour < 12 ? 'am' : 'pm'}`
}

const DAY = 86400000

export const MISSED_AFTER_DAYS = 7 // 850 with no NetSuite order after this = presumed missed
export const CANCEL_SOON_DAYS = 7
// The routing deadline is only 3 business days wide to begin with, so a 7-day
// "soon" horizon would light up before the window even opens. Two days: enough to
// act, short enough that the chip means today-or-tomorrow.
export const ROUTE_SOON_DAYS = 2

function daysSince(dateish, today) {
  if (!dateish) return null
  return Math.floor((today - new Date(dateish).getTime()) / DAY)
}

// ── verify-&-close (Nima, 2026-07-28, Phase C) ───────────────────────────────
// A PO is only genuinely done when BOTH the 856 (ASN) and the 810 (invoice) we
// sent actually landed and were accepted at the partner. Orderful already tells
// us that per transaction — deliveryStatus + acknowledgmentStatus — so we don't
// trust "an 810 row exists" (the old silent auto-close) as proof they arrived.
// Confirmed value vocabulary from live data:
//   deliveryStatus:       DELIVERED (good) · PENDING (in flight) · FAILED (bad)
//   acknowledgmentStatus: ACCEPTED / ACCEPTED_WITH_ERRORS (good) ·
//                         NOT_ACKNOWLEDGED (awaiting) · OVERDUE / REJECTED (bad)
const POSITIVE_ACK = new Set(['ACCEPTED', 'ACCEPTED_WITH_ERRORS'])
const DOC_LABEL = { '856_SHIP_NOTICE_MANIFEST': '856', '810_INVOICE': '810' }

// Classify the one outbound document of a type (856 or 810) for close-readiness.
// Picks a DELIVERED+accepted transaction if any exists (a resent/valid copy
// wins over an earlier bad one); otherwise describes why it isn't confirmed.
// Human-acked issues (edi_ack) are treated as resolved, so a rejected-then-
// resent doc doesn't read as a blocker once its good copy is present.
function classifyDoc(type, transactions) {
  const label = DOC_LABEL[type] || type
  const txns = transactions.filter((t) => t.type === type && t.direction === 'OUT')
  if (!txns.length) return { label, sent: false, confirmed: false, status: 'not sent', blocker: `no ${label} sent` }

  const good = txns.find((t) => t.deliveryStatus === 'DELIVERED' && POSITIVE_ACK.has(t.acknowledgmentStatus))
  if (good) {
    const withErrors = good.acknowledgmentStatus === 'ACCEPTED_WITH_ERRORS'
    return {
      label, sent: true, confirmed: true, txn: good,
      status: withErrors ? 'delivered · accepted with errors' : 'delivered & accepted',
      blocker: null,
    }
  }
  // Not confirmed — surface the most-progressed non-resolved copy's problem:
  // prefer a delivered-but-unacked one, else the most recent attempt.
  const live = txns.filter((t) => !t.ack)
  const pool = live.length ? live : txns
  const best = pool.find((t) => t.deliveryStatus === 'DELIVERED') ||
    pool.reduce((a, b) => (new Date(b.createdAt || 0) >= new Date(a.createdAt || 0) ? b : a))
  const delivered = best.deliveryStatus === 'DELIVERED'
  const status = delivered
    ? `delivered · ack ${String(best.acknowledgmentStatus || 'pending').toLowerCase().replace(/_/g, ' ')}`
    : `delivery ${String(best.deliveryStatus || 'pending').toLowerCase()}`
  const blocker = delivered
    ? `${label} delivered but acknowledgment ${String(best.acknowledgmentStatus || 'pending').toLowerCase().replace(/_/g, ' ')}`
    : `${label} ${String(best.deliveryStatus || 'pending').toLowerCase()} — not delivered yet`
  return { label, sent: true, confirmed: false, txn: best, status, blocker }
}

// The per-PO verify summary the "Verify & close" action reads: are both the
// 856 and 810 confirmed delivered+accepted in Orderful, and if not, exactly
// what's missing. Pure — computed from transactions already on the order.
export function verifyDocs(order) {
  const ship = classifyDoc('856_SHIP_NOTICE_MANIFEST', order.transactions || [])
  const invoice = classifyDoc('810_INVOICE', order.transactions || [])
  const blockers = [ship.blocker, invoice.blocker].filter(Boolean)
  return { ship, invoice, canClose: ship.confirmed && invoice.confirmed, blockers }
}

// One order from computeEdiPipeline + its resolution → work status.
export function deriveWork(order, resolution = null, today = Date.now()) {
  const r = resolution || null
  const age850 = daysSince(
    order.transactions?.find((t) => t.type === '850_PURCHASE_ORDER')?.createdAt, today,
  )
  // Every sales order on this PO, not just the first — an EDI PO is one SO per
  // store/DC. Falls back to the singular for callers still passing old shapes.
  const sos = order.netsuiteOrders?.length
    ? order.netsuiteOrders
    : (order.netsuiteOrder ? [order.netsuiteOrder] : [])
  const unshippedSos = sos.filter((o) => o.stage !== 'SHIPPED')

  // ── partner cancellation (2026-08-04, the PR #12 follow-up) ────────────────
  // The CURRENT 850 zeroes the PO out (ediPipeline's `cancelled850`) — the
  // partner's cancel shape is a re-send with 0 units. Chasing it with "enter
  // in NetSuite" / cancel-date danger is wrong: the work left is to
  // acknowledge the cancellation and close. Only quiets the chase when
  // nothing shipped — a zeroed PO with a shipped fulfilment is a DISPUTE,
  // not a cancellation, and falls through to the normal (loud) flow.
  const partnerCancelled =
    !!order.cancelled850 && order.stageRank < 3 && !sos.some((o) => o.stage === 'SHIPPED')

  // ── closed? ────────────────────────────────────────────────────────────────
  // Manual close always wins. Nothing closes silently anymore (Nima, 2026-07-28,
  // Phase C): the old `autoClosed = stageRank>=4 && !hasIssue` trusted "an 810
  // row exists" as proof of completion, which let POs with an undelivered
  // (PENDING) or unacked 856/810 vanish into Closed. That auto-close is now a
  // non-terminal `readyToClose` holding state (below) that must be confirmed
  // via an explicit Verify & close — the close still flows through the manual
  // resolution path, so `closedBy` is 'manual' for a verified close.
  const manuallyCancelled = r?.cancelled === true
  const manuallyClosed = !manuallyCancelled && r?.closed === true
  const closed = manuallyCancelled || manuallyClosed

  // ── review gate (Nima, 2026-07-28) ──────────────────────────────────────────
  // Old/uncertain POs get parked "in review". While parked we STOP chasing the
  // 856/810 — no point until the PO is confirmed real. Validating = tying it to
  // its NetSuite order releases it back to the normal flow.
  const reviewState = r?.reviewState || null
  const underReview = !closed && reviewState === 'in_review'
  const validated = reviewState === 'validated'
  // 'unallocated' (Nima, 2026-07-29): parked with a reason — the 850 landed but
  // the units aren't allocated, so it can't be entered into NetSuite yet.
  // Behaves like in_review for gating (stop chasing 856/810), but the partner
  // re-sends the same PO# once allocatable, which the version diff watches.
  const unallocated = !closed && reviewState === 'unallocated'
  const parked = underReview || unallocated

  // ── re-sent-PO version diff + re-check (Nima, 2026-07-29) ────────────────────
  // A partner re-transmitting the same PO# (new 850, same business_number) is
  // how units / the ship window change. After the user has acted on a PO (its
  // resolution's updated_at), a LATER 850 that actually differs flips it to
  // "re-check" — the answer to "will it tell me to look again when it comes
  // back". A no-op re-send never triggers it.
  const version = poVersionInfo(order, r?.updatedAt || null, !!r)

  // ── ready to close (Phase C) ────────────────────────────────────────────────
  // Docs-complete (810 exists) with nothing broken and no link gaps — the old
  // auto-close condition. No longer closes; it parks here for an explicit
  // Verify & close. `verify` says whether the 856 + 810 actually landed.
  const readyToClose =
    !closed && !parked && order.bucket !== 'NO_850_FOUND' &&
    order.stageRank >= 4 && !order.hasIssue && !(order.linkGaps?.length)
  const verify = readyToClose ? verifyDocs(order) : null

  // ── missed-850 detection ───────────────────────────────────────────────────
  // A PO that landed, has no NetSuite order, no resolution, and hasn't shipped:
  // after MISSED_AFTER_DAYS that's "nobody entered this" — the failure Nima
  // found from a month back.
  const missed850 =
    !closed && !r && !partnerCancelled &&
    order.bucket !== 'NO_850_FOUND' &&
    order.stageRank <= 2 &&
    !order.netsuiteOrder &&
    age850 != null && age850 >= MISSED_AFTER_DAYS

  // ── cancel-date danger ─────────────────────────────────────────────────────
  let cancelState = null // 'passed' | 'soon' | null
  let cancelDays = null
  // A cancelled PO's cancel-after date is moot — without the gate, Shopbop's
  // zeroed re-send (which keeps its window) escalates a dead PO to cancel
  // danger as the date approaches.
  if (!closed && !partnerCancelled && order.cancelAfter && order.stageRank < 3) {
    const d = daysSince(order.cancelAfter, today)
    if (d != null && d >= 0) { cancelState = 'passed'; cancelDays = d }
    else if (d != null && -d <= CANCEL_SOON_DAYS) { cancelState = 'soon'; cancelDays = -d }
  }

  // ── the ROUTING deadline, which lands earlier than the cancel date ─────────
  //
  // Bloomingdale's routing must be in 3 BUSINESS days before its cancel date
  // (Nima, 2026-08-04 — see src/model/shipWindow.js for the rule and why business
  // days matter). The board has only ever ranked on the cancel date, so a PO with
  // a cancel date five days out read as five days of slack while the deadline that
  // actually binds was tomorrow. Live example the day this landed: PO 8040291 and
  // 8040313, cancel Mon Aug 10, route by Wed Aug 5.
  //
  // ⚠️ Deliberately a SEPARATE state, not a redefinition of cancelState — that
  // field means the cancel date and is read in five places, and quietly changing
  // what an existing field means is how the last four counter bugs happened. Both
  // feed cancelDanger; neither is summed into the other.
  //
  // ⚠️ Gated on `!order.routed`. Once the routing request is in, the deadline is
  // MET, not missed — and live today all 4 open Bloomingdale's POs are already
  // routed, so an ungated version would have been 4-for-4 false on its first run.
  let routeState = null // 'passed' | 'soon' | null
  let routeDays = null
  const routeBy = order.routed ? null : routeByFor(order, order.cancelAfter)
  const routeCutoffHour = routeCutoffHourFor(order)
  if (!closed && !partnerCancelled && !order.routed && routeBy != null && order.stageRank < 3) {
    // Compared as INSTANTS, not whole days, because Nordstrom's deadline is noon —
    // day-precision math would call 3pm on the deadline day "still today" and hand
    // back a next-day pickup that is already gone.
    const ms = routeBy - today
    if (ms <= 0) { routeState = 'passed'; routeDays = Math.max(0, Math.round(-ms / DAY)) }
    else if (ms <= ROUTE_SOON_DAYS * DAY) { routeState = 'soon'; routeDays = Math.round(ms / DAY) }
  }

  // ── what's needed next (first thing that blocks progress) ─────────────────
  let needed = null
  let needs856 = false, needs810 = false
  if (closed) {
    needed = null
  } else if (version.needsRecheck) {
    // a later, CHANGED 850 arrived after the user parked/validated/closed it
    needed = `⟳ Re-check — partner re-sent this PO (${version.sendCount}×) with changes since you handled it: ${version.recheckSummary.join('; ')}`
  } else if (unallocated) {
    // parked with a reason — nothing to do until it re-sends allocated
    needed = 'Unallocated — parked until units allocate; will flag on a changed re-send'
  } else if (underReview) {
    // parked — the only thing to do is validate it (confirm its NetSuite order)
    needed = (order.netsuiteOrder || r?.netsuiteRef)
      ? 'Validate this PO — confirm it to release from review'
      : 'Validate this PO — confirm its NetSuite order (parked for review)'
  } else if (partnerCancelled) {
    // Closing flows through the same manual resolution path as everything
    // else (mark cancelled) — nothing closes silently.
    needed = 'Cancelled by partner — current 850 zeroes it out; confirm & close'
  } else if (readyToClose) {
    needed = verify.canClose
      ? 'Verify & close — 856 + 810 delivered & accepted'
      : `Verify before closing — ${verify.blockers.join('; ')}`
  } else if (order.bucket === 'NO_850_FOUND') {
    needed = 'Orphan document — find and link its 850 (no PO on file)'
  } else if (order.hasIssue) {
    const bad = order.transactions.find(
      (t) => !t.ack && (t.validationStatus === 'INVALID' || t.deliveryStatus === 'FAILED' ||
             t.acknowledgmentStatus === 'REJECTED' || t.acknowledgmentStatus === 'OVERDUE'),
    )
    const what = bad
      ? `${bad.type.split('_')[0]} ${bad.validationStatus === 'INVALID' ? 'invalid' : bad.deliveryStatus === 'FAILED' ? 'failed to deliver' : 'acknowledgment ' + String(bad.acknowledgmentStatus).toLowerCase()}`
      : 'a document has an EDI error'
    needed = `Fix EDI: ${what}`
  } else if (missed850) {
    needed = `Enter in NetSuite — 850 arrived ${age850}d ago, no order found`
  } else if (order.stageRank <= 2 && !order.netsuiteOrder && r?.netsuiteRef) {
    needed = `Progress ${r.netsuiteRef} — linked manually, not shipped yet`
  } else if (order.stageRank <= 2 && !order.netsuiteOrder) {
    needed = 'Enter in NetSuite (no matching order yet)'
  } else if (order.stageRank <= 2 && order.netsuiteOrder && unshippedSos.length) {
    // An EDI PO fans out to one SO per store, so name the count rather than
    // whichever single SO happened to be first — see ediPipeline's netsuiteOrders.
    const lead = unshippedSos[0]
    const more = unshippedSos.length > 1 ? ` (+${unshippedSos.length - 1} more SO${unshippedSos.length > 2 ? 's' : ''})` : ''
    needed = `Fulfill & ship — ${lead.soNumber}${more} ${lead.nextAction ? '· ' + lead.nextAction : ''}`.trim()
  } else if (sos.some((o) => o.stage === 'SHIPPED') && order.stageRank < 3) {
    needed = 'Send the 856 ASN — NetSuite shows it shipped'; needs856 = true
  } else if (order.stageRank === 3) {
    needed = 'Send the 810 invoice'; needs810 = true
  } else if (order.linkGaps?.length) {
    needed = order.linkGaps[0]
  } else {
    needed = 'Review — state unclear'
  }
  if (cancelState === 'passed') needed = `⚠ Cancel date passed ${cancelDays}d ago — ${needed || 'review'}`
  // The routing deadline leads only when the cancel date has NOT already passed —
  // once the shipment is late outright, "route it by Tuesday" is no longer the
  // useful sentence. Says ROUTE explicitly so it can't be read as a ship date.
  // The lead differs by partner (3 business days for Bloomingdale's, noon the day
  // before for Nordstrom), so the sentence states the ACTUAL deadline rather than
  // hardcoding one partner's rule — the previous draft said "3 business days" to
  // everyone, which would have been wrong for every Nordstrom PO.
  else if (routeState === 'passed') needed = `⚠ Routing was due ${routeDeadlineText(routeBy, routeCutoffHour)} — ${needed || 'route it'}`
  else if (routeState === 'soon') needed = `⏱ Route by ${routeDeadlineText(routeBy, routeCutoffHour)} — ${needed || 'route it'}`

  return {
    closed,
    closedBy: manuallyCancelled ? 'cancelled' : manuallyClosed ? 'manual' : null,
    resolution: r,
    needed,
    missed850,
    partnerCancelled,
    age850,
    cancelState,
    cancelDays,
    // The routing deadline, kept apart from cancelState on purpose (never summed
    // into it) — one is "the partner cancels", the other is "we miss our slot".
    routeState,
    routeDays,
    routeBy,
    routed: !!order.routed,
    reviewState,
    underReview,
    unallocated,
    parked,
    validated,
    readyToClose,
    verify,
    needs856,
    needs810,
    // version diff (re-sent POs)
    sendCount: version.sendCount,
    versions: version.versions,
    versionSteps: version.steps,
    needsRecheck: version.needsRecheck,
    recheckSummary: version.recheckSummary,
    recheckSince: version.recheckSince,
  }
}

// Whole-board derivation: work per order + per-partner open/closed rollups and
// the open:closed ratio Nima wants to track (task-generator fuel later).
export function computeEdiWork(orders = [], resolutions = [], today = Date.now()) {
  const resByBn = new Map(resolutions.map((r) => [r.businessNumber, r]))
  const withWork = orders.map((o) => ({ ...o, work: deriveWork(o, resByBn.get(o.businessNumber) || null, today) }))

  const partners = new Map()
  for (const o of withWork) {
    const key = o.tradingPartner || '(unknown partner)'
    if (!partners.has(key)) {
      partners.set(key, { tradingPartner: key, open: 0, closed: 0, missed: 0, cancelDanger: 0, issues: 0, inReview: 0, unallocated: 0, recheck: 0, readyToClose: 0, needs856: 0, needs810: 0, partnerCancelled: 0 })
    }
    const p = partners.get(key)
    if (o.work.closed) p.closed++
    else p.open++
    if (o.work.missed850) p.missed++
    if (o.work.partnerCancelled && !o.work.closed) p.partnerCancelled++
    // Either clock counts as danger — missing the routing slot IS how the cancel
    // date then gets missed. Counted once per PO, never once per clock, so a PO
    // late on both doesn't double the number (the never-lump rule cuts both ways).
    if (o.work.cancelState || o.work.routeState) p.cancelDanger++
    if (o.hasIssue && !o.work.closed) p.issues++
    if (o.work.underReview) p.inReview++
    if (o.work.unallocated) p.unallocated++
    if (o.work.needsRecheck) p.recheck++
    if (o.work.readyToClose) p.readyToClose++
    if (o.work.needs856) p.needs856++
    if (o.work.needs810) p.needs810++
  }
  const partnerList = [...partners.values()]
    .map((p) => ({ ...p, total: p.open + p.closed, closedRatio: p.open + p.closed ? p.closed / (p.open + p.closed) : 0 }))
    .sort((a, b) => b.open - a.open || b.total - a.total)

  const totals = partnerList.reduce(
    (t, p) => ({
      open: t.open + p.open, closed: t.closed + p.closed, missed: t.missed + p.missed,
      cancelDanger: t.cancelDanger + p.cancelDanger, inReview: t.inReview + p.inReview,
      unallocated: t.unallocated + p.unallocated, recheck: t.recheck + p.recheck,
      readyToClose: t.readyToClose + p.readyToClose,
      needs856: t.needs856 + p.needs856, needs810: t.needs810 + p.needs810,
      partnerCancelled: t.partnerCancelled + p.partnerCancelled,
    }),
    { open: 0, closed: 0, missed: 0, cancelDanger: 0, inReview: 0, unallocated: 0, recheck: 0, readyToClose: 0, needs856: 0, needs810: 0, partnerCancelled: 0 },
  )

  return { orders: withWork, partners: partnerList, totals }
}
