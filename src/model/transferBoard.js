// src/model/transferBoard.js — where a transfer card sits on the Orders tab.
//
// Nima, 2026-08-27: "everything done by me." One person, one queue — so transfers are
// drawn BESIDE the sales orders on tab ①, not on a tab of their own and not scattered
// across the three mission tabs.
//
// ⚠️ WHY THEY DO NOT GO THROUGH `missionTab`. Measured 2026-08-28 against the 14 live
// transfers, routing them through the sales-order tab rules produced two wrong answers
// at once:
//
//   1. THE ORDERS TAB GAINED NOTHING. `missionTab` sends a card to tab ① only when it
//      has no fulfilment. Zero transfers are in that state today (TO217, TO171 and
//      TO155 all have one), so the tab Nima asked for them on would have stayed empty
//      while the cards appeared on two other tabs.
//   2. THREE OF THREE LANDED IN AN ACCUSATION COLUMN. `fulfilledNeverScanned` is true
//      for a picked transfer — no custodyOut, no custodyIn, no DC tag — so all three
//      would have been reported as "Fulfilled — never scanned out". But A TRANSFER IS
//      NEVER CUSTODY-SCANNED: there is no Nestor hand-off, Nima packs it himself. The
//      column would have been false 3 for 3 — the same signature as the 28 false
//      Nordstrom positives that fulfilledNeverScanned already carries a warning about.
//
// So the placement rule is its own, and it is here rather than in the view so it can
// be tested against those cases.

import { STAGE } from './stages.js'

// The transfer's life, in Nima's order: pick → pack → label → ship → confirm receipt.
// INVOICED and APPROVED never occur — a transfer moves our own goods between our own
// locations, so there is nobody to bill (see transferCard.js).
export const TCOL = {
  PICK: 'transfer_pick',
  PACK: 'transfer_pack',
  LABEL: 'transfer_label',
  SHIP: 'transfer_ship',
  RECEIPT: 'transfer_receipt',
  RECEIVED: 'transfer_received',
}

// ⚠️ Every label says "Transfer" out loud. A transfer sitting anonymously among
// customer orders is how someone ships one to a customer address — the same reason
// transferCard sets `isTransfer` and refuses to fill in `customer`.
export const TCOL_LABEL = {
  [TCOL.PICK]: 'Transfer — pick it',
  [TCOL.PACK]: 'Transfer — pack it',
  [TCOL.LABEL]: 'Transfer — make the label',
  [TCOL.SHIP]: 'Transfer — ready to ship',
  [TCOL.RECEIPT]: 'Transfer — chase the receipt',
  [TCOL.RECEIVED]: 'Transfer — received',
}

// Flow order, so the columns read left to right as the work actually happens.
export const TCOL_ORDER = [TCOL.PICK, TCOL.PACK, TCOL.LABEL, TCOL.SHIP, TCOL.RECEIPT, TCOL.RECEIVED]

// Which columns are MINE to move now. The receipt chase is a watch — the far end has
// to act, and Nima says that is exactly the step that gets forgotten, so it is shown
// but never counted as work he can finish at his desk.
export const TCOL_IS_WORK = {
  [TCOL.PICK]: true,
  [TCOL.PACK]: true,
  [TCOL.LABEL]: true,
  [TCOL.SHIP]: true,
  [TCOL.RECEIPT]: false,
  [TCOL.RECEIVED]: false,
}

/**
 * Which column a transfer card belongs in.
 *
 * ⚠️ Keyed on the card's STAGE and its LABEL, never on the transfer's own NetSuite
 * status. NetSuite leaves a transfer at "Pending Fulfillment" until the far end
 * receives it, so that status cannot distinguish picked from unpicked — the whole
 * finding transferCard.js was built on.
 *
 * `received` is the one exception: it is the single thing the TO's status genuinely
 * knows and we cannot observe any other way.
 */
export function transferColumn(card = {}) {
  if (!card || !card.soNumber) return null
  if (card.received) return TCOL.RECEIVED
  if (card.stage === STAGE.SHIPPED) return TCOL.RECEIPT
  if (card.stage === STAGE.OPEN) return TCOL.PICK
  if (card.stage === STAGE.PACKED) return card.labelled ? TCOL.SHIP : TCOL.LABEL
  if (card.stage === STAGE.PICKED) return TCOL.PACK
  // A stage we did not name still gets drawn rather than silently dropped off the
  // board — the same rule the Orders tab's "Other" column exists for.
  return TCOL.PACK
}

/**
 * Build the Orders-tab columns for a set of transfer cards.
 *
 * `showSettled` mirrors the Kanban's own finished-work toggle: a RECEIVED transfer is
 * done, and 7 of the 14 live transfers were received when this landed. Hidden, never
 * discarded — a board that silently drops rows is indistinguishable from one that lost
 * them.
 */
export function transferColumns(cards = [], { showSettled = false } = {}) {
  const byCol = new Map()
  for (const c of cards) {
    const k = transferColumn(c)
    if (!k) continue
    if (k === TCOL.RECEIVED && !showSettled) continue
    if (!byCol.has(k)) byCol.set(k, [])
    byCol.get(k).push(c)
  }
  const columns = []
  for (const k of TCOL_ORDER) {
    const items = (byCol.get(k) || []).sort(bySoNumber)
    if (!items.length) continue
    columns.push({ key: k, label: TCOL_LABEL[k], items, work: TCOL_IS_WORK[k], transfer: true })
  }
  return columns
}

// Oldest transfer first — TO123 has been out 115 days, and the point of showing the
// receipt chase is that the forgotten ones surface, not that the newest do.
function bySoNumber(a, b) {
  const n = (x) => Number(String(x?.soNumber || '').replace(/\D/g, '')) || 0
  return n(a) - n(b)
}

/** How many transfer cards are work Nima can move right now. */
export const transferWorkCount = (cards = []) =>
  cards.filter((c) => TCOL_IS_WORK[transferColumn(c)]).length

/** A received transfer is finished; counted so the board can say how many it is hiding. */
export const transferSettledCount = (cards = []) => cards.filter((c) => c.received).length
