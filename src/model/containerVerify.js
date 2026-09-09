// src/model/containerVerify.js — did the import do what we expected?
//
// Nima, 2026-09-09, on why the packing slip moved into Work-Hub: "with this in the
// app we can check if we over-received if the import did anything weird or if it
// didn't do what we expected."
//
// This is that check. It is the only thing here that can be done at all, because it
// needs BOTH sides: the slip says what shipped, NetSuite says what was received and
// moved, and nothing else holds the two together.
//
// ⚠️ THE PAIRING NEEDS NO STORED LINK. Both External IDs are DERIVED from the
// container label, so a receipt and its transfer find each other by recomputation:
//
//     EXT-IR-<label><poDigits>   the Item Receipt
//     EXT-<label><poDigits>      the Transfer Order
//
// ⚠️ WHICH IS ALSO WHY A WRONG LABEL IS INVISIBLE UNTIL EXACTLY HERE. On 2026-09-09
// a container was imported as `11 Air 1820 1777 air list carton 2026.9.7` — the
// filename stem, and the wrong date. Both files imported perfectly. Nothing was
// wrong except the name, and the only symptom would have been this screen reporting
// two orphans. So a MISSING leg means "no record found under the key we compute",
// never "nothing happened" — the wording matters, and the two hand-made external ids
// in this account (`EXT-po1747 Preorder Item`, `EXT-PO1616Transfer`) prove records
// exist that this scheme cannot see.

import { containerLabel } from './containerIdentity.js'
import { toPoFull } from './itemReceiptCsv.js'

/** The two keys a container's PO should have produced in NetSuite. */
export function expectedKeys(container, poNumber) {
  const label = containerLabel(container)
  const digits = String(poNumber ?? '').replace(/^PO/i, '')
  return { itemReceipt: `EXT-IR-${label}${digits}`, transfer: `EXT-${label}${digits}` }
}

/**
 * ⚠️ A TRANSFER ORDER THAT EXISTS HAS NOT MOVED ANYTHING. It is a document with a
 * workflow — imported at `Pending Fulfillment`, it has to be fulfilled and then
 * received before a single unit leaves China. Three of this account's transfer
 * orders have been sitting unfinished for weeks, and on 2026-09-09 a container's
 * whole 150 units stayed in China behind exactly this.
 *
 * So "found" is not the question. `landed` is.
 */
export const TRANSFER_LANDED = /received/i
export const TRANSFER_IN_FLIGHT = /pending|partially/i

export function transferState(status) {
  const s = String(status || '')
  if (!s) return { landed: false, inFlight: false, note: 'status unknown' }
  if (/closed/i.test(s)) return { landed: false, inFlight: false, note: 'closed without receiving' }
  if (TRANSFER_LANDED.test(s)) return { landed: true, inFlight: false, note: null }
  if (TRANSFER_IN_FLIGHT.test(s)) {
    return { landed: false, inFlight: true, note: 'imported but never fulfilled/received — the units have not moved' }
  }
  return { landed: false, inFlight: false, note: `unrecognised status: ${s}` }
}

/**
 * Compare one stored container against what NetSuite holds.
 *
 * @param container  a stored slip: containerNum, containerDate, skuTotals[]
 * @param found      { byExternalId: Map(externalid -> {tranid, type, status, lines[]}) }
 *                   lines are { sku, qty } — RECEIPT lines only; see the note below.
 * @returns per-PO legs plus the container-level verdict
 */
export function verifyContainer(container, found = {}) {
  const byId = found.byExternalId instanceof Map
    ? found.byExternalId
    : new Map(Object.entries(found.byExternalId || {}))

  // Slip quantities per PO+SKU — what SHOULD have been received.
  const shippedByPo = new Map()
  for (const l of container.skuTotals || []) {
    const po = toPoFull(l.poNumber)
    const m = shippedByPo.get(po) ?? new Map()
    m.set(l.sku, (m.get(l.sku) ?? 0) + Number(l.units || 0))
    shippedByPo.set(po, m)
  }

  const legs = []
  for (const po of [...shippedByPo.keys()].sort()) {
    const shipped = shippedByPo.get(po)
    const keys = expectedKeys(container, po)
    const ir = byId.get(keys.itemReceipt) || null
    const tr = byId.get(keys.transfer) || null
    const state = tr ? transferState(tr.status) : { landed: false, inFlight: false, note: null }

    // ⚠️ QUANTITIES ARE COMPARED ON THE RECEIPT ONLY, and deliberately not on the
    // transfer. A Transfer Order writes THREE lines per item (two negative at the
    // source, one positive at the destination), so any naive sum over its lines
    // triples or cancels — the same trap already recorded for the EDI carton check.
    const discrepancies = []
    if (ir) {
      const got = new Map((ir.lines || []).map((l) => [l.sku, Number(l.qty || 0)]))
      for (const [sku, qty] of shipped) {
        const g = got.get(sku)
        if (g == null) discrepancies.push({ sku, shipped: qty, received: 0, kind: 'not on the receipt' })
        else if (g !== qty) discrepancies.push({ sku, shipped: qty, received: g, kind: g > qty ? 'over-received' : 'short' })
      }
      for (const [sku, qty] of got) {
        if (!shipped.has(sku)) discrepancies.push({ sku, shipped: 0, received: qty, kind: 'received but not on the slip' })
      }
    }

    legs.push({
      poNumber: po,
      units: [...shipped.values()].reduce((a, b) => a + b, 0),
      expected: keys,
      itemReceipt: ir ? { tranid: ir.tranid, status: ir.status ?? null } : null,
      transfer: tr ? { tranid: tr.tranid, status: tr.status ?? null, ...state } : null,
      discrepancies,
      // ⚠️ THE THREE STATES THAT ARE NOT "FINE", named separately because they need
      // different actions. A missing receipt means the import never ran; a missing
      // transfer means the units are received and stranded in China; an unfulfilled
      // transfer means the paperwork exists and the stock still has not moved — the
      // one that looks done from every angle except this one.
      problem: !ir ? 'no item receipt'
        : !tr ? 'received, never transferred — the units are still in China'
        : !state.landed ? (state.note || 'transfer has not landed')
        : discrepancies.length ? 'quantities disagree with the slip'
        : null,
    })
  }

  const problems = legs.filter((l) => l.problem)
  return {
    containerLabel: containerLabel(container),
    poCount: legs.length,
    units: legs.reduce((a, l) => a + l.units, 0),
    legs,
    problems,
    // "Complete" means every PO received, transferred, AND the transfer landed —
    // not merely that four records exist.
    complete: problems.length === 0,
  }
}
