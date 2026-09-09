// src/model/asnDue.js — freight has left and the partner has not been told yet.
//
// ── ⚠️ WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// On 2026-09-09 Nordstrom sent an EDI compliance notice for PO 50220600:
//
//   "ASN Missing - ASN not received in 24 hours, (PO Pickup) document received
//    on (20260908)."  →  offset fees
//
// CTE collected the freight on 09-08. Two invoices went out at 18:14 and were
// accepted. The shipment was marked shipped at 18:33. **No 856 was ever sent.**
//
// Nima, 2026-09-09: "the 856 didn't fire cause i didn't send them its not a fault
// of the app its because we didn't do it.. im brining it up as a red flag we need
// to have sent it before we left yesterday. We need to make sure i dont forget."
//
// So this is not a bug detector. It is a DEADLINE. The app already knew every fact
// needed to raise it — shipped_at was set, no 856 existed, the clock was running —
// and said nothing, because knowing and prompting are different things.
//
// ── ⚠️ TWO RULES THIS INCIDENT TAUGHT, BOTH LOAD-BEARING ─────────────────────
//
// 1. THE CLOCK STARTS AT PICKUP, NOT AT OUR CLICK. Nordstrom counts from when the
//    carrier took the freight — their notice names the pickup date, not anything
//    of ours. `shipped_at` is when someone pressed a button in Work-Hub, which can
//    be hours or days later. Using it would compute a deadline LATER than the real
//    one and reassure us right up to the fee. So `ship_date` (the pickup date)
//    wins whenever it exists, and the result says which was used.
//
// 2. ⚠️ NETSUITE'S `custbody_hb_edi_856_synced` FLAG IS NOT EVIDENCE. Measured on
//    this very incident: it read `T` on all ten fulfilments (IF7640-IF7649) while
//    Orderful held ZERO 856s for either BOL. A flag that says "sent" when nothing
//    was sent is worse than no flag — it is the thing that would hide the next one.
//    Only a real 856 in Orderful counts as told. See [[edi-asn-delivery-gap]].

const HOURS = 36e5

/**
 * Nordstrom states 24 hours in writing. Treated as the rule for everyone until a
 * partner documents its own — being early costs nothing, being late costs a fee.
 */
export const ASN_WINDOW_HOURS = 24

/** How long before the deadline we start saying so. */
export const ASN_WARN_HOURS = 6

const time = (v) => {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * When did the partner's clock start for this shipment?
 *
 * ⚠️ PICKUP FIRST, ALWAYS — see rule 1 above. Returns which one was used so a card
 * can say "from pickup" vs "from our mark", because the second is a guess about
 * the first and the reader deserves to know.
 */
export function clockStart(shipment = {}) {
  const pickup = time(shipment.shipDate ?? shipment.ship_date)
  if (pickup) return { at: pickup, basis: 'pickup' }
  const marked = time(shipment.shippedAt ?? shipment.shipped_at)
  if (marked) return { at: marked, basis: 'marked shipped' }
  return { at: null, basis: null }
}

/**
 * Does this shipment still owe an ASN, and how long is left?
 *
 * @param shipment { bolNumber, partner, memberPos, shipDate, shippedAt, asnCreatedAt, cartons }
 * @param now      ms — injected so the rule is testable and never reads the clock itself
 *
 * @returns null when nothing is owed, else
 *   { bolNumber, partner, po, basis, hoursElapsed, hoursLeft, dueAt, state }
 *   state: 'warn' (inside ASN_WARN_HOURS) · 'due' (past the window) · 'watch'
 */
export function asnDue(shipment = {}, now = Date.now()) {
  // ⚠️ ONLY A REAL 856 COUNTS. Never the NetSuite flag — rule 2 above.
  //
  // ⚠️ AND NEVER `routing_shipment_edi` EITHER, which is rule 3 and cost this module
  // its first version. Reading that link table reported 23 shipments overdue when
  // 21 had perfectly good ASNs: it is populated on only 30 of 53 shipped rows, so a
  // NULL there means "never linked", not "never sent". A guard that is 91% wrong is
  // worse than no guard, because it gets ignored inside a day and takes the two real
  // rows with it. `asnSentAt` is the min(created_at) of a real outbound 856 whose
  // business_number IS this BOL — the same empty-field-reads-as-absent-fact trap as
  // custbody_po_cd_identifier. See [[edi-asn-delivery-gap]].
  if (time(shipment.asnSentAt ?? shipment.asn_sent_at)) return null

  const { at, basis } = clockStart(shipment)
  // Nothing has left the building yet, so nothing is owed. A shipment with no
  // date at all is NOT silently treated as overdue — that would fill the list
  // with cards nobody has touched.
  if (!at) return null

  const hoursElapsed = (now - at) / HOURS
  if (hoursElapsed < 0) return null // pickup is in the future; the clock has not started

  const dueAt = at + ASN_WINDOW_HOURS * HOURS
  const hoursLeft = (dueAt - now) / HOURS
  const state = hoursLeft <= 0 ? 'due' : hoursLeft <= ASN_WARN_HOURS ? 'warn' : 'watch'

  return {
    bolNumber: shipment.bolNumber ?? shipment.bol_number ?? null,
    partner: shipment.partner ?? null,
    po: (shipment.memberPos ?? shipment.member_pos ?? [])[0] ?? null,
    cartons: shipment.cartons ?? null,
    basis,
    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    dueAt: new Date(dueAt).toISOString(),
    state,
  }
}

/**
 * Everything owing an ASN, worst first.
 *
 * ⚠️ `watch` rows are RETURNED, not hidden. A shipment with 20 hours left is not a
 * problem yet, but it is the one you want to see at 5pm — which is the entire point
 * of this module. The caller decides what to show loudly; suppressing them here
 * would rebuild the silence this replaces.
 */
export function asnDueList(shipments = [], now = Date.now()) {
  const rank = { due: 0, warn: 1, watch: 2 }
  return shipments
    .map((s) => asnDue(s, now))
    .filter(Boolean)
    .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.hoursLeft - b.hoursLeft))
}

/**
 * One line for the end of the day. Null when there is nothing owed.
 *
 * ⚠️ WORDED FOR SOMEONE ABOUT TO WALK OUT. "3 shipments awaiting ASN" is a fact;
 * "2 ASNs OVERDUE" is the thing that stops you at the door. Nordstrom's fee is
 * the reason the second wording exists.
 */
export function asnDueSummary(shipments = [], now = Date.now()) {
  const list = asnDueList(shipments, now)
  if (!list.length) return null
  const due = list.filter((r) => r.state === 'due')
  const warn = list.filter((r) => r.state === 'warn')
  const parts = []
  if (due.length) parts.push(`${due.length} ASN${due.length === 1 ? '' : 's'} OVERDUE`)
  if (warn.length) parts.push(`${warn.length} due within ${ASN_WARN_HOURS}h`)
  if (!parts.length) parts.push(`${list.length} shipment${list.length === 1 ? '' : 's'} awaiting an ASN`)
  return {
    total: list.length,
    due: due.length,
    warn: warn.length,
    // The BOLs, so the message names the work rather than counting it.
    bols: list.map((r) => r.bolNumber).filter(Boolean),
    text: parts.join(' · ') + (due.length ? ' — Nordstrom charges an offset fee past 24 hours from pickup' : ''),
    severity: due.length ? 'critical' : warn.length ? 'warn' : 'notice',
  }
}
