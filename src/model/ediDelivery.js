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

// Orderful's terminal-good states.
const DELIVERED = 'DELIVERED'
const ACK_OK = 'ACCEPTED'

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

// Split outbound transactions into the two failures, per document kind.
// transactions: [{ id, type, direction, stream, businessNumber, tradingPartner,
//                  deliveryStatus, acknowledgmentStatus, createdAt }]
export function computeEdiDeliveryGaps(transactions = [], now = new Date()) {
  const stuck = { asn: [], invoice: [], other: [] }
  const refused = { asn: [], invoice: [], other: [] }
  // Reported separately from `stuck`: inside the hand-off window, so not yet a
  // problem — but it IS what someone who just transmitted wants to see, and it's
  // the answer to "did the ASN I just generated actually go?". Watch, don't alarm.
  const inFlight = { asn: [], invoice: [], other: [] }

  for (const t of transactions) {
    // Outbound only — an inbound 850's delivery is the partner's problem — and
    // LIVE only, so the TEST stream can never raise a real alert.
    if (String(t.direction || '').toUpperCase() !== 'OUT') continue
    if (String(t.stream || '').toUpperCase() !== 'LIVE') continue
    const { state, ageMinutes, reason } = classifyEdiDelivery(t, now)
    if (state === 'ok') continue
    const row = {
      id: t.id, kind: kindOf(t.type), type: t.type,
      businessNumber: t.businessNumber, partner: t.tradingPartner,
      deliveryStatus: t.deliveryStatus, ackStatus: t.acknowledgmentStatus,
      createdAt: t.createdAt, reason,
      ageDays: ageMinutes === null ? null : Math.floor(ageMinutes / 1440),
    }
    const bucket = state === 'stuck' ? stuck : state === 'refused' ? refused : inFlight
    bucket[row.kind].push(row)
  }

  const byAge = (a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)
  for (const bucket of [stuck, refused, inFlight]) for (const k of Object.keys(bucket)) bucket[k].sort(byAge)

  return {
    stuck,
    refused,
    inFlight,
    counts: {
      asnStuck: stuck.asn.length, invoiceStuck: stuck.invoice.length,
      asnRefused: refused.asn.length, invoiceRefused: refused.invoice.length,
      asnInFlight: inFlight.asn.length, invoiceInFlight: inFlight.invoice.length,
    },
    // The single most urgent thing: the oldest undelivered ASN. Goods are moving
    // against a partner who was never told.
    oldestAsnStuck: stuck.asn[0] || null,
  }
}
