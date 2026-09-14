// src/model/poLineReconcile.js — did we pack what the PO actually asked for?
//
// Nima, 2026-09-11: "i attached the exxcel file as well which should match the 850
// however i was told by the person who manually put in the order that im to ship
// the 62."
//
// ── ⚠️ WHY A TOTALS CHECK CANNOT FIND THIS ──────────────────────────────────
//
// PO 0008928906 ordered 270 units. IF7650 packed 270 units, in 22 cartons, against
// 22 order lines. Every total reconciles. And one carton holds the wrong bag:
//
//   PO line 6 wants  SN41263LD-CHOCOLATE  Porto MEDIUM Half-Moon Bag  10 units
//   carton 20 holds  SN41262LD-CHOCOLATE  Porto SMALL  Half-Moon Bag  10 units
//
// One digit in the style number, and a different SIZE of bag. Because the quantity
// is identical the sum is identical, so a unit-count check, a carton-count check and
// a line-count check all pass. The only thing that finds it is comparing STYLE AND
// COLOUR line by line, which is what this does.
//
// ⚠️ THIS IS A KNOWN, REPEATED SHAPE HERE. The shoe order booked 120 chocolate as
// onyx and silently zeroed 120 linen — "both invisible to a totals check". And
// style numbers one digit apart are a documented trap in this catalogue: SN03013LD
// vs SN13013LD are two versions of the same bag, while SN41262 vs SN41263 are two
// different bags. A human reading either pair aloud cannot hear the difference.
//
// ── ⚠️ THE 850 IS THE AUTHORITY, NOT THE SALES ORDER ────────────────────────
//
// The substitution entered the SALES ORDER — someone keying the PO by hand picked
// the 62. So reconciling the packed cartons against the SO would agree with itself
// and find nothing. The comparison has to be against the PO as the partner sent it:
// the 850, or the PO download that matches it. Exemplar's Manual §9.2 says a
// retransmitted PO IS their confirmation of what they want; ours is not a vote.

import { FEES, feeFor, AUDIT } from './exemplarStandards.js'

/** Style + colour is the identity of a line. Quantity is not part of it. */
export const lineKey = (style, colour) =>
  `${String(style ?? '').trim().toUpperCase()}-${String(colour ?? '').trim().toUpperCase()}`

const num = (v) => Number(v) || 0

/**
 * @param ordered  [{ line, style, colour, qty, sku, upc }]  from the 850 / PO download
 * @param packed   [{ style, colour, qty, carton, upc }]      what is in the boxes
 *
 * ⚠️ IT REPORTS PAIRS, NOT JUST DIFFERENCES. A substitution is a short on one line
 * AND an unordered item on another, and Exemplar charges it as both (§12.3: short
 * shipped $500/incident, substituted $500/incident). Reporting only "10 units short"
 * understates it by half and hides the reason.
 */
export function reconcile(ordered = [], packed = []) {
  const byKeyOrdered = new Map()
  for (const o of ordered) {
    const k = lineKey(o.style, o.colour)
    const prev = byKeyOrdered.get(k)
    byKeyOrdered.set(k, prev ? { ...prev, qty: prev.qty + num(o.qty) } : { ...o, qty: num(o.qty) })
  }
  const byKeyPacked = new Map()
  for (const p of packed) {
    const k = lineKey(p.style, p.colour)
    const prev = byKeyPacked.get(k)
    byKeyPacked.set(k, prev
      ? { ...prev, qty: prev.qty + num(p.qty), cartons: [...prev.cartons, p.carton] }
      : { ...p, qty: num(p.qty), cartons: [p.carton] })
  }

  const matched = []
  const short = []      // ordered, not packed (or packed light)
  const notOrdered = [] // packed, not ordered (or packed heavy)

  for (const [k, o] of byKeyOrdered) {
    const p = byKeyPacked.get(k)
    if (!p) { short.push({ key: k, ...o, packedQty: 0, delta: -o.qty }); continue }
    if (p.qty === o.qty) matched.push({ key: k, ...o, packedQty: p.qty, cartons: p.cartons })
    else if (p.qty < o.qty) short.push({ key: k, ...o, packedQty: p.qty, delta: p.qty - o.qty, cartons: p.cartons })
    else notOrdered.push({ key: k, ...p, orderedQty: o.qty, delta: p.qty - o.qty, over: true })
  }
  for (const [k, p] of byKeyPacked) {
    if (!byKeyOrdered.has(k)) notOrdered.push({ key: k, ...p, orderedQty: 0, delta: p.qty, over: false })
  }

  const orderedUnits = [...byKeyOrdered.values()].reduce((a, o) => a + o.qty, 0)
  const packedUnits = [...byKeyPacked.values()].reduce((a, p) => a + p.qty, 0)

  return {
    matched, short, notOrdered,
    orderedUnits, packedUnits,
    // ⚠️ THE FLAG THAT MATTERS. Totals agreeing while lines do not is the signature
    // of a substitution, and it is the case a totals check calls clean.
    totalsAgree: orderedUnits === packedUnits,
    clean: short.length === 0 && notOrdered.length === 0,
    substitutions: pairSubstitutions(short, notOrdered),
  }
}

/**
 * A short line and an unordered line of the SAME quantity is almost certainly one
 * substitution rather than two unrelated errors — and when the style numbers differ
 * by a single character it is near-certain.
 *
 * ⚠️ IT SAYS "LIKELY", NEVER "IS". Two genuinely separate mistakes can coincide on
 * quantity. The pairing is a hint for the person checking, not a conclusion, so the
 * short and the unordered line are ALSO reported on their own — dropping them into a
 * "substitution" bucket would hide a real short ship if the guess were wrong.
 */
export function pairSubstitutions(short = [], notOrdered = []) {
  const out = []
  for (const s of short) {
    for (const n of notOrdered) {
      if (Math.abs(s.delta) !== Math.abs(n.delta)) continue
      out.push({
        orderedStyle: s.style, orderedColour: s.colour, orderedSku: s.sku ?? null,
        packedStyle: n.style, packedColour: n.colour, cartons: n.cartons ?? [],
        qty: Math.abs(s.delta),
        oneCharacterApart: editDistance(String(s.style ?? ''), String(n.style ?? '')) === 1,
        likely: true,
      })
    }
  }
  return out
}

/** Levenshtein, only ever called on short style codes. */
export function editDistance(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * What this costs if it ships as packed.
 *
 * ⚠️ BOTH FEES, NOT ONE. Exemplar assesses the missing line as a short ship AND the
 * substituted units separately. `substituted` is SFA code 42 with no NMG equivalent,
 * so it applies on a Saks-banner PO and may not on a Neiman one — the banner is
 * carried through rather than assumed.
 */
export function priceReconciliation(result, { banner = 'SFA' } = {}) {
  const items = []
  if (result.short.length) {
    items.push({ reason: 'Vendor short shipped', ...feeFor('shortShipped', { pos: result.short.length }) })
  }
  if (result.notOrdered.length) {
    if (banner === 'SFA' && FEES.substituted) {
      items.push({ reason: 'Substituted merchandise', ...feeFor('substituted', { pos: result.notOrdered.length }) })
    } else {
      items.push({ reason: 'Vendor over shipped / not ordered', ...feeFor('overShipped', { pos: result.notOrdered.length }) })
    }
  }
  const wrongUnits = result.short.reduce((a, s) => a + Math.abs(s.delta), 0)
  const errorRate = result.orderedUnits ? wrongUnits / result.orderedUnits : 0
  return {
    items,
    estimate: items.reduce((a, i) => a + (i.estimate || 0), 0),
    wrongUnits,
    errorRate,
    // ⚠️ THE AUDIT PROGRAMME IS THE EXPENSIVE HALF and it is easy to miss: the fees
    // are one-off, the programme is $1,000 a MONTH for a minimum of three months and
    // needs three consecutive clean months to leave.
    aboveAuditTrigger: errorRate > AUDIT.itemErrorRateTrigger,
    auditNote: errorRate > AUDIT.itemErrorRateTrigger
      ? `${(errorRate * 100).toFixed(1)}% item error rate is above the ${AUDIT.itemErrorRateTrigger * 100}% trigger — $${AUDIT.feePerMonth}/month, minimum ${AUDIT.minimumMonths} months, and ${AUDIT.exit} to leave.`
      : null,
    // §9.2, and it is not a fee: they can keep the goods.
    receivedNotOrdered: result.notOrdered.length
      ? 'Manual §9.2: Exemplar may refuse or return without vendor authorization, AND may keep the units and assess an offset fee.'
      : null,
  }
}

/**
 * ⚠️ OUR UPCs ARE THE APPROVED ONES ON THIS ACCOUNT. Nima, 2026-09-11: "we were
 * approved to ship with our UPC codes and not saks generated ones from what i was
 * told." The PO download carries Exemplar's own numbers in its `UPC` and `svs`
 * columns (PO line 6 reads 400270448906 / 0400027044890) and those are NOT what goes
 * on our carton labels — ours do, e.g. 840470890073 for SN41263LD-CHOCOLATE.
 *
 * Recorded because the two sit in adjacent columns of the same spreadsheet and the
 * partner's number looks more authoritative than ours. Reconcile on STYLE + COLOUR,
 * never on UPC, or every line reads as a mismatch.
 */
export const UPC_AUTHORITY = {
  useOurs: true,
  ours: 'item.upccode in NetSuite — e.g. 840470890073',
  theirs: "the PO download's UPC / svs columns — e.g. 400270448906 / 0400027044890",
  approvedBy: 'Nima, relayed 2026-09-11 ("we were approved to ship with our UPC codes")',
  reconcileOn: 'style + colour',
}
