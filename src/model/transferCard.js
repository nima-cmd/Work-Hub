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
import { receiptState } from './transferReceipt.js'

/**
 * Which stage a transfer is at, by the same evidence a sales order is judged on.
 *
 * ⚠️ Deliberately DOES NOT use the transfer's own status except for RECEIVED, which is
 * the one thing it genuinely knows and we cannot see any other way.
 */
export function transferStage({ ifNumber, ifStatus, toStatus, receipt = null } = {}) {
  if (!ifNumber) return STAGE.OPEN          // nothing picked yet — this is the pick signal
  // ⚠️ An ENTERED receipt counts here exactly as NetSuite's does. The far end often
  // never confirms (Nima: "sometimes they dont receive on their end"), and a transfer
  // a human has confirmed arrived is not still in flight.
  if (receiptState({ toStatus, receipt }).settled) return STAGE.SHIPPED
  if (isReceived(toStatus)) return STAGE.SHIPPED
  if (/shipped/i.test(String(ifStatus || ''))) return STAGE.SHIPPED
  if (/packed/i.test(String(ifStatus || ''))) return STAGE.PACKED
  return STAGE.PICKED
}

/**
 * The one thing to do next. ⚠️ Names the DESTINATION, because that is the shipment.
 *
 * ⚠️ A TRANSFER IS NEVER INVOICED AND NEVER PAID (Nima, 2026-08-27: "no payment
 * invoice needed for transfer orders so once they have a label they can ship"). It
 * moves our own goods between our own locations — there is nobody to bill.
 *
 * That is not a detail of wording. A sales order at PACKED is told to "Invoice /
 * progress it" and then to "Follow up on payment", and a transfer inheriting those
 * would put two steps in front of Nima that DO NOT EXIST for this document — work
 * invented by a shared enum. Its life is:
 *
 *     pick → pack → label → ship → confirm receipt
 *
 * with INVOICED and APPROVED_FOR_SHIPPING skipped entirely.
 */
export function transferNextAction({ ifNumber, ifStatus, toStatus, destination, tracking = [], receipt = null } = {}) {
  const stage = transferStage({ ifNumber, ifStatus, toStatus, receipt })
  if (stage === STAGE.OPEN) return `Pick it — transfer to ${destination || 'an unnamed location'}`
  // ⚠️ Once a human has answered, stop asking. A card still saying "chase the receipt"
  // after he entered the receipt is the board arguing with the person using it.
  if (receiptState({ toStatus, receipt }).settled) return NEXT_ACTION[STAGE.SHIPPED]
  if (stage === STAGE.SHIPPED && !isReceived(toStatus)) {
    // ⚠️ Shipped is not finished for a transfer. The far end confirming is a separate
    // event that Nima says does not always happen, and it is the whole reason he
    // wanted these tracked.
    return 'Sent — chase the receipt at the far end'
  }
  if (stage === STAGE.SHIPPED) return NEXT_ACTION[STAGE.SHIPPED]
  // ⚠️ PICKED and PACKED both lead to the label, never to an invoice. The label is the
  // ONLY thing standing between a packed transfer and the door.
  const labelled = (tracking || []).filter(Boolean).length > 0
  if (stage === STAGE.PACKED) {
    return labelled ? 'Ship it out — no invoice needed' : 'Make the label — then it can ship'
  }
  return NEXT_ACTION[STAGE.PICKED]   // 'Pack it'
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
  const { toNumber, destination, toStatus, ifNumber, ifStatus, ifDate, tracking = [], receipt = null } = t
  if (!toNumber) return null
  const stage = transferStage({ ifNumber, ifStatus, toStatus, receipt })
  // What is known about its arrival, from NetSuite AND from anything entered by hand.
  const arrival = receiptState({ toStatus, receipt })
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
    // ⚠️ Carried so a surface can say WHY a packed transfer is waiting. There is no
    // invoice to wait on, so the label is the only possible answer.
    labelled: (tracking || []).filter(Boolean).length > 0,
    stage,
    stageLabel: stage === STAGE.OPEN
      ? `Transfer — pick for ${destination || 'an unnamed location'}`
      : STAGE_LABEL[stage],
    stageRank: STAGE_RANK[stage],
    nextAction: transferNextAction({ ifNumber, ifStatus, toStatus, destination, tracking, receipt }),
    toStatus: toStatus || null,
    // ⚠️ `received` MEANS THE GOODS ARE THERE. A written-off transfer is settled and
    // NOT received — saying otherwise would be a lie in the one record that exists to
    // catch stock that never arrived.
    received: arrival.received,
    settled: arrival.settled,
    receipt: arrival.entered
      ? { outcome: receipt.outcome, receivedOn: arrival.on, note: arrival.note }
      : null,
    fulfillments: ifNumber
      ? [{ ifNumber, status: ifStatus || null, ifDate: ifDate || null, trackingNumbers: tracking || [], settled: arrival.settled }]
      : [],
  }
}

/** ⚠️ The pick list is transfers with NO fulfilment — never the ones whose STATUS says pending. */
export const needsPicking = (cards = []) => cards.filter((c) => c.stage === STAGE.OPEN)
