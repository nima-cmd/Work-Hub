// src/model/shipmentCalendar.js — a shipment as a shareable calendar entry.
//
// Nima, 2026-08-25: "we want a calendar that can show when these order shipped with a
// link to the google doc to the paper work for that.. as well as for EDI to have
// references the 856 810 documents."
//
// ⚠️ THIS TEXT LEAVES THE BUILDING. A calendar he shares is read by the warehouse and
// potentially by people who will never open this app, so the event body is the whole
// interface — and every claim in it has to survive being quoted back. Two consequences:
//
//   · the title NEVER says "Shipped" unless the evidence is PROVEN
//     (src/model/shipmentEvidence.js). Our own ship date alone reads "ship date
//     recorded", because a calendar entry asserting a shipment on our word is exactly
//     the artefact someone forwards to a partner.
//   · the document numbers go in the BODY, not just a count. "4 ASNs" answers nothing
//     when the question is which ASN; NB1731242 does.
//
// ⚠️ AND THE DATE IS THE EVIDENCE'S DATE, NOT TODAY. An all-day event on the day the
// freight actually went is the point; stamping it with the sync's run date would make
// the calendar a log of when the job ran.

import { TIER } from './shipmentEvidence.js'
import { shipmentKey } from './heldShipment.js'

// The warehouse is in Glendale, California, and an all-day calendar entry means the
// day a person there would name.
const SHIP_TZ = 'America/Los_Angeles'

/**
 * YYYY-MM-DD for a timestamp, in the WAREHOUSE's day.
 *
 * ⚠️ TWO BUGS LIVE HERE AND I WROTE THE FIRST ONE. `String(date).slice(0,10)` on a
 * pg timestamptz yields "Mon Aug 03" — node-pg hands back a Date object, not an ISO
 * string, and slicing its toString gives the weekday. It rendered exactly that before
 * this was fixed.
 *
 * ⚠️ The second is the timezone, and UTC is the wrong answer even though it is the
 * repo's default elsewhere. calendarAgenda.js uses UTC because a Postgres DATE arrives
 * as UTC midnight — a date with no time. These are timestamptz: real moments. An ASN
 * accepted at 02:00Z on the 4th was accepted at 19:00 on the 3rd in Glendale, and an
 * all-day event on the 4th would put the freight on the wrong day. The tender parser
 * carries the same warning about a carrier's local time at a California facility.
 */
export function isoShipDay(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  // 'en-CA' formats as YYYY-MM-DD, so no manual assembly and no month/day inversion.
  return d.toLocaleDateString('en-CA', { timeZone: SHIP_TZ })
}

/**
 * YYYY-MM-DD for a Postgres DATE — a day with no time, which must NOT be re-zoned.
 *
 * ⚠️ THE TWIN OF isoShipDay, AND THE OPPOSITE RULE. node-pg hands back a JS Date for a
 * DATE column too, at LOCAL midnight, so `String(d).slice(0, 10)` yields "Sat Jun 27" —
 * the same weekday bug #170 fixed for timestamptz, still live on this path: the proof
 * panel's shipDates read "Sat Jun 27" in production until this was found by running the
 * calendar dry run (2026-08-25). And toISOString() is not the fix either — local
 * midnight in a negative-offset zone is the previous day in UTC, which is how a DATE
 * moves backwards. Formatted from the LOCAL parts, so the day round-trips exactly.
 */
export function isoPlainDay(v) {
  if (!v) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/** The one date to put the event on, chosen by the same ranking as the proof.
 *  ⚠️ Prefers what a third party attested over what we recorded. */
export function eventDate(evidence = {}, shipDates = []) {
  const first = (xs) => xs.filter(Boolean).map((x) => new Date(x).getTime()).sort((a, b) => a - b)[0]
  const asn = first((evidence.backTrace?.asns || []).filter((a) => a.accepted).map((a) => a.at))
  if (asn) return isoShipDay(asn)
  const inv = first((evidence.backTrace?.invoices || []).filter((i) => i.accepted).map((i) => i.at))
  if (inv) return isoShipDay(inv)
  // ⚠️ Our own dates are already plain days (fulfillments.actual_ship_date is a DATE),
  // so they are NOT re-zoned — shifting a dateless day by a timezone is how a DATE
  // moves backwards, the exact trap pipeline.js hit.
  const own = [...shipDates].filter(Boolean).map(String).sort()[0]
  return own ? own.slice(0, 10) : null
}

/**
 * Build the event. Returns null when there is nothing honest to say.
 * @param po        the PO number
 * @param partner   'Bloomingdale''s'
 * @param evidence  the shipmentEvidence() result
 * @param shipDates our own dates, used only as a last resort
 */
export function shipmentEvent({ po, so, partner, evidence, shipDates = [] } = {}) {
  // ⚠️ AN SO IS ENOUGH WHEN THERE IS NO PO. Boutique customers frequently give none —
  // 10 of 21 scanned boutique shipments carry no po_number — and requiring one meant a
  // shipped order with signed paperwork on file appeared on NO calendar at all: dropped
  // from the warehouse calendar when it shipped, and never eligible for a shipped one.
  // Splash SO12299 was the first real case.
  if ((!po && !so) || !evidence) return null
  const date = eventDate(evidence, shipDates)
  // ⚠️ NO DATE, NO EVENT. An event needs a day; inventing one would put freight on a
  // calendar on a day nothing happened.
  if (!date) return null

  const c = evidence.counts || {}
  const verb = evidence.proven ? 'shipped' : 'ship date recorded'
  const bols = (evidence.backTrace?.asns || []).map((a) => a.number).filter(Boolean)
  const summary = `${partner || 'PO'} ${po || so} — ${verb}`
    + (bols.length ? ` (${bols.length} BOL${bols.length === 1 ? '' : 's'})` : '')

  const lines = []
  lines.push(evidence.strongestLabel ? `Basis: ${evidence.strongestLabel}` : 'Basis: none on file')
  if (!evidence.proven) {
    lines.push('⚠ Not confirmed by the partner or the carrier — this is our own record only.')
  }
  lines.push('')

  if (bols.length) {
    lines.push('ASN (856) / BOL:')
    for (const a of evidence.backTrace.asns) {
      lines.push(`  ${a.number}${a.accepted ? '  accepted' : '  NOT accepted'}`)
    }
    lines.push('')
  }
  const inv = evidence.backTrace?.invoices || []
  if (inv.length) {
    // ⚠️ A range for many, every number for a few. 23 invoices listed individually
    // buries the links below them; two listed as "11419–11420" hides that there are
    // only two. The threshold is about legibility, not tidiness.
    lines.push(`Invoice (810): ${inv.length}`)
    if (inv.length <= 6) inv.forEach((i) => lines.push(`  ${i.number}${i.accepted ? '  accepted' : '  NOT accepted'}`))
    else lines.push(`  ${inv[0].number}–${inv[inv.length - 1].number}  (${inv.filter((i) => i.accepted).length} accepted)`)
    lines.push('')
  }
  if (c.asnsDeliveredNotAccepted) {
    lines.push(`⚠ ${c.asnsDeliveredNotAccepted} ASN(s) delivered but NOT acknowledged — chargeback exposure.`)
    lines.push('')
  }

  const scans = evidence.backTrace?.scans || []
  if (scans.length) {
    lines.push('Signed paperwork:')
    for (const s of scans) lines.push(`  ${s.dc ? s.dc + ' — ' : ''}${s.name}\n    ${s.url}`)
  } else if (evidence.scansChecked === false) {
    // ⚠️ NOT "none filed" — WE NEVER LOOKED. Drive is searched under the partner the
    // file was filed beneath, so a PO with no partner resolved gets no lookup at all
    // (184 of 235 candidates, 2026-08-25). Printing "No signed paperwork filed" there
    // states a finding we never made, to the warehouse, in writing — the same class of
    // claim the title guard exists to prevent. `=== false` on purpose: an older caller
    // that does not set the flag keeps the original wording rather than silently
    // acquiring a hedge.
    lines.push('Signed paperwork: not checked — no partner on file for this PO.')
  } else {
    lines.push('No signed paperwork filed for this PO.')
  }

  return {
    // ⚠️ A STABLE KEY, so a re-sync updates the event instead of adding a second one.
    //
    // ⚠️ GOOGLE EVENT IDS ARE BASE32HEX: a–v and 0–9 ONLY. I first prefixed this "wh"
    // for Work-Hub — and 'w' is outside a–v, so every single event would have been
    // rejected by the API with a cryptic 400. Caught by the test asserting the charset
    // rather than by a failed sync. A PO can also contain characters outside the set,
    // so it is filtered rather than trusted.
    // ⚠️ THE SHARED KEY, so a shipment keeps ONE id across the warehouse calendar and
    // the shipped one — that identity is what lets the move be detected. A PO still
    // wins, so every event published before this keeps its id and is UPDATED rather
    // than orphaned and duplicated.
    key: shipmentKey({ po, so }),
    date,
    summary,
    description: lines.join('\n').trim(),
    proven: !!evidence.proven,
    strongest: evidence.strongest || null,
    // Named so a caller can refuse to publish an unproven shipment if it chooses.
    publishable: evidence.strongest !== null,
  }
}

export { TIER }
