// src/model/ediPoDiff.js — version diffing for re-sent EDI POs.
//
// Nordstrom, Shopbop, and Bloomingdale's re-transmit the SAME PO number when
// the units or the ship window change (confirmed on real data 2026-07-29:
// one Nordstrom PO sent 6× with a SKU swap and a 2-week window shift between
// v1 and v6). Each re-send is a distinct Orderful transaction sharing the
// business_number, so the "versions" of a PO are just its 850s ordered by
// createdAt. This module turns that list into a human-readable diff, and
// decides when a re-send warrants a "re-check" after the user has already
// acted on the PO (parked it unallocated, validated it, closed it).
//
// Pure — no DB, no network. Inputs are the parsed 850s already on the order
// (each carrying lineItems/shipNotBefore/cancelAfter/createdAt).

const money = (n) => (n == null ? null : Number(n))

// Ship-window dates reach here either as 'YYYY-MM-DD' strings (parsed 850) or,
// when read back from Postgres, as JS Date objects — normalize to a plain
// day string so a value-equal date isn't a reference-unequal false "change",
// and so summaries print '2025-08-15', not a full Date.toString().
const dayStr = (d) => {
  if (d == null) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const t = new Date(d)
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10)
}

// The 850 versions of a PO, oldest → newest. `order.transactions` holds every
// document (850/856/810); we want only the 850s, sorted by when they arrived.
export function poVersions(order) {
  return (order?.transactions || [])
    .filter((t) => t.type === '850_PURCHASE_ORDER')
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
}

// Diff two parsed 850 versions (prev → next). Returns a structured, UI-ready
// summary plus a `changed` flag. Lines are matched by their stable `sku`
// (vendor style, else UPC) so a re-order of array positions isn't a false diff.
// ⚠️ Nordstrom parks unallocated units on store 0299 — a DC, not a shop. Nima:
// "anytime i see that 299 i know its unallocated." Measured across 30 recent Nordstrom
// 850s: 4 send every line to 0299, 23 never mention it, and NONE mix it with real
// stores. So this is a clean discriminator, not a heuristic.
//
// ⚠️ Partner-specific by nature. It is Nordstrom's convention and nothing suggests any
// other partner uses it, so anything reading this must check the partner too rather than
// assuming 0299 means the same thing everywhere.
// The per-store breakdown out of an 850's SDQ segment (Nima, 2026-08-17).
//
// ⚠️ Qualifier '92' is "assigned by buyer", and it tags BOTH the buying party and each
// store. Measured on live Nordstrom 850s: the buyer code is 10 digits (0005189002) and
// every store is 4 (0299, 0004, 0221, 0568…). So four digits IS the store rule — stated
// here as the assumption it is, with the evidence, rather than left implicit.
//
// ── ⚠️ THE ORIGINAL REGEX READ ONE STORE PER SEGMENT AND DROPPED THE REST ────
//
// An SDQ segment repeats up to ten store/quantity pairs, and the repeats are suffixed:
// `identificationCode`, `identificationCode1`, `identificationCode2` … each with a
// matching `quantity`, `quantity1`, `quantity2`. The regex only matched the UNSUFFIXED
// one, so it returned the first store of each segment and silently lost the others.
//
// Measured on PO 50220600 (2026-08-31): it reported 3 stores — 0167, 7742, 7760 — where
// the 850 actually names TEN (0167 0351 0363 0370 0371 0372 0378 7742 7760 7768). Seven
// stores' worth of freight, invisible.
//
// ⚠️ AND THE QUANTITIES WERE THROWN AWAY. They are in the same segment, they are what a
// per-store pick needs, and on both POs checked they reconcile exactly against the line
// totals (95 = 95, 1033 = 1033) — which makes them a free correctness check on the parse.

/** One SDQ segment → its store/quantity pairs, repeats included. */
export function sdqPairs(segment = {}) {
  const out = []
  // ⚠️ THE QUALIFIER GATES THE WHOLE SEGMENT. '92' is "assigned by buyer"; codes under
  // any other qualifier are not Nordstrom store numbers and must not be read as such.
  // Kept when the SDQ walk replaced the old text-scanning regex — dropping it would have
  // silently widened what counts as a store.
  if (segment.identificationCodeQualifier !== undefined
      && segment.identificationCodeQualifier !== '92') return out
  for (const key of Object.keys(segment)) {
    const m = key.match(/^identificationCode(\d*)$/)
    if (!m) continue
    const store = String(segment[key] ?? '').trim()
    const qty = Number(segment[`quantity${m[1]}`])
    // ⚠️ Four digits IS the store rule (see above) — it is also what keeps the 10-digit
    // buyer code out of the store list.
    if (!/^\d{4}$/.test(store) || !Number.isFinite(qty)) continue
    out.push({ store, qty })
  }
  return out
}

/** Every SDQ segment on the message, from any depth. */
function sdqSegments(message) {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'destinationQuantity' && Array.isArray(v)) out.push(...v)
      else walk(v)
    }
  }
  walk(message)
  return out
}

/** Store → total units across the whole 850. The per-store pick, straight from the SDQ. */
export function extractStoreQuantities(message) {
  const totals = new Map()
  for (const seg of sdqSegments(message)) {
    for (const { store, qty } of sdqPairs(seg)) totals.set(store, (totals.get(store) || 0) + qty)
  }
  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([store, units]) => ({ store, units }))
}

export function extractStoreCodes(message) {
  return extractStoreQuantities(message).map((s) => s.store)
}

// ── ⚠️ WHERE THE FREIGHT ACTUALLY GOES — and nothing read this until 2026-08-31 ──
//
// SDQ is MARK FOR, not ship to. The dock is in an N1 segment on each line:
//
//     { entityIdentifierCode: "ST", name: "0299" }
//
// ⚠️ IT CARRIES NO `identificationCodeQualifier`, which is why the qualifier-92 regex
// above never saw it. The app has therefore never known a Rack PO's destination — it
// only ever learned a DC from `custentity_dc_location` on a NetSuite customer, which is
// exactly what a PO with no sales order does not have.
//
// Measured 2026-08-31:
//   PO 50203208 — mark for 0297 (CS Rack Warehouse) → ship to 0299 (Central States DC)
//   PO 50220600 — mark for seven CA stores → ship to 0399 · three FL stores → 0799
//
// So you never ship to a store: you ship to its DC and the store code is the carton
// label. That is also why NOT ONE of the 115 Nordstrom customers in NetSuite carries an
// address — the model never needed one.
export function extractShipTo(message) {
  const out = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.entityIdentifierCode === 'ST') {
      const code = String(node.name ?? node.identificationCode ?? '').trim()
      if (/^\d{4}$/.test(code)) out.add(code)
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(message)
  return [...out].sort()
}

export const HOLD_STORE = '0299'

/**
 * Has the partner not allocated this PO yet?
 *
 * ⚠️ NORDSTROM'S OWN RULE, quoted from the supplier store-DC sheet: *"Pre-Allocation
 * Stores will appear with THE SAME VALUE, THE DC LOCATION, in the Mark For and in the
 * Ship To location. These are not valid stores; they are a unit placeholder prior to
 * store allocation … never ship until the PO has been store allocated."*
 *
 * ⚠️ SO THE TEST IS MARK-FOR == SHIP-TO, not "is it 0299". That distinction is the whole
 * point and it is worth a real example: PO 50203208 marks for 0297 and ships to 0299.
 * Two different values, so it is ALLOCATED and shippable — 0297 is the CS Rack Warehouse,
 * a named destination in the Rack store list, confirmed in writing by Nordstrom's own
 * merchandise analyst. Reading "there is a 299 on it" as unallocated would have held
 * 1,033 units of shoes that were cleared to go.
 *
 * The single-argument form is kept for callers that only have store codes; without a
 * ship-to it can only fall back to the old 0299-alone heuristic, and says so.
 */
export function looksUnallocated(storeCodes = [], shipTo = null) {
  const marks = (storeCodes || []).filter(Boolean)
  if (!marks.length) return false
  if (shipTo && shipTo.length) {
    const ship = new Set(shipTo)
    // Every mark-for is also the dock → placeholder units, do not ship.
    return marks.every((m) => ship.has(m))
  }
  return marks.length === 1 && marks[0] === HOLD_STORE
}

export function diffPoVersions(prev, next) {
  const dates = {}
  for (const f of ['shipNotBefore', 'cancelAfter']) {
    const a = dayStr(prev?.[f])
    const b = dayStr(next?.[f])
    if (a !== b) dates[f] = { from: a, to: b }
  }

  const prevBySku = new Map((prev?.lineItems || []).map((l) => [l.sku, l]))
  const nextBySku = new Map((next?.lineItems || []).map((l) => [l.sku, l]))

  const added = []
  const removed = []
  const qtyChanges = []
  const priceChanges = []

  for (const [sku, l] of nextBySku) {
    if (!prevBySku.has(sku)) { added.push({ sku, style: l.style, upc: l.upc, qty: l.qty }); continue }
    const p = prevBySku.get(sku)
    if (p.qty !== l.qty) qtyChanges.push({ sku, style: l.style, from: p.qty, to: l.qty })
    if (money(p.unitPrice) !== money(l.unitPrice)) priceChanges.push({ sku, style: l.style, from: p.unitPrice, to: l.unitPrice })
  }
  for (const [sku, l] of prevBySku) {
    if (!nextBySku.has(sku)) removed.push({ sku, style: l.style, upc: l.upc, qty: l.qty })
  }

  // ⚠️ THE STORE LIST, and it is the reason this diff exists at all for a parked PO.
  //
  // Nima, 2026-08-17: Nordstrom sends unallocated POs to store 0299 and re-sends them
  // once the units allocate. Before this, the diff compared dates, SKUs, quantities and
  // prices — so a re-send that moved 25 units from store 0299 to store 0221 with the
  // SAME totals changed NOTHING the diff could see, and the PO would have stayed parked
  // and silent. The allocation is the whole event, and it lives here.
  const storesFrom = [...(prev?.storeCodes || [])].sort()
  const storesTo = [...(next?.storeCodes || [])].sort()
  const storesAdded = storesTo.filter((c) => !storesFrom.includes(c))
  const storesRemoved = storesFrom.filter((c) => !storesTo.includes(c))

  const unitsFrom = (prev?.lineItems || []).reduce((s, l) => s + (l.qty || 0), 0)
  const unitsTo = (next?.lineItems || []).reduce((s, l) => s + (l.qty || 0), 0)

  const changed =
    storesAdded.length > 0 || storesRemoved.length > 0 ||
    Object.keys(dates).length > 0 || added.length > 0 || removed.length > 0 ||
    qtyChanges.length > 0 || priceChanges.length > 0

  return {
    changed, dates, added, removed, qtyChanges, priceChanges, unitsFrom, unitsTo,
    storesFrom, storesTo, storesAdded, storesRemoved,
  }
}

// Short badge strings for a diff — what the UI shows on a version step and in
// the re-check prompt. Compact on purpose (one glance).
export function summarizePoDiff(diff) {
  if (!diff || !diff.changed) return []
  const out = []
  if (diff.dates.shipNotBefore) out.push(`ship-window start ${diff.dates.shipNotBefore.from || '—'}→${diff.dates.shipNotBefore.to || '—'}`)
  if (diff.dates.cancelAfter) out.push(`cancel date ${diff.dates.cancelAfter.from || '—'}→${diff.dates.cancelAfter.to || '—'}`)
  // ⚠️ Named FIRST in the sentence when 299 is involved, because "it allocated" is the
  // headline and a list of store numbers is not. Nima reads 299 as "unallocated", so the
  // summary should read the way he already thinks about it.
  if (diff.storesRemoved.includes(HOLD_STORE) && diff.storesAdded.length) {
    out.push(`ALLOCATED — left store ${HOLD_STORE}, now ${diff.storesAdded.join(', ')}`)
  } else if (diff.storesAdded.includes(HOLD_STORE)) {
    out.push(`moved TO store ${HOLD_STORE} (unallocated)`)
  } else if (diff.storesAdded.length || diff.storesRemoved.length) {
    const bits = []
    if (diff.storesAdded.length) bits.push(`+${diff.storesAdded.join(',')}`)
    if (diff.storesRemoved.length) bits.push(`-${diff.storesRemoved.join(',')}`)
    out.push(`stores ${bits.join(' ')}`)
  }
  if (diff.unitsFrom !== diff.unitsTo) out.push(`units ${diff.unitsFrom}→${diff.unitsTo}`)
  for (const q of diff.qtyChanges) out.push(`${q.style || q.sku} qty ${q.from}→${q.to}`)
  for (const a of diff.added) out.push(`+${a.style || a.sku} (${a.qty})`)
  for (const r of diff.removed) out.push(`−${r.style || r.sku} (${r.qty})`)
  for (const p of diff.priceChanges) out.push(`${p.style || p.sku} price ${p.from ?? '—'}→${p.to ?? '—'}`)
  return out
}

// The version story for one PO + the re-check decision. `markedAt` is the
// resolution's updated_at (when the user last acted — parked/validated/closed);
// null when they never have. A re-check fires only when a NEWER 850 arrived
// AFTER that action AND it actually differs from the version that was current
// when they acted — so a routine no-op re-transmit never cries wolf.
export function poVersionInfo(order, markedAt = null, hasResolution = false) {
  const versions = poVersions(order)
  const sendCount = versions.length

  // consecutive step diffs, newest step last
  const steps = []
  for (let i = 1; i < versions.length; i++) {
    steps.push({ from: versions[i - 1], to: versions[i], diff: diffPoVersions(versions[i - 1], versions[i]) })
  }

  let needsRecheck = false
  let recheckSummary = []
  let recheckSince = null
  if (hasResolution && markedAt && versions.length) {
    const markTs = new Date(markedAt).getTime()
    const after = versions.filter((v) => new Date(v.createdAt || 0).getTime() > markTs)
    if (after.length) {
      // the version that was current when they acted (last one at/before the mark),
      // falling back to the earliest if the mark predates every stored version.
      const atMark = [...versions].reverse().find((v) => new Date(v.createdAt || 0).getTime() <= markTs) || versions[0]
      const latest = versions[versions.length - 1]
      const d = diffPoVersions(atMark, latest)
      if (d.changed) {
        needsRecheck = true
        recheckSummary = summarizePoDiff(d)
        recheckSince = after[0].createdAt
      }
    }
  }

  return { versions, sendCount, steps, needsRecheck, recheckSummary, recheckSince }
}
