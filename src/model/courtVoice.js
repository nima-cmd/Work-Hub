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
export const COURT_VOICE_ID = 'poe-dameron'   // speaks for Nima's own queue
export const WAREHOUSE_VOICE_ID = 'din-djarin' // stands in for the warehouse side

// Which lane to speak about, most-worth-starting-with first. Ordered by how
// directly Nima can finish it: a label is his hands, an ASN is a re-send, a
// stuck invoice is someone else's process. Deliberately NOT ordered by count —
// "61 invoices never sent" would drown out the 4 labels every single day.
const PRIORITY = ['needsLabel', 'markShipped', 'freight', 'canShip', 'needsInvoice', 'asnStuck', 'invoiceStuck']

// One line per lane. `n` is that lane's count; the phrasing has to read for
// n === 1 as well, so no bare plurals.
const LINE = {
  needsLabel: (n) => `${n === 1 ? 'One parcel needs' : `${n} parcels need`} a label — that's the quickest win on the board.`,
  markShipped: (n) => `${n === 1 ? 'One shipment has' : `${n} shipments have`} tracking but NetSuite hasn't been told. Quick clicks.`,
  freight: (n) => `${n} freight ${n === 1 ? 'shipment is' : 'shipments are'} waiting on routing — Routing has them lined up.`,
  canShip: (n) => `${n === 1 ? 'One order is' : `${n} orders are`} cleared to go. Nice work getting them here.`,
  needsInvoice: (n) => `${n === 1 ? 'One packed order needs' : `${n} packed orders need`} an invoice before it can move.`,
  asnStuck: (n) => `${n} ASN${n === 1 ? '' : 's'} never reached the partner — worth clearing before they chargeback.`,
  invoiceStuck: (n) => `${n} invoice${n === 1 ? '' : 's'} never went out. That's money not yet asked for.`,
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
  return n === 1 ? "Got one of ours — he'll bring it back." : `Got ${n} of ours — they're covered.`
}
