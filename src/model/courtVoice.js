// src/model/courtVoice.js — the crew's line on the court strip.
//
// Nima, 2026-08-02: replace the "⚑ OUR COURT" label with a crew member who
// tells him what to pick up next, in an encouraging voice, and swap the plain
// "WITH NESTOR" label for a crew member standing in for the warehouse side.
//
// The point is NOT to summarise the strip — the chips already do that, and the
// never-lump rule ([[work-hub-court-strip]]) says a single blended number is
// exactly what this feature exists to undo. This picks ONE thing to start with
// and says it warmly. Everything else stays visible as its own chip.
//
// Pure: no React, no DB, no clock. Nothing here invents a number — it only ever
// repeats a count the strip already has.

// Who plays whom. Both are meant to be swapped freely — the ids just have to
// exist in src/model/characters.js and have art in client/src/assets/characters.
//
// Casting (Nima, 2026-08-02): Jessica Henwick is the standing top pick, and the
// roster carries her four times over — bugs (The Matrix Resurrections),
// colleen-wing, nymeria-sand and jessika-pava are all swap-in candidates here.
// Bugs takes the encouraging seat because that IS her part: the one who finds
// you and tells you what you're capable of. Yor Forger has the warehouse side —
// a protector, which is the "they've got our back" note Nima asked for. His
// other favourites: frieren, fern, anya-forger.
export const COURT_VOICE_ID = 'bugs'          // speaks for Nima's own queue
export const WAREHOUSE_VOICE_ID = 'yor-forger' // stands in for the warehouse side

// Which lane to speak about, most-worth-starting-with first. Ordered by how
// directly Nima can finish it: a label is his hands, an ASN is a re-send, a
// stuck invoice is someone else's process. Deliberately NOT ordered by count —
// "61 invoices never sent" would drown out the 4 labels every single day.
const PRIORITY = ['needsLabel', 'markShipped', 'freight', 'canShip', 'needsInvoice', 'asnUnannounced', 'invoiceUnannounced']

// One line per lane. `n` is that lane's count; the phrasing has to read for
// n === 1 as well, so no bare plurals.
const LINE = {
  needsLabel: (n) => `${n === 1 ? 'One parcel needs' : `${n} parcels need`} a label — that's the quickest win on the board.`,
  markShipped: (n) => `${n === 1 ? 'One shipment has' : `${n} shipments have`} tracking but NetSuite hasn't been told. Quick clicks.`,
  freight: (n) => `${n} freight ${n === 1 ? 'shipment is' : 'shipments are'} waiting on routing — Routing has them lined up.`,
  canShip: (n) => `${n === 1 ? 'One order is' : `${n} orders are`} cleared to go. Nice work getting them here.`,
  needsInvoice: (n) => `${n === 1 ? 'One packed order needs' : `${n} packed orders need`} an invoice before it can move.`,
  // Both lanes only ever fire on shipments/invoices with NO accepted copy at all
  // — superseded re-sends are excluded upstream, so these lines are safe to say
  // out loud. The invoice line deliberately stops at "never went out": whether it
  // was paid by some other route is not something this app can see.
  asnUnannounced: (n) => `${n} shipment${n === 1 ? '' : 's'} the partner was never told about — worth clearing before they chargeback.`,
  invoiceUnannounced: (n) => `${n} invoice${n === 1 ? '' : 's'} never went out to the partner. Worth a look.`,
  // Deliberately NOT in PRIORITY above: the collection happens in China and the
  // thread sits with the NY office, so this must never outrank a lane Nima can
  // finish himself. It only ever speaks when nothing else is on the board.
  fobPickup: (n) => `${n === 1 ? 'One FOB shipment is' : `${n} FOB shipments are`} in China awaiting pickup — NY has the thread.`,
}

// The line the crew member says. `chips` is the strip's own filtered list, so a
// lane that isn't there is genuinely at zero.
export function courtLine(chips = [], oldest = null) {
  if (!chips.length) return "Board's clear. Enjoy it."

  const pick = PRIORITY.map((k) => chips.find((c) => c.key === k)).find(Boolean) || chips[0]
  const line = LINE[pick.key]?.(pick.n) || `${pick.n} ${pick.label}.`

  // An item aging past a week is the one thing allowed to override the lane
  // order — it's the failure this whole strip exists to prevent.
  if (oldest && oldest.ageDays >= 7) {
    return `${oldest.ifNumber} has been sitting ${oldest.ageDays} days — start there, then the rest.`
  }
  return line
}

// What the warehouse-side crew member says about cargo that's out of our hands.
export function warehouseLine(n = 0) {
  if (!n) return ''
  return n === 1 ? "Got one of ours — it's in safe hands." : `Got ${n} of ours — they're in safe hands.`
}
