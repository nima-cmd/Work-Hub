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
// The per-DC cargo-tag documents for a card — `<po>:<abbrev>`, the same tokens
// recordCustodyScan writes for a `DC:<po>:<abbrev>` QR.
//
// ⚠️ EXPORTED so no other surface has to rebuild it. `fulfilledNeverScanned` asked the
// never-scanned question WITHOUT this and reported 28 of 28 Nordstrom fulfilments as
// never handed over while every one had its cargo tag scanned — the identical defect
// scanGap.js was fixed for in PR #74, re-committed independently on the Kanban because
// the rule lived in two places. One source now.
export function dcDocsFor(card, dcList) {
  const ediDcs = (dcList && dcList.length
    ? dcList.map((d) => d.dc)
    : dcBreakdown(card?.members || []).filter((r) => r.abbrev).map((r) => r.abbrev))
  return ediDcs.map((dc) => ({ type: 'DC', num: `${card?.poNumber}:${dc}` }))
}

/**
 * How many of this card's per-DC cargo tags carry a scan, and are they ALL covered?
 *
 * ⚠️ THE LANE RULE: an EDI shipment's custody evidence is the cargo tag stuck on the
 * front page, NOT the IF packing slip. A surface asking only about IF scans reports a
 * correctly-handled Nordstrom shipment as never handed over — measured 2026-08-18,
 * 28 of 28 Nordstrom and 15 of 25 Bloomingdale's fulfilments in the Kanban's
 * "never scanned out" column were false.
 *
 * ⚠️ AND IT MUST BE **ALL**, NOT **ANY** — my own first cut of this used `.some()` and
 * was caught on live data before merge. PO 7242989 had tags scanned for CI, JP and ST
 * but NOT SC, and its ten unscanned fulfilments were all SC: `.some()` excused the whole
 * card and hid ten genuine gaps. Same trap the custody badge already documents ("DC
 * evidence wins once ANY DC scan exists... scan all the DCs, not one") and the reason
 * `cardCustody` reports a 3/5 fraction instead of a boolean.
 *
 * ⚠️ Card-level ON PURPOSE, because a fulfilment's own DC is not reachable here: neither
 * `/api/orders`' order nor its fulfilments carry a `dc`, and `poDcs` is per-PO. The
 * `fulfillment_dc` table exists and would allow the precise per-fulfilment question —
 * that is a projection change (the four-whitelist rule), deliberately not done here.
 * Until then this errs toward SHOWING a card, never toward silence.
 */
export function dcScanCoverage(card, events = [], dcList) {
  if (card?.source !== 'edi') return { total: 0, scanned: 0, complete: false }
  const docs = dcDocsFor(card, dcList)
  const scanned = docs.filter((d) => events.some((e) => e.docType === d.type && e.docNumber === d.num
    && (e.eventType === 'CUSTODY_OUT' || e.eventType === 'CUSTODY_IN'))).length
  return { total: docs.length, scanned, complete: docs.length > 0 && scanned === docs.length }
}

/** Every cargo tag on this card has been scanned — the only state that excuses an IF. */
export function allDcTagsScanned(card, events = [], dcList) {
  return dcScanCoverage(card, events, dcList).complete
}

export function cardCustody(card, events = [], dcList) {
  const dcDocs = dcDocsFor(card, dcList)
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
  // ⚠️ THE RETURNED BRANCH CARRIED NO FRACTION, so a card with two fulfilments and ONE
  // of them scanned back read "✓ Ball's in our court" — the whole card claimed to be
  // home while the second had never been scanned at all (Nima found this on a wrongly
  // grouped boutique PO, 2026-08-06). The warehouse branch above always showed its
  // fraction; this one silently rounded up.
  //
  // An unscanned member is not "back" — it is the never-scanned blind spot at card
  // level, and it must say so rather than borrow its sibling's evidence.
  if (scanned > 0) {
    if (scanned < docs.length) {
      return {
        state: 'partial',
        label: `✓ Back ${scanned}/${docs.length} — ${docs.length - scanned} never scanned`,
      }
    }
    return { state: 'returned', label: "✓ Ball's in our court" }
  }
  return { state: 'idle', label: '🏷 With us · not shipped' }
}

// ── Closing a per-DC cargo tag (2026-08-06) ─────────────────────────────────
//
// ⚠️ THE DC LANE OF THE CUSTODY REGISTER HAD NEVER BEEN CLOSED — NOT ONCE.
// `clearDepartedCustody` writes CUSTODY_CLEARED for `doc_type='IF'` only, and the
// DC half of getCustodyRegister filters on `NOT cleared` with no equivalent of the
// IF half's `actual_ship_date IS NULL` guard. So a cargo tag stayed on the
// register forever after its freight left.
//
// Measured live the day this was written: **41 DC tags, `cleared` false on all 41,
// and 32 of them (78%) belonged to POs whose every IF had shipped** — invoiced,
// 856s delivered, 47/47 cartons announced. They rendered as "back in our hands ·
// sitting 14d with no movement", with no identifier, and the register's headline
// read "52 back in our hands" while most of that was freight long gone. CLAUDE.md
// shape #2: a counter that counts something other than its label.
//
// ── WHY THE UNIT IS THE DC, NOT THE PO ──────────────────────────────────────
//
// One PO fans out to one sales order per store, and the stores are split across
// several DCs — PO 8040313 has tags for CI/CL/HA/SC/ST. Testing "every IF on the
// PO has shipped" would be wrong in BOTH directions: it holds DC SC open because
// DC ST's stores haven't gone, and it clears DC ST the moment the PO happens to
// finish. `orders.dc` carries exactly the abbreviation the tag's doc_number uses
// (verified against all 41 live rows: `8040313:SC` ↔ `dc='SC'`), so the tag can be
// scoped to its own stores.
//
// A tag with an EMPTY abbreviation (`7527086:`) is a PO-level tag printed when no
// DC was known, so the whole PO is its honest scope.
//
// ⚠️ NO MATCHING FULFILMENT MEANS WE CANNOT PROVE A DEPARTURE, so the tag STAYS on
// the register. An empty scope trivially satisfies "every one has shipped", and
// that is exactly how a closing rule silently clears the rows it understands
// least. Departure needs positive evidence, never the absence of a counter-example.
//
// `departedAt` is the LATEST ship date in scope — the day the last store on the
// tag was marked shipped. Same basis the IF lane's CUSTODY_CLEARED already uses.
// ⚠️ It is a keystroke, not an observed departure ([[marked-shipped-is-not-departed]]),
// which is fine for closing a register but is not carrier evidence.
//
// ── ⚠️ PAPERWORK DOES NOT OVERRULE AN UNMATCHED CUSTODY_OUT ──────────────────
//
// `state` is the tag's own scan state ('with_warehouse' | 'returned'). A tag scanned
// OUT and never scanned back is, on the only PHYSICAL evidence there is, still with
// Nestor — and marking the fulfilments shipped is a keystroke that happens BEFORE
// the truck for exactly this partner. Closing such a tag because the paperwork says
// shipped is the precise rule cardCustody above refuses to adopt, and PR #64 caught
// it one surface over; it would have reported goods gone while they sat on the dock.
//
// Caught on live data in this very change: 32 tags qualified on the ship dates, and
// ONE of them (`7527086:`, out since 07-30) was still scanned out. Closing it would
// have destroyed the single most useful thing the register could say about it —
// that a return scan was missed a week ago and nobody noticed. So it stays, and the
// existing conflict badge keeps naming the disagreement. A stale scan gap is a
// signal, not clutter.
export function dcTagDeparture({ docNumber, fulfilments = [], state } = {}) {
  const [poNumber, ...rest] = String(docNumber || '').split(':')
  const abbrev = (rest.join(':') || '').trim() || null

  if (state === 'with_warehouse') {
    return { departed: false, departedAt: null, shipped: 0, total: 0, poNumber, dc: abbrev,
      reason: 'scanned out and never scanned back — a ship date cannot close it' }
  }
  // A PO-level tag owns the whole PO; a per-DC tag owns only its own DC's stores.
  const scope = abbrev ? fulfilments.filter((f) => f.dc === abbrev) : fulfilments.slice()

  if (!scope.length) {
    return { departed: false, departedAt: null, shipped: 0, total: 0, poNumber, dc: abbrev,
      reason: 'no fulfilment matches this tag — cannot prove it left' }
  }
  const dates = scope.map((f) => f.actualShipDate || null)
  const shipped = dates.filter(Boolean).length
  if (shipped < scope.length) {
    return { departed: false, departedAt: null, shipped, total: scope.length, poNumber, dc: abbrev,
      reason: `${scope.length - shipped} of ${scope.length} not marked shipped` }
  }
  const departedAt = dates.reduce((m, d) => (m && new Date(m) >= new Date(d) ? m : d), null)
  return { departed: true, departedAt, shipped, total: scope.length, poNumber, dc: abbrev, reason: null }
}
