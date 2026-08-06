// src/model/labelRecordCheck.js — a label was bought in ShipStation; did the tracking
// number and the freight figure get RECORDED in NetSuite? (Nima, 2026-08-06)
//
// "we just need to make sure theres a check if a shipstation label is created to make
//  sure the tracking number and price is available on the IF and invoice more
//  importantly."
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Moving boutique labels to ShipStation buys third-party billing and rate shopping,
// and costs one MANUAL STEP: the tracking number and the freight figure have to be
// typed into NetSuite, because nothing writes them back (a write-back needs
// 'Transactions -> Fulfill Sales Orders' at EDIT, which would let this read-only
// integration fulfil orders — deliberately declined).
//
// A manual step that can be skipped is the same defect class as the 28 fulfilments
// that were never scanned: work genuinely done, never recorded, and invisible because
// no surface compares the two systems. Proven the day this was written — IF7451 had
// its tracking entered (1ZC6J610…) and its freight figure left at 0 while ShipStation
// had charged $31.44.
//
// ── ⚠️ A $0 SHIPMENT IS NOT A MISSING FIGURE ────────────────────────────────
//
// 19 of the 20 labels bought so far cost Naghedi **nothing** — the EDI cartons bill
// third-party to Macy's, which is exactly what is supposed to happen. Demanding a
// freight figure on those would invent 19 items of work that must never be done, the
// same mistake `FOB_PICKUP` was created to undo in labelGap.js. So a zero cost is a
// COMPLETE answer, not an absent one.
//
// ── THE INVOICE MUST EQUAL WHAT THE CARRIER CHARGED ─────────────────────────
//
// Nima, 2026-08-06, asked directly: *"we want to charge the customer what were charged
// exactly."* So freight is passed through at cost — no markup — and the invoice figure
// is checkable against `shipmentCost`, not merely checkable for presence.
//
// ⚠️ This was written the other way an hour earlier, deliberately: presence only,
// because a marked-up figure would have made every row a false mismatch and there was
// no way to tell markup from error. The rule changed because the ANSWER arrived, not
// because the first version was careless — and if the pricing policy ever changes back,
// this is the paragraph to revisit.
//
// ⚠️ MULTI-BOX SUMS. One invoice covers a fulfilment, and a fulfilment can carry several
// labels (IF7443 has two). So the expected figure is the SUM of that fulfilment's live
// labels, never one of them — comparing against a single carton would under-bill every
// multi-box shipment.
//
// ── THE INVOICE IS THE PRIORITY, BUT IT CANNOT PRECEDE ITSELF ───────────────
//
// He said the invoice matters most. An invoice that does not exist yet is not a
// failure to record — it is a step that has not arrived. `AWAITING_INVOICE` keeps it
// visible without nagging, the same due/backlog reasoning as the filing split.

export const RECORD_GAP = {
  OK: 'OK',                             // tracking recorded, and the figure is settled
  VOIDED: 'VOIDED',                     // a voided label records nothing — not work
  TRACKING_MISSING: 'TRACKING_MISSING', // NetSuite has no tracking at all on the IF
  TRACKING_MISMATCH: 'TRACKING_MISMATCH', // it has tracking, but not THIS shipment's
  AWAITING_INVOICE: 'AWAITING_INVOICE', // there is a cost to record and no invoice yet
  COST_MISSING: 'COST_MISSING',         // the invoice exists and carries no figure
  COST_MISMATCH: 'COST_MISMATCH',       // the invoice figure isn't what the carrier charged
}

// Freight is passed through at cost, so a cent is a real difference — but floating
// point is not. Compare to the cent.
export function sameMoney(a, b) {
  return Math.round(Number(a || 0) * 100) === Math.round(Number(b || 0) * 100)
}

// Two tracking numbers are the same shipment if they match once case and separators
// are set aside — a pasted number sometimes arrives spaced or lowercased.
export function sameTracking(a, b) {
  const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const x = norm(a), y = norm(b)
  return !!x && x === y
}

// `ssTracking`  — the tracking number ShipStation issued.
// `ssCost`      — what the carrier charged US. 0 (or null) means somebody else paid.
// `voided`      — a voided label keeps its tracking number and its row; it records nothing.
// `nsTracking`  — every tracking number on the NetSuite fulfilment (multi-box is normal:
//                 IF7443 carries two).
// `invoiceNumber`       — null until the invoice is raised.
// `invoiceShippingCost` — the figure on that invoice, if any.
export function labelRecordGap({
  ssTracking, ssCost = 0, voided = false,
  nsTracking = [], invoiceNumber = null, invoiceShippingCost = null,
} = {}) {
  const gap = (kind, reason, extra = {}) => ({ kind, ok: false, reason, ...extra })

  if (voided) return { kind: RECORD_GAP.VOIDED, ok: true, reason: 'label voided — nothing to record' }
  if (!ssTracking) return { kind: RECORD_GAP.VOIDED, ok: true, reason: 'no label bought yet' }

  // ① The tracking number. Checked first because it is the thing every downstream
  // surface reads — the ASN, the mark-shipped signal, the customer's answer.
  const list = (Array.isArray(nsTracking) ? nsTracking : [nsTracking]).filter(Boolean)
  if (!list.length) {
    return gap(RECORD_GAP.TRACKING_MISSING,
      `enter tracking ${ssTracking} on the fulfilment`, { enter: ssTracking })
  }
  if (!list.some((t) => sameTracking(t, ssTracking))) {
    return gap(RECORD_GAP.TRACKING_MISMATCH,
      `fulfilment has ${list.join(', ')} but this label is ${ssTracking}`, { enter: ssTracking })
  }

  // ② The freight figure — only when there IS one. See the header: a $0 shipment
  // (third-party billed) is a complete answer, so the walk stops here.
  const cost = Number(ssCost || 0)
  if (!(cost > 0)) {
    return { kind: RECORD_GAP.OK, ok: true, reason: 'tracking recorded · billed to a third party, no figure to enter' }
  }
  if (!invoiceNumber) {
    return gap(RECORD_GAP.AWAITING_INVOICE,
      `tracking recorded · $${cost.toFixed(2)} to record once the invoice is raised`, { enter: cost })
  }
  if (invoiceShippingCost == null || Number(invoiceShippingCost) === 0) {
    return gap(RECORD_GAP.COST_MISSING,
      `${invoiceNumber} carries no freight figure — ShipStation charged $${cost.toFixed(2)}`, { enter: cost })
  }
  if (!sameMoney(invoiceShippingCost, cost)) {
    const billed = Number(invoiceShippingCost)
    const delta = billed - cost
    return gap(RECORD_GAP.COST_MISMATCH,
      `${invoiceNumber} bills $${billed.toFixed(2)} but the carrier charged $${cost.toFixed(2)}`
      + ` (${delta > 0 ? 'over' : 'under'} by $${Math.abs(delta).toFixed(2)})`,
      { enter: cost })
  }
  return { kind: RECORD_GAP.OK, ok: true,
    reason: `tracking recorded · ${invoiceNumber} bills $${cost.toFixed(2)}, matching the carrier` }
}

// Roll a set of per-shipment verdicts into the counts a surface can show. Kept as
// separate kinds rather than one total — each names a different action (the
// never-lump rule), and AWAITING_INVOICE is a wait, not a task.
export function summarizeLabelRecords(verdicts = []) {
  const counts = { ok: 0, trackingMissing: 0, trackingMismatch: 0, awaitingInvoice: 0, costMissing: 0, costMismatch: 0, voided: 0 }
  for (const v of verdicts) {
    if (v.kind === RECORD_GAP.OK) counts.ok++
    else if (v.kind === RECORD_GAP.VOIDED) counts.voided++
    else if (v.kind === RECORD_GAP.TRACKING_MISSING) counts.trackingMissing++
    else if (v.kind === RECORD_GAP.TRACKING_MISMATCH) counts.trackingMismatch++
    else if (v.kind === RECORD_GAP.AWAITING_INVOICE) counts.awaitingInvoice++
    else if (v.kind === RECORD_GAP.COST_MISSING) counts.costMissing++
    else if (v.kind === RECORD_GAP.COST_MISMATCH) counts.costMismatch++
  }
  // What needs a keystroke NOW — deliberately excludes awaitingInvoice.
  counts.actionable = counts.trackingMissing + counts.trackingMismatch + counts.costMissing + counts.costMismatch
  return counts
}
