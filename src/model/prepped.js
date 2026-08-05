// src/model/prepped.js — "our part is done", recorded WITHOUT telling NetSuite.
//
// Nima, 2026-08-05, describing what happens once an IF is back in our possession:
//
//   "if the label is made outside by us we need to then mark it as packed letting
//    our accounting to know it needs to be invoiced… So marking as packed is what i
//    think we should track… For instance were we can't mark as packed like certain
//    boutique we dont want to invoice early we need an alternative way to track
//    them."
//
// ── Why a separate marker has to exist ──────────────────────────────────────
//
// `Packed` in NetSuite is not just a status — it is the signal to accounting that
// the order should be invoiced. So for an order we deliberately must NOT invoice
// yet, marking packed is the wrong move, and there is then no way to record that
// our own work (label made, carrier arranged) is finished. Those orders sit at
// "back in our possession, not packed" forever and read as neglected when they are
// actually waiting on purpose.
//
// PREPPED is that record. It has NO side effect anywhere — it does not touch
// NetSuite, does not imply an invoice, and does not move a stage. It only says: the
// physical work on this fulfilment is done.
//
// ⚠️ It is NOT "instead of packed". For most orders Nima marks packed and that is
// the tracker, exactly as he said. PREPPED is what carries the cases where packing
// would fire accounting too early — and it is harmless to set on a normal order
// too, which is why it is a plain marker rather than a mode.
//
// ── Per-order, not per-customer, ON PURPOSE ─────────────────────────────────
//
// Nima's call (2026-08-05): "let go per order. and if customer keep recuring we make
// a customer flag." So there is deliberately NO rule here inferring which customers
// invoice late. Inventing that rule would be guessing a business policy from a
// handful of rows — and once the same customers visibly recur, the pattern can be
// promoted to a customer flag from evidence instead of assumption.

export const PREPPED = 'PREPPED'
export const PREP_CLEARED = 'PREP_CLEARED'

// Latest-event-wins, the same shape as CUSTODY_OUT vs CUSTODY_IN. A marker that
// could only ever be set would make a mis-click permanent.
export function isPrepped({ preppedAt, prepClearedAt } = {}) {
  if (!preppedAt) return false
  if (!prepClearedAt) return true
  return new Date(preppedAt) >= new Date(prepClearedAt)
}

// Does this fulfilment still owe us the "mark it packed" nudge?
//
// Back in our hands and NetSuite still says picked → yes, UNLESS we have recorded
// that our part is done, in which case it is held deliberately and must go quiet.
// Quiet, not hidden: the caller still counts and ages it, because "nothing sits
// ignored" outranks "nothing nags me".
export function needsPackNudge({ backInPossession, packedInNetsuite, preppedAt, prepClearedAt } = {}) {
  if (!backInPossession || packedInNetsuite) return false
  return !isPrepped({ preppedAt, prepClearedAt })
}

// The sentence for a held fulfilment. Names the note when Nima left one, because
// "why isn't this packed?" is the whole question a week later.
export function preppedLabel({ ifNumber, note, preppedAt } = {}) {
  const when = preppedAt ? new Date(preppedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
  const why = note ? ` — ${note}` : ''
  return `${ifNumber} prepped${when ? ' ' + when : ''}, held from packing on purpose${why}`
}
