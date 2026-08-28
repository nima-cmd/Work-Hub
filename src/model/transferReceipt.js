// src/model/transferReceipt.js — did the transfer actually arrive?
//
// Nima, 2026-08-27: "sometimes they dont receive on their end." That is the whole
// reason transfers are tracked: NetSuite's "Received" is the FAR END confirming, and
// when they never do it, the transfer sits open forever and nothing says whether the
// goods are there.
//
// ⚠️ NETSUITE'S STATUS IS EVIDENCE WHEN PRESENT AND EVIDENCE OF NOTHING WHEN ABSENT.
// isReceived (transferOrder.js) already says this: an unreceived transfer may well have
// arrived. This module adds the other half — a human writing down what they know —
// WITHOUT ever inferring it from a status.
//
// ── ⚠️ WHY "Closed" IS NOT AN ANSWER ────────────────────────────────────────
//
// TO191 reads "Transfer Order : Closed" and is the only Closed one of the 14 live
// transfers. Asked directly whether Closed means it arrived, Nima said:
//
//   "im not fully sure closed can be abandoned it could also be partially shippedd
//    and the rest of the units abandoned"
//
// So Closed is TWO different situations wearing one label. Deriving "received" from it
// would mark real goods as arrived when they never shipped; deriving "abandoned" would
// drop a real shipment off the chase list. Both are wrong in the other case, and the
// status cannot distinguish them — only a person can.
//
// This is the same shape as `orders.ship_date` (trandate + 28), `item.baseprice`
// (empty) and the transfer's own "Pending Fulfillment" (which cannot say whether it was
// picked): a field that reads plausibly and means something else. It is in
// fieldAssumptions.js for that reason.
//
// ⚠️ So NOTHING here reads `status` except through isReceived, and `Closed` resolves to
// exactly one thing: STILL UNKNOWN. A person resolves it, and their answer is stored
// where it cannot be mistaken for something NetSuite said.

import { isReceived } from './transferOrder.js'

/** The two things a person can say about a transfer that NetSuite never confirmed. */
export const OUTCOME = {
  // It arrived. `receivedOn` is when — not when it was typed.
  RECEIVED: 'received',
  // Nothing is arriving. Closed out, abandoned, or the remainder of a partial ship.
  // ⚠️ Without this, an abandoned transfer sits on the chase list forever: a column
  // that can be looked at and never cleared.
  NOT_COMING: 'not_coming',
}

export const OUTCOME_LABEL = {
  [OUTCOME.RECEIVED]: 'Received',
  [OUTCOME.NOT_COMING]: 'Nothing coming',
}

export const isOutcome = (v) => v === OUTCOME.RECEIVED || v === OUTCOME.NOT_COMING

/**
 * Validate an entered receipt before it is written.
 *
 * ⚠️ Returns a REASON, never a boolean, so a refusal names its own cause instead of
 * adding to a count (the never-lump rule).
 */
export function validateReceipt({ toNumber, outcome, receivedOn, note } = {}, { today = null } = {}) {
  if (!String(toNumber || '').trim()) return 'a transfer number is required'
  if (!isOutcome(outcome)) return `outcome must be '${OUTCOME.RECEIVED}' or '${OUTCOME.NOT_COMING}'`
  const d = String(receivedOn || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'a date is required, as YYYY-MM-DD'
  if (Number.isNaN(Date.parse(d + 'T00:00:00Z'))) return `${d} is not a real date`
  // ⚠️ A future receipt is not a record of anything — it is a plan. `today` is passed
  // in rather than read from the clock so this is testable, the same rule the
  // post-custody states follow.
  if (today && d > today) return `${d} is in the future — a receipt records something that already happened`
  if (note != null && typeof note !== 'string') return 'the note must be text'
  return null
}

/**
 * Has this transfer arrived, given what NetSuite says AND what a human entered?
 *
 * ⚠️ THE ENTERED ANSWER WINS, and only because NetSuite's absence is not a denial. If
 * NetSuite says Received, it arrived. If a person says it arrived, it arrived. If
 * neither says so, we do not know — which is NOT the same as "it did not arrive", and
 * no surface may phrase it that way.
 */
export function receiptState({ toStatus = null, receipt = null } = {}) {
  if (isReceived(toStatus)) {
    return { received: true, settled: true, source: 'netsuite', on: null, note: null, entered: false }
  }
  if (receipt && receipt.outcome === OUTCOME.RECEIVED) {
    return { received: true, settled: true, source: 'entered', on: receipt.receivedOn ?? null, note: receipt.note ?? null, entered: true }
  }
  if (receipt && receipt.outcome === OUTCOME.NOT_COMING) {
    // ⚠️ Settled but NOT received — the goods never arrived and saying otherwise would
    // be a lie in the one record that exists to catch missing stock. It leaves the
    // chase list because there is nothing left to chase, not because it turned up.
    return { received: false, settled: true, source: 'entered', on: receipt.receivedOn ?? null, note: receipt.note ?? null, entered: true }
  }
  return { received: false, settled: false, source: null, on: null, note: null, entered: false }
}

/**
 * What a surface may say about it. ⚠️ Never "not delivered" when nobody has confirmed
 * either way — transferOrder.js's rule, restated where the words are chosen.
 */
export function receiptHeadline({ toStatus = null, receipt = null } = {}) {
  const s = receiptState({ toStatus, receipt })
  if (s.received && s.source === 'netsuite') return 'received — confirmed in NetSuite'
  if (s.received) return `received ${s.on} — entered by hand`
  if (s.settled) return `nothing coming — written off ${s.on}`
  return 'not confirmed received'
}

/** Index entered receipts by transfer number, for joining onto cards. */
export function receiptsByTransfer(rows = []) {
  const m = new Map()
  for (const r of rows) {
    const k = String(r?.toNumber || r?.to_number || '').trim().toUpperCase()
    if (!k) continue
    m.set(k, {
      toNumber: k,
      outcome: r.outcome,
      receivedOn: r.receivedOn ?? r.received_on ?? null,
      note: r.note ?? null,
    })
  }
  return m
}
