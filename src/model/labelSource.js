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

// ── THE UNBLOCK, BY LOCATION (Nima, 2026-08-07) ─────────────────────────────
//
// "can we unblock shipstation label for anything no the warehouse location"
//
// This fits the original reason exactly rather than working around it. The
// double-label problem is a WAREHOUSE problem: NetSuite generates a label when it
// fulfils on an integrated carrier method, and that is the Warehouse/boutique
// flow — 36 of its 64 fulfilments already carry NetSuite tracking. The partner
// locations do not auto-label: Bloomingdale's 0 of 95, Nordstrom 0 of 29,
// ShopBop 0 of 1. So off-Warehouse there is no second label to collide with.
//
// ⚠️ TWO MORE STAY BLOCKED, and neither is me overruling him:
//
//   • China — FOB Pending Approval means the goods are in China awaiting
//     collection, confirmed by the China warehouse; we never dispatch it, so we
//     never make its label (0 of 12 ever had one). That is his own rule from
//     2026-08-04, and "not the Warehouse location" would otherwise hand it a
//     label for a box we will never hand to a carrier.
//   • An ABSENT location — a missing field must never be what unblocks a live
//     write. Same direction of failure as SHIP_DETAIL_UNREADABLE in
//     shipstationEligible.js: unknown is held, not assumed.
// Returns the REASON a location may not be pushed, or null when it may. A reason
// string rather than a boolean so the held row can name its own cause instead of
// adding to a count (the never-lump rule).
export function pushBlockedForLocation(location) {
  const s = String(location ?? '').trim()
  if (!s) return 'no location on the order — an absent field must not unblock a live write'
  if (/warehouse/i.test(s)) {
    return 'Warehouse orders are labelled by NetSuite when it fulfils them; pushing would '
      + 'create a second live label on the same box'
  }
  if (/china/i.test(s)) {
    return 'FOB China — the goods await collection there and we never dispatch them, so we '
      + 'never make the label'
  }
  return null
}

// `force` is the explicit escape hatch: a caller that has read the reason and means it.
// `location` opts an order into the off-Warehouse unblock above. A caller that
// passes no location gets the old global behaviour, so nothing silently widens.
export function pushingAllowed({ force = false, source = LABEL_SOURCE, location = undefined } = {}) {
  if (force === true || source === 'shipstation') return true
  if (location === undefined) return false
  return pushBlockedForLocation(location) === null
}
