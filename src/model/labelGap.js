// src/model/labelGap.js — what a packed-but-not-shipped fulfilment actually needs.
//
// Extracted from server/queries.js on 2026-08-04. It had been an inline ternary
// in the query layer, which meant the ONE thing that decides whether the court
// strip nags or stays quiet had no test — and it was wrong twice in one day:
//
//   1. `labelled ? 'LABELLED_NOT_SHIPPED' : …` accused Nima of forgetting to mark
//      shipments shipped that were deliberately parked awaiting payment (PR #47:
//      2 of 2 live flags false — a label is printed at PACK time, so tracking is
//      not evidence of departure).
//   2. The fix for that then tested `heldForPayment` FIRST, which swallowed the
//      opposite case: a payment-held shipment with no label read as "correctly
//      parked" when the label was still outstanding. It silenced the oldest real
//      item on the board (IF7414, $90,654 owed, 6 days, zero labels).
//
// THE ORDERING IS THE WHOLE THING, and it comes from Nima's flow (2026-08-04):
// "a label is created, the next step is the creation of an invoice, and then after
// we need to know if we can ship it."
//
// So the sequence is DOCUMENT → INVOICE → SHIP DECISION, and this classifier
// walks it in that order: the outstanding document wins, because it is the earlier
// step and it is work regardless of what payment is doing. Payment only decides
// the fate of a shipment whose label already exists.

// The five outcomes, deliberately kept as separate kinds rather than one backlog
// (the never-lump rule): each names a DIFFERENT action, and summing them produces
// a number nobody can act on.
export const LABEL_GAP = {
  NEEDS_LABEL: 'NEEDS_LABEL',                 // parcel, no label → make it
  FREIGHT_BOL_LANE: 'FREIGHT_BOL_LANE',       // freight, moves on a BOL, not a label
  FOB_PICKUP: 'FOB_PICKUP',                   // sits in China awaiting collection
  NEEDS_INVOICE: 'NEEDS_INVOICE',             // labelled, but step 2 isn't done yet
  HELD_FOR_PAYMENT: 'HELD_FOR_PAYMENT',       // labelled and ready; money is what's left
  LABELLED_NOT_SHIPPED: 'LABELLED_NOT_SHIPPED', // it left; NetSuite wasn't told
}

// `labelled` = carries at least one carrier tracking number.
// `lane`     = 'parcel' | 'freight' | 'fob'.
//              • freight — EDI partners move LTL under a BOL and will never carry
//                a parcel tracking number, so listing them as needing a label was
//                pure noise (12 of the first 16 hits).
//              • fob — the goods are in CHINA awaiting a pickup, confirmed by our
//                China warehouse and coordinated by someone in the NY office
//                (Nima, 2026-08-04). We never dispatch it, so we never make its
//                label: measured live, 12 of 12 China fulfilments carry ZERO
//                tracking numbers and 11 of them have already shipped. Calling
//                this "needs a label" invented work that will never be done —
//                and it put the single largest number on the board ($90,654,
//                IF7414) at the top of the wrong queue.
// `heldForPayment` = the DERIVED payment gate (src/model/paymentGate.js), which
//              includes the NY waiver.
// `invoiced` = the fulfilment carries an invoice number.
//
// ⚠️ THE SEQUENCE HAS TO BE WALKED ALL THE WAY, and this was the fifth time that
// lesson cost something (2026-08-05). The labelled branch jumped straight to a ship
// decision, so a parcel that had been labelled but NOT YET INVOICED read as
// "it left; NetSuite wasn't told". Live that morning it was **9 of 9 wrong**: every
// one was `Packed`, carried 1–2 real tracking numbers, had NO invoice, and had not
// shipped. Acting on it would have marked nine orders Shipped with no invoice
// raised — worse than a merely noisy chip.
//
// And those same nine were ALSO counted under the strip's "need an invoice", so two
// chips gave opposite advice about one set of shipments — precisely the defect
// PR #48 fixed one step earlier in the flow. Nima's order is
// LABEL → INVOICE → SHIP DECISION, so each step must be asked in that order, and a
// step that isn't done yet stops the walk.
export function labelGapKind({ labelled, lane, heldForPayment, invoiced } = {}) {
  if (!labelled) {
    if (lane === 'freight') return LABEL_GAP.FREIGHT_BOL_LANE
    if (lane === 'fob') return LABEL_GAP.FOB_PICKUP
    return LABEL_GAP.NEEDS_LABEL
  }
  // Freight has no parcel label to begin with, so it never reaches here; for the
  // parcel lane the invoice is the next step after the label.
  if (!invoiced) return LABEL_GAP.NEEDS_INVOICE
  return heldForPayment ? LABEL_GAP.HELD_FOR_PAYMENT : LABEL_GAP.LABELLED_NOT_SHIPPED
}

const money = (n) => `$${Number(n).toLocaleString()}`

// The sentence shown on the row. Derived from the SAME call as the kind so the two
// cannot drift apart — a row whose label says one thing while its chip counts it
// under another is how the previous two versions of this went unnoticed.
export function labelGapNeeded({
  labelled, lane, heldForPayment, invoiced, ifNumber, invoiceNumber, invoiceTerms,
  amountRemaining, labelCount = 0,
} = {}) {
  const kind = labelGapKind({ labelled, lane, heldForPayment, invoiced })
  switch (kind) {
    case LABEL_GAP.NEEDS_INVOICE:
      // Names the invoice, and says the label is DONE — otherwise this reads as a
      // step backwards to someone who just printed it.
      return `Labelled (${labelCount}) — now raise the invoice for ${ifNumber}`
    case LABEL_GAP.HELD_FOR_PAYMENT:
      return `Held for payment — ${money(amountRemaining)} owed on ${invoiceNumber} (${invoiceTerms || 'terms unknown'})`
    case LABEL_GAP.LABELLED_NOT_SHIPPED:
      return `Shipped on ${labelCount} label(s) — mark ${ifNumber} shipped in NetSuite`
    case LABEL_GAP.FREIGHT_BOL_LANE:
      return 'Freight/BOL lane — routed on a BOL, not a parcel label'
    case LABEL_GAP.FOB_PICKUP:
      // Names the CONFIRMATION as the action, because that is the only part of
      // this lane anyone here touches — the China warehouse confirms the pickup
      // and the NY office holds the thread. The balance rides along as context
      // (it's the largest on the board) but it is NOT what is being asked for.
      return heldForPayment
        ? `FOB — in China awaiting pickup; confirm with the China warehouse / NY office (${money(amountRemaining)} owed on ${invoiceNumber})`
        : 'FOB — in China awaiting pickup; confirm with the China warehouse / NY office'
    default:
      // The label is named as the action even when payment is also holding the
      // departure, because making it is the next step either way. The balance
      // rides along as CONTEXT so it's clear no departure follows yet.
      return heldForPayment
        ? `Packed with no carrier label — create one for ${ifNumber} (payment still holds the departure: ${money(amountRemaining)} owed on ${invoiceNumber})`
        : `Packed with no carrier label — create one for ${ifNumber}`
  }
}
