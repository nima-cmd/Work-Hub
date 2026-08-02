// src/model/ediDelivery.js — did the document we sent actually REACH the partner?
//
// Nima, 2026-08-01: "I don't believe the ASNs I just generated for what I shipped
// were actually sent." He was right, and it isn't a one-off. Confirmed live:
// NetSuite marks every fulfilment `custbody_hb_edi_856_synced = T` — so from
// NetSuite's side the ASN went — while Orderful holds the transaction as VALID
// but `deliveryStatus = PENDING`, never pushed to the partner. Nothing in either
// system complains, so the failure is completely silent.
//
// Scale of it when first measured: 69 outbound 856s and 12 outbound 810s that
// NEVER delivered, going back to Jan 2025, across Bloomingdale's, Shopbop and
// Neiman Marcus — plus 3 rejected and 9 overdue acknowledgments. This is the
// chargeback surface: a partner that never got an ASN treats the shipment as
// unannounced.
//
// Two DIFFERENT failures, deliberately never merged into one number:
//   • STUCK   — delivery never completed. The document is sitting in Orderful.
//               Our court: re-send it.
//   • REFUSED — delivered, but the partner rejected or never acknowledged it in
//               time. Their system saw it and said no. Needs reading, not a
//               re-send.
// And 856 is kept apart from 810 for the same reason: a missing ASN risks a
// compliance chargeback on goods already moving, a missing invoice is money not
// yet asked for. Same mechanism, different urgency, different fix.
//
// ⚠️ 2026-08-02 — A STUCK DOCUMENT IS NOT THE SAME THING AS AN UNANNOUNCED
// SHIPMENT, and conflating the two made the court strip claim chargeback
// exposure that does not exist. Measured live: of **62 of 62** stuck 856s, every
// single one shares its business number with another 856 that DID reach
// DELIVERED + ACCEPTED. Partners re-transmit, Orderful keeps the superseded copy
// forever, and the copy never moves again — so the pile grows monotonically
// while the shipment behind it was announced fine. `ediPartnerTabs.asnState()`
// already got this right at the PO level, which is why tab ④ honestly reads 0
// against this module's 62.
//
// So the stuck pile is split once more:
//   • UNANNOUNCED — no delivered+accepted twin. This is the real exposure.
//   • RESENT      — a twin already landed. Document hygiene, zero exposure.
//
// THE KEY IS THE BUSINESS NUMBER, NOT THE PO — and that choice is load-bearing.
// An EDI PO fans out to one 856 per DC (PO 22225558 carries six, one each for
// DCs 089/299/399/499/699/799), so "this PO has a delivered 856 somewhere"
// would forgive a DC that genuinely never got announced. On an 856 the business
// number IS the shipment reference and on an 810 it is the invoice reference —
// same reference means same document, which is what a re-send actually is. This
// is deliberately TIGHTER than tab ④'s per-PO test; both are right at their own
// unit, and neither number is ever summed into the other.
//
// The two kinds diverge sharply on live data, which is exactly why they can't
// share a chip: the 856 pile is 62 re-sends and 0 real, while the 810 pile is 0
// re-sends and 12 real (11 distinct invoices, 285–674 days old, none of which
// ever reached the partner).

// Orderful's terminal-good states.
const DELIVERED = 'DELIVERED'
const ACK_OK = 'ACCEPTED'
// ACCEPTED_WITH_ERRORS is a partner saying "got it, some lines had notes" — the
// shipment IS announced, so it counts as a landed twin. Same set asnState() uses.
const POSITIVE_ACK = new Set([ACK_OK, 'ACCEPTED_WITH_ERRORS'])

// A freshly-transmitted document is legitimately PENDING for a few minutes while
// Orderful hands it off, so a grace window keeps "sent 30 seconds ago" out of the
// alert. Measured: healthy ones reach their final state within minutes, and the
// stuck ones never move again — so anything past the window is genuinely stuck,
// not in flight.
export const DELIVERY_GRACE_MINUTES = 120

export function classifyEdiDelivery(txn, now = new Date()) {
  const delivery = String(txn.deliveryStatus || '').toUpperCase()
  const ack = String(txn.acknowledgmentStatus || '').toUpperCase()
  const created = txn.createdAt ? new Date(txn.createdAt) : null
  const ageMinutes = created ? (now - created) / 60000 : null

  if (delivery !== DELIVERED) {
    // Still inside the hand-off window — in flight, not a problem yet.
    if (ageMinutes !== null && ageMinutes < DELIVERY_GRACE_MINUTES) {
      return { state: 'in_flight', ageMinutes, reason: `delivery ${delivery || 'unknown'}, ${Math.round(ageMinutes)} min old` }
    }
    return { state: 'stuck', ageMinutes, reason: `delivery ${delivery || 'unknown'}` }
  }
  if (ack && ack !== ACK_OK) return { state: 'refused', ageMinutes, reason: `ack ${ack}` }
  return { state: 'ok', ageMinutes }
}

const kindOf = (type) => {
  const t = String(type || '')
  if (t.startsWith('856')) return 'asn'
  if (t.startsWith('810')) return 'invoice'
  return 'other'
}

// Every (kind, business number) pair that has a copy the partner actually took.
// Built from the OUTBOUND LIVE set only, for the same reason the buckets are: a
// TEST-stream twin is not proof a real partner was told.
function landedRefs(transactions) {
  const landed = new Set()
  for (const t of transactions) {
    if (String(t.direction || '').toUpperCase() !== 'OUT') continue
    if (String(t.stream || '').toUpperCase() !== 'LIVE') continue
    if (String(t.deliveryStatus || '').toUpperCase() !== DELIVERED) continue
    if (!POSITIVE_ACK.has(String(t.acknowledgmentStatus || '').toUpperCase())) continue
    if (!t.businessNumber) continue
    landed.add(`${kindOf(t.type)}|${t.businessNumber}`)
  }
  return landed
}

// How many distinct documents a pile of transactions really represents. The
// document count over-reports: Nordstrom sent invoice 327510304 twice and both
// copies are stuck, which is one invoice to chase, not two.
const distinctRefs = (rows) => new Set(rows.map((r) => r.businessNumber).filter(Boolean)).size

// Split outbound transactions into the two failures, per document kind.
// transactions: [{ id, type, direction, stream, businessNumber, tradingPartner,
//                  deliveryStatus, acknowledgmentStatus, createdAt }]
export function computeEdiDeliveryGaps(transactions = [], now = new Date()) {
  // Undelivered AND no delivered+accepted twin — the partner genuinely was never
  // told. This is the only bucket that may claim chargeback exposure.
  const unannounced = { asn: [], invoice: [], other: [] }
  // Undelivered but superseded by a twin that landed. Stale copies in Orderful,
  // nothing owed to the partner. Kept as its own list rather than dropped: 62
  // documents disappearing without explanation is its own kind of dishonesty.
  const resent = { asn: [], invoice: [], other: [] }
  const refused = { asn: [], invoice: [], other: [] }
  // Reported separately from `stuck`: inside the hand-off window, so not yet a
  // problem — but it IS what someone who just transmitted wants to see, and it's
  // the answer to "did the ASN I just generated actually go?". Watch, don't alarm.
  const inFlight = { asn: [], invoice: [], other: [] }

  const landed = landedRefs(transactions)

  for (const t of transactions) {
    // Outbound only — an inbound 850's delivery is the partner's problem — and
    // LIVE only, so the TEST stream can never raise a real alert.
    if (String(t.direction || '').toUpperCase() !== 'OUT') continue
    if (String(t.stream || '').toUpperCase() !== 'LIVE') continue
    const { state, ageMinutes, reason } = classifyEdiDelivery(t, now)
    if (state === 'ok') continue
    const kind = kindOf(t.type)
    // A stuck document whose reference already landed is a superseded copy. Note
    // this asks about OTHER copies of the same reference, not this row's own
    // status — `landed` is built from the whole set, and a stuck row can never be
    // its own twin because it isn't DELIVERED.
    const superseded = state === 'stuck' && !!t.businessNumber && landed.has(`${kind}|${t.businessNumber}`)
    const row = {
      id: t.id, kind, type: t.type,
      businessNumber: t.businessNumber, partner: t.tradingPartner,
      deliveryStatus: t.deliveryStatus, ackStatus: t.acknowledgmentStatus,
      createdAt: t.createdAt, reason,
      ageDays: ageMinutes === null ? null : Math.floor(ageMinutes / 1440),
      // Why it landed in this bucket, so a row can explain itself in the UI.
      supersededBy: superseded ? t.businessNumber : null,
    }
    const bucket = state === 'refused' ? refused
      : state === 'in_flight' ? inFlight
      : superseded ? resent : unannounced
    bucket[kind].push(row)
  }

  const byAge = (a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)
  for (const bucket of [unannounced, resent, refused, inFlight]) {
    for (const k of Object.keys(bucket)) bucket[k].sort(byAge)
  }

  // `stuck` is preserved as the union so nothing that asked "what is sitting in
  // Orderful" silently changes meaning. ⚠️ It is the WRONG number for an exposure
  // chip — that is what this whole split exists to fix. Use `unannounced`.
  const stuck = {
    asn: [...unannounced.asn, ...resent.asn].sort(byAge),
    invoice: [...unannounced.invoice, ...resent.invoice].sort(byAge),
    other: [...unannounced.other, ...resent.other].sort(byAge),
  }

  return {
    unannounced,
    resent,
    stuck,
    refused,
    inFlight,
    counts: {
      // The honest exposure pair — what the court strip reads.
      asnUnannounced: unannounced.asn.length, invoiceUnannounced: unannounced.invoice.length,
      // …counted by distinct reference too, because two stuck copies of one
      // invoice is one invoice to chase.
      asnUnannouncedRefs: distinctRefs(unannounced.asn),
      invoiceUnannouncedRefs: distinctRefs(unannounced.invoice),
      // Superseded copies. Hygiene, never exposure.
      asnResent: resent.asn.length, invoiceResent: resent.invoice.length,
      asnResentRefs: distinctRefs(resent.asn), invoiceResentRefs: distinctRefs(resent.invoice),
      // Totals sitting in Orderful, for the "what's in the queue" question only.
      asnStuck: stuck.asn.length, invoiceStuck: stuck.invoice.length,
      asnRefused: refused.asn.length, invoiceRefused: refused.invoice.length,
      asnInFlight: inFlight.asn.length, invoiceInFlight: inFlight.invoice.length,
    },
    // The single most urgent thing: the oldest ASN whose shipment the partner was
    // never told about. A superseded copy can never take this slot — it would
    // name a shipment that actually arrived announced.
    oldestAsnStuck: unannounced.asn[0] || null,
  }
}
