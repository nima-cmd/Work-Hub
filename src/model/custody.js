// src/model/custody.js — where a card's goods physically are, from the scan
// ledger. Extracted from client/src/lib.jsx on 2026-08-05.
//
// It moved for one reason: node --test cannot import .jsx, so this function —
// pure logic with no JSX in it — had NEVER had a test, and a live defect duly
// lived here (see the disagreement note below). Same reasoning as
// src/model/labelGap.js, which was pulled out of an untested query-layer
// ternary after being wrong twice in one day.
//
// lib.jsx re-exports it, so every caller is unchanged.

import { dcBreakdown } from './dc.js'

// Physical custody of a pipeline card from the scan ledger (Nima, 2026-07-22):
// is it with the warehouse (scanned OUT, not back), back with us (scanned IN),
// or still with us / not shipped (an Item Fulfillment that's printed but hasn't
// started its journey). EDI cards track their per-DC cartons; others track IFs.
// dcList (routing feed ∪ custody scans, [{ dc }]) is preferred for EDI groups —
// the DC isn't in the order ship-to, so parsing members finds none. Falls back
// to the member parse when no dcList is supplied.
export function cardCustody(card, events = [], dcList) {
  const ediDcs = (dcList && dcList.length ? dcList.map((d) => d.dc) : dcBreakdown(card?.members || []).filter((r) => r.abbrev).map((r) => r.abbrev))
  const dcDocs = ediDcs.map((dc) => ({ type: 'DC', num: `${card.poNumber}:${dc}` }))
  const ifDocs = (card?.fulfillments || []).filter((f) => f.ifNumber).map((f) => ({ type: 'IF', num: f.ifNumber }))
  const hasEvents = (ds) => ds.some((d) => events.some((e) => e.docType === d.type && e.docNumber === d.num))

  // ⚠️ AN EDI SHIPMENT CAN BE SCANNED TWO WAYS, and the board has to honour both
  // (found 2026-08-02). Scan Bay accepts our printed per-DC cargo tag
  // (`DC:<po>:<abbrev>`) AND the NetSuite packing slip's own `IF####` QR — see
  // recordCustodyScan. This used to read DC tokens ONLY for an EDI group, so
  // Bloomingdale's PO 8040313 had all 13 of its fulfilments scanned OUT and the
  // card still read "with us · not shipped" and sat in Picked. The scans were in
  // the ledger the whole time; the card just wasn't looking at them.
  //
  // Whichever evidence the crew actually produced wins, and the denominator
  // follows it so the "3/5" fraction keeps counting the same kind of thing.
  const docs = card?.isGroup && card.source === 'edi'
    ? (hasEvents(dcDocs) || !hasEvents(ifDocs) ? dcDocs : ifDocs)
    : ifDocs
  if (!docs.length) return null
  let out = 0, scanned = 0
  for (const d of docs) {
    const evs = events.filter((e) => e.docType === d.type && e.docNumber === d.num)
    if (!evs.length) continue
    const t = (type) => Math.max(0, ...evs.filter((e) => e.eventType === type).map((e) => +new Date(e.occurredAt)))
    const outT = t('CUSTODY_OUT'), inT = t('CUSTODY_IN')
    if (outT || inT) scanned++
    if (outT > inT) out++
  }

  // ⚠️ WHEN THE EVIDENCE DISAGREES, SAY SO — never pick a side (2026-08-05).
  //
  // Bloomingdale's PO 8040313 read "◫ With Nestor 1/5" all day. Four DC tags
  // were scanned back in on Aug 4; DC CL's never was. Everything since said
  // otherwise — routed, marked shipped, invoiced — and the cartons were in
  // fact on our own floor waiting for a UPS pickup.
  //
  // The tempting fix was "shipped supersedes an unmatched OUT". That is WRONG
  // here and would have been worse: marking shipped is how the Bloomingdale's
  // ASN gets generated, deliberately BEFORE the truck arrives (Nima,
  // 2026-08-05), so it would have reported goods as gone while they sat on the
  // dock — the same mistake the ship-date work already ruled out.
  //
  // We cannot tell a missed scan from cartons genuinely still at Nestor, so the
  // badge stops claiming to know. It names the disagreement and asks for the
  // one thing that settles it: a scan.
  const shippedOnPaper = (card?.fulfillments || []).some((f) => /shipped/i.test(f.status || ''))
  if (out > 0 && shippedOnPaper) {
    return {
      state: 'conflict',
      label: `⚠ Scan gap${docs.length > 1 ? ` ${out}/${docs.length}` : ''} — marked shipped, never scanned back`,
    }
  }

  // Terminology (Nima, 2026-07-22): scanned OUT → "With Nestor"; scanned back
  // IN → "Ball's in our court".
  if (out > 0) return { state: 'warehouse', label: `◫ With Nestor${docs.length > 1 ? ` ${out}/${docs.length}` : ''}` }
  if (scanned > 0) return { state: 'returned', label: "✓ Ball's in our court" }
  return { state: 'idle', label: '🏷 With us · not shipped' }
}
