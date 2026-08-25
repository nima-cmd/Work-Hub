// src/model/shipmentEvidence.js — did this PO ship, and what PROVES it?
//
// Nima, 2026-08-25, about PO 7242978: "there was question on if it was shipped i need
// the documents which we scanned and to be able to reference the ASN and 810 we
// shipped … we want a link saying that PO shipped with a link to the documentation to
// prove it and the 856 810 link or document number to back trace as well".
//
// Everything he asked for already existed in the database and in Drive. None of it was
// on screen: the close panel showed a hand-typed note ("856 delivered & accepted") and
// no document numbers, while the app held 4 ASNs, 23 invoices and 5 signed PDFs.
//
// ── ⚠️ EVIDENCE IS GRADED, NOT SUMMED ───────────────────────────────────────
//
// This repo has already paid for treating a weak signal as departure. `DEPARTED` and a
// bought UPS label are NOT evidence the freight left; a custody scan is
// ([[ship-gate-and-ship-date]]). And "marked shipped" in NetSuite is a CLICK — for
// Bloomingdale's it generates the ASN *before* pickup ([[marked-shipped-is-not-departed]]).
//
// So the tiers below are ordered by who attests to what, and the strongest one present
// is what the surface should say. Adding them up, or letting our own record stand alone,
// is how "shipped" stops meaning anything.
//
//   SIGNED_SCAN   a countersigned BOL in Drive        — the carrier took it. Physical.
//   ASN_ACCEPTED  an 856 the partner ACCEPTED         — they acknowledged the notice.
//   INVOICE_ACCEPTED an 810 they accepted             — they accepted the money ask.
//   OUR_RECORD    fulfillments.actual_ship_date       — ⚠️ ours alone. Never proof.
//
// ⚠️ AN ASN THAT IS ONLY *DELIVERED* IS NOT ACCEPTED. Orderful reports the two
// separately, and 62 ASNs once sat DELIVERED-but-unacknowledged with real chargeback
// exposure ([[edi-asn-delivery-gap]]). Delivered means the mailbox took it; accepted
// means the partner's system did.

export const TIER = {
  SIGNED_SCAN: 'SIGNED_SCAN',
  ASN_ACCEPTED: 'ASN_ACCEPTED',
  INVOICE_ACCEPTED: 'INVOICE_ACCEPTED',
  OUR_RECORD: 'OUR_RECORD',
}

// Strongest first. The order IS the policy.
const RANK = [TIER.SIGNED_SCAN, TIER.ASN_ACCEPTED, TIER.INVOICE_ACCEPTED, TIER.OUR_RECORD]

export const TIER_LABEL = {
  [TIER.SIGNED_SCAN]: 'signed BOL on file',
  [TIER.ASN_ACCEPTED]: 'ASN accepted by the partner',
  [TIER.INVOICE_ACCEPTED]: 'invoice accepted by the partner',
  [TIER.OUR_RECORD]: 'our own ship date only',
}

const accepted = (v) => /^accepted/i.test(String(v || ''))

/**
 * @param asns      [{ id, bolNumber, deliveryStatus, ackStatus, at }]
 * @param invoices  [{ id, invoiceNumber, deliveryStatus, ackStatus, at }]
 * @param scans     [{ name, url, dc }]  — filed PDFs from Drive
 * @param shipDates [ISO strings] — fulfillments.actual_ship_date, ours alone
 */
export function shipmentEvidence({ asns = [], invoices = [], scans = [], shipDates = [] } = {}) {
  const asnAccepted = asns.filter((a) => accepted(a.ackStatus))
  const invAccepted = invoices.filter((i) => accepted(i.ackStatus))
  // ⚠️ Delivered-but-not-accepted is called out, never counted. It is the shape that
  // hid 62 undelivered ASNs behind a green-looking status.
  const asnDeliveredOnly = asns.filter((a) => !accepted(a.ackStatus) && /delivered/i.test(String(a.deliveryStatus || '')))

  const have = []
  if (scans.length) have.push(TIER.SIGNED_SCAN)
  if (asnAccepted.length) have.push(TIER.ASN_ACCEPTED)
  if (invAccepted.length) have.push(TIER.INVOICE_ACCEPTED)
  if (shipDates.filter(Boolean).length) have.push(TIER.OUR_RECORD)

  const strongest = RANK.find((t) => have.includes(t)) || null

  // ⚠️ OUR OWN RECORD IS NEVER ENOUGH ON ITS OWN. A ship date we typed is a claim, and
  // this is the surface someone will screenshot to answer "did it go?".
  const proven = !!strongest && strongest !== TIER.OUR_RECORD

  return {
    proven,
    strongest,
    strongestLabel: strongest ? TIER_LABEL[strongest] : null,
    tiers: have,
    // What is missing, said out loud — an absent tier is a fact about the record, not
    // a defect, and a reader deciding whether to chase something needs to see it.
    missing: RANK.filter((t) => !have.includes(t)).map((t) => ({ tier: t, label: TIER_LABEL[t] })),
    counts: {
      asns: asns.length, asnsAccepted: asnAccepted.length, asnsDeliveredNotAccepted: asnDeliveredOnly.length,
      invoices: invoices.length, invoicesAccepted: invAccepted.length, scans: scans.length,
    },
    asnDeliveredOnly,
    // The back-trace: every document number, so the answer is checkable and not a badge.
    backTrace: {
      asns: asns.map((a) => ({ id: a.id, number: a.bolNumber, accepted: accepted(a.ackStatus), at: a.at || null })),
      invoices: invoices.map((i) => ({ id: i.id, number: i.invoiceNumber, accepted: accepted(i.ackStatus), at: i.at || null })),
      scans,
    },
  }
}

/** One line a card can print. ⚠️ Names its BASIS, never a bare "Shipped" — a claim
 *  whose grounds are invisible is the thing this module exists to replace. */
export function evidenceHeadline(e) {
  if (!e) return null
  if (!e.strongest) return 'No shipment evidence on file'
  const c = e.counts
  if (!e.proven) return `Only our own ship date — nothing from the partner or the carrier`
  const bits = []
  if (c.scans) bits.push(`${c.scans} signed document${c.scans === 1 ? '' : 's'}`)
  if (c.asnsAccepted) bits.push(`${c.asnsAccepted} ASN${c.asnsAccepted === 1 ? '' : 's'} accepted`)
  if (c.invoicesAccepted) bits.push(`${c.invoicesAccepted} invoice${c.invoicesAccepted === 1 ? '' : 's'} accepted`)
  return `Shipped — ${bits.join(', ')}`
}
