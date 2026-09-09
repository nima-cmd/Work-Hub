// src/model/importPreflight.js — has this already been imported into NetSuite?
//
// Nima, 2026-09-09: "we want check balacnces we want to make sure we dont doulbe
// import anything we want to make sure were warned if something is off so if there not
// enough units for the item receipt we dont ust fail the receipt and go back and look
// fro the problem."
//
// ⚠️ THE SECOND HALF IS ALREADY BUILT AND IT FIRED TONIGHT. buildItemReceiptCsv
// compares each shipped quantity against REMAINING (ordered minus already received)
// and blocks the file rather than letting NetSuite refuse it. Re-running the 11 air
// container after its receipt was imported produced exactly that: four over-receives,
// `PO1777 SN25013FN-BLUFF: 50 shipped, 0 remaining`. So the receipt cannot silently
// fail for want of units.
//
// ⚠️ BUT AN OVER-RECEIVE IS A CONFUSING WAY TO SAY "YOU ALREADY DID THIS." Those four
// findings had one cause — the receipt was already in NetSuite — and the screen
// described them as four quantity problems. This module asks the question directly,
// by looking for the records the External IDs would have created. Same recomputation
// as containerVerify.js, used earlier: before the download rather than after.

import { expectedKeys } from './containerVerify.js'

/**
 * @param container the parsed or stored slip
 * @param poNumbers its POs
 * @param found     Map(externalId -> { tranid, type }) from fetchContainerRecords
 */
export function importPreflight(container, poNumbers = [], found = new Map()) {
  const byId = found instanceof Map ? found : new Map(Object.entries(found || {}))
  const receipts = []
  const transfers = []
  for (const po of poNumbers) {
    const k = expectedKeys(container, po)
    const ir = byId.get(k.itemReceipt)
    const tr = byId.get(k.transfer)
    if (ir) receipts.push({ poNumber: po, tranid: ir.tranid, externalId: k.itemReceipt })
    if (tr) transfers.push({ poNumber: po, tranid: tr.tranid, externalId: k.transfer })
  }

  const n = poNumbers.length
  return {
    // ⚠️ PARTIAL IS ITS OWN ANSWER, and it is the dangerous one. "Two of four POs
    // already received" is neither a fresh import nor a done one, and a boolean would
    // have to round it to one of those. Tonight's container was exactly this shape at
    // one point: receipts in, transfers not.
    itemReceipt: state(receipts.length, n, 'Item Receipt'),
    transfer: state(transfers.length, n, 'Inventory Transfer'),
    receipts,
    transfers,
    // ⚠️ NOT "nothing happened" — "no record under the key we compute". Two external
    // ids in this account are hand-made (`EXT-po1747 Preorder Item`,
    // `EXT-PO1616Transfer`), so records provably exist that this scheme cannot see —
    // and Inventory Transfers are invisible to this login entirely.
    caveat: 'Absence means no record found under the External ID this container computes, not that nothing was imported.',
  }
}

function state(found, total, what) {
  if (!total) return { status: 'unknown', found: 0, of: 0, message: `no POs on the slip, so nothing to check` }
  if (found === 0) {
    return { status: 'not imported', found, of: total, message: `No ${what} found for this container.` }
  }
  if (found === total) {
    return {
      status: 'already imported', found, of: total,
      message: `The ${what} is ALREADY IN NETSUITE for all ${total} POs. Importing again would duplicate it.`,
    }
  }
  return {
    status: 'partial', found, of: total,
    // Partially imported is the state that needs a human, because the file covers all
    // the POs and only some of them still need it.
    message: `${found} of ${total} POs already have a ${what}. Importing this file again would duplicate those ${found} — do the remaining ${total - found} by hand, or ask why it stopped half way.`,
  }
}

/**
 * Turn the preflight into the one sentence a person needs above a download button.
 *
 * ⚠️ IT REPLACES THE OVER-RECEIVE NOISE RATHER THAN ADDING TO IT. When the receipt is
 * already imported, every SKU reads as an over-receive of its full quantity — four
 * findings with one cause. Saying "you already imported this" once is the useful
 * form; listing the symptoms is what sent me looking for a quantity problem tonight.
 */
export function explainOverReceives(preflight, overReceives = []) {
  if (!overReceives.length) return null
  if (preflight?.itemReceipt?.status === 'already imported') {
    return {
      cause: 'already imported',
      text: `These are not quantity problems. This container's Item Receipt is already in NetSuite (${preflight.receipts.map((r) => r.tranid).join(', ')}), so every unit on the slip reads as received twice. You do not need this file.`,
    }
  }
  if (preflight?.itemReceipt?.status === 'partial') {
    const done = new Set(preflight.receipts.map((r) => String(r.poNumber).replace(/^PO/i, '')))
    const explained = overReceives.filter((o) => done.has(String(o.poNumber).replace(/^PO/i, '')))
    if (explained.length) {
      return {
        cause: 'partially imported',
        text: `${explained.length} of these are explained: those POs already have a receipt (${preflight.receipts.map((r) => r.tranid).join(', ')}). The rest are real quantity problems.`,
        // ⚠️ The unexplained ones are NAMED, not just counted — the whole point is to
        // separate "already done" from "genuinely wrong", and a count leaves the
        // reader to redo the subtraction.
        unexplained: overReceives.filter((o) => !done.has(String(o.poNumber).replace(/^PO/i, ''))),
      }
    }
  }
  return {
    cause: 'quantity',
    text: 'No receipt exists for this container, so these are real: more units shipped than the PO lines have left. Check the slip against the PO before importing anything.',
  }
}
