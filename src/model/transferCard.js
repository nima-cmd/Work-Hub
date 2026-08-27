// src/model/transferCard.js — a transfer as a card on the board.
//
// Nima, 2026-08-27: "i need to know to pick them too right now we only look at sales
// order" — and, asked whether transfers are picked by someone else: "everything done
// by me." One person, one queue, so transfers belong ALONGSIDE the sales orders rather
// than on a tab of their own.
//
// ⚠️ THE TRANSFER'S OWN STATUS CANNOT TELL YOU WHETHER IT HAS BEEN PICKED. Measured
// 2026-08-27: TO217, TO171 and TO155 all read "Transfer Order : Pending Fulfillment"
// and all three ALREADY have a picked fulfilment — one of them is in ShipStation.
// NetSuite leaves a transfer at Pending Fulfillment until the far end RECEIVES it, so
// creating the fulfilment never advances it. A pick list built on that status would
// hand back three transfers that are already packed. Same shape as orders.ship_date
// and item.baseprice: a field that reads plausibly and means something else.
//
// The honest signal is the ABSENCE OF A FULFILMENT — which is exactly the rule sales
// orders already use (STAGE.OPEN is "no Item Fulfillment yet → create one"). No new
// concept; the same one applied to a second document type.

import { STAGE, STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from './stages.js'
import { isReceived } from './transferOrder.js'

/**
 * Which stage a transfer is at, by the same evidence a sales order is judged on.
 *
 * ⚠️ Deliberately DOES NOT use the transfer's own status except for RECEIVED, which is
 * the one thing it genuinely knows and we cannot see any other way.
 */
export function transferStage({ ifNumber, ifStatus, toStatus } = {}) {
  if (!ifNumber) return STAGE.OPEN          // nothing picked yet — this is the pick signal
  if (isReceived(toStatus)) return STAGE.SHIPPED
  if (/shipped/i.test(String(ifStatus || ''))) return STAGE.SHIPPED
  if (/packed/i.test(String(ifStatus || ''))) return STAGE.PACKED
  return STAGE.PICKED
}

/** The one thing to do next. ⚠️ Names the DESTINATION, because that is the shipment. */
export function transferNextAction({ ifNumber, ifStatus, toStatus, destination } = {}) {
  const stage = transferStage({ ifNumber, ifStatus, toStatus })
  if (stage === STAGE.OPEN) return `Pick it — transfer to ${destination || 'an unnamed location'}`
  if (stage === STAGE.SHIPPED && !isReceived(toStatus)) {
    // ⚠️ Shipped is not finished for a transfer. The far end confirming is a separate
    // event that Nima says does not always happen, and it is the whole reason he
    // wanted these tracked.
    return 'Sent — chase the receipt at the far end'
  }
  return NEXT_ACTION[stage]
}

/**
 * A board card, shaped like the ones getOrders returns so the Kanban can render it
 * without a second code path.
 *
 * ⚠️ `isTransfer` and a null customer are what keep it DISTINGUISHABLE. A transfer
 * sitting anonymously among customer orders is how someone ships one to a customer
 * address, and it is the reason these were kept out of the `orders` table in the first
 * place — the separation has to survive being rendered.
 */
export function transferCard(t = {}) {
  const { toNumber, destination, toStatus, ifNumber, ifStatus, ifDate, tracking = [] } = t
  if (!toNumber) return null
  const stage = transferStage({ ifNumber, ifStatus, toStatus })
  return {
    isTransfer: true,
    soNumber: toNumber,
    // ⚠️ The destination stands in for the customer, and the field is NOT called
    // `customer`: there is no customer, and a surface that reads one would be reading
    // a place name as a company.
    destination: destination || null,
    customer: null,
    location: null,
    poNumber: null,
    source: 'transfer',
    stage,
    stageLabel: stage === STAGE.OPEN
      ? `Transfer — pick for ${destination || 'an unnamed location'}`
      : STAGE_LABEL[stage],
    stageRank: STAGE_RANK[stage],
    nextAction: transferNextAction({ ifNumber, ifStatus, toStatus, destination }),
    toStatus: toStatus || null,
    received: isReceived(toStatus),
    fulfillments: ifNumber
      ? [{ ifNumber, status: ifStatus || null, ifDate: ifDate || null, trackingNumbers: tracking || [], settled: isReceived(toStatus) }]
      : [],
  }
}

/** ⚠️ The pick list is transfers with NO fulfilment — never the ones whose STATUS says pending. */
export const needsPicking = (cards = []) => cards.filter((c) => c.stage === STAGE.OPEN)
