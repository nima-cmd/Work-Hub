// src/model/labelSource.js — WHERE LABELS ARE MADE. One switch, deliberately boring.
//
// Nima, 2026-08-06: *"this is a block on actual work right now lets just keep the
// connection open with the idea that all labels will be made in netsuite for now till
// we sort it out."*
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// NetSuite generates a shipping label whenever it fulfils an order on an integrated
// carrier method. So any order ALSO labelled in ShipStation gets TWO live labels, and
// the NetSuite one owns the fulfilment's tracking field — it cannot be hand-edited,
// only voided, and the void action could not be found. That cost three things in one
// afternoon on IF7453 alone: a duplicate live label on the wholesale account
// (1ZC6J6100302360756 against ShipStation's 1ZC6J6100339338337, $23.56), a save that
// failed with a NetSuite bug ticket, and a locked field with no way out.
//
// NetSuite labels have the property ShipStation's cannot: the tracking number lands on
// the fulfilment automatically, in the `trackingnumber` record every downstream surface
// already reads. So until the void path is understood, NetSuite is the label source.
//
// ⚠️ THE CONNECTION STAYS OPEN. This gates ORDER CREATION only. Everything read-only
// keeps running and stays useful:
//   • sync:shipstation-tracking — harvests tracking + cost for labels already bought
//   • check:label-records       — still guards the 20 existing ShipStation labels
//   • sync:ups-costs            — real billed costs
//   • shipstationRates          — live rate quotes per account
//
// ⚠️ WHAT THIS IS NOT: it is not a claim that ShipStation was the wrong choice. It buys
// third-party billing (IF7405 would have billed us instead of the customer's UPS
// 782847) and rate shopping, and the agreed way back is narrower — push ONLY orders
// whose customer has a third-party account, so the two systems never label the same
// box. That is a decision Nima has not made yet, so it is not encoded here.

// The single source of truth. Flip to 'shipstation' (or pass `force`) to re-enable
// pushing — and read the note above first.
export const LABEL_SOURCE = 'netsuite'

export const PUSH_DISABLED_REASON =
  'Labels are being made in NetSuite (src/model/labelSource.js). Pushing would create a '
  + 'second live label on the same box, and the NetSuite one locks the tracking field. '
  + 'Pass { force: true } only if that has been resolved.'

// `force` is the explicit escape hatch: a caller that has read the reason and means it.
export function pushingAllowed({ force = false, source = LABEL_SOURCE } = {}) {
  return force === true || source === 'shipstation'
}
