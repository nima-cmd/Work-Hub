// src/model/slipExceptions.js — what the slip says that we cannot just act on.
//
// Nima, 2026-09-14, on container "59 cartons LCL to LA": "two things will happen when
// i put this packing slip in there we dont want to automate the reponses but we want
// to account for them so we can fix them in the app. One a strap item that odesn't
// exsist will show up we need our IR and transfer order to ingnore this we will be
// told that this is an error and will need some way fo resolving it n the app. The
// other error is over receiving of an item whichj in this case we want to do but we
// would like the ability to choose what to do so our IR and our transfer order
// reflects it."
//
// ── ⚠️ THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────
//
// DO NOT AUTOMATE THE RESPONSE. Both of these already had an automatic answer, and
// both automatic answers happened to be right — which is exactly why they were
// dangerous. The strap was dropped by a regex I wrote from ONE line on ONE slip; the
// over-receive was accepted by a single boolean that said "yes" to every over-receive
// on the container at once. Neither left a record of a decision, because neither was
// a decision.
//
// So detection stays, and the ANSWER becomes a choice someone makes, per line, with
// the effect on both files stated before they make it. A suggested resolution is
// offered and is never pre-applied: `unresolved` is non-empty until a human names one,
// and an unresolved exception blocks both CSVs.
//
// ── ⚠️ AND THE CHOICE HAS TO REACH BOTH FILES, NOT JUST THE RECEIPT ─────────
//
// The Item Receipt brings units into China; the Inventory Transfer moves them out. A
// resolution applied to one and not the other leaves units received in China and
// never moved, or moved without ever being received. That is worse than either
// original bug, so the decisions are applied to the SHIPPED QUANTITIES — upstream of
// both builders — and both read the same adjusted container.

import { indexPoLines, toPoFull } from './itemReceiptCsv.js'

/** Stable across re-parses, so a decision made on screen survives a Re-check. */
export const exceptionKey = ({ kind, poNumber, sku }) =>
  `${kind}|${toPoFull(poNumber)}|${String(sku ?? '')}`

/**
 * Every resolution, and what each one does to each file.
 *
 * ⚠️ `effect` IS SHOWN TO THE PERSON CHOOSING. A picker that lists "Receive all /
 * Receive remaining / Hold" without saying what each does to the transfer is asking
 * someone to guess at the half of the consequence they cannot see.
 */
export const RESOLUTIONS = {
  'non-merchandise': [
    {
      id: 'leave-off',
      label: 'Not a stock item — leave it off both files',
      effect: 'The units are recorded as having arrived with the goods, and neither the receipt nor the transfer mentions them.',
      suggested: true,
    },
    {
      id: 'receive-it',
      label: 'It is a real item — receive and transfer it',
      effect: 'Treated as merchandise. If the PO has no open line for it, it becomes an unplaceable line and is reported as one rather than invented.',
      suggested: false,
    },
  ],
  'excess-shipped': [
    {
      id: 'receive-all',
      label: 'Receive everything that arrived',
      effect: 'The receipt takes the full shipped quantity and the transfer moves the same. The PO is untouched and reads received-over-ordered, which is true.',
      suggested: true,
    },
    {
      id: 'receive-remaining',
      label: 'Receive only what the PO has left',
      effect: 'Receipt and transfer both take the remaining quantity. The extra units are physically here and are in no NetSuite record — they have to go somewhere else.',
      suggested: false,
    },
    {
      id: 'hold-line',
      label: 'Hold the whole line for someone to look at',
      effect: 'The SKU is on neither file. Nothing about it is received or moved until the next import.',
      suggested: false,
    },
  ],
  // ⚠️ DELIBERATELY EMPTY, AND NOT AN OVERSIGHT. A line with nothing remaining is
  // what EVERY line looks like once this container's receipt has already been
  // imported, and the two are indistinguishable from the quantities alone. Offering a
  // resolution here would put a button on the 2026-09-08 failure.
  'nothing-remaining': [],
}

export const resolutionsFor = (kind) => RESOLUTIONS[kind] ?? []
export const suggestedFor = (kind) => resolutionsFor(kind).find((r) => r.suggested)?.id ?? null

/**
 * Find everything on this slip that needs a decision.
 *
 * ⚠️ THE OVER-RECEIVE TEST IS THE RECEIPT'S OWN — shipped against REMAINING, never
 * against gross ordered. A half-received PO still shows its full ordered quantity, so
 * comparing against that lets a second shipment of the same units through unseen. Kept
 * identical here on purpose: two places computing "over" two ways is how the screen
 * ends up offering a decision the file then refuses to honour.
 */
export function slipExceptions(container = {}, poLines = []) {
  const { byPo } = indexPoLines(poLines)
  const out = []

  for (const l of container.nonMerchandise || []) {
    out.push({
      kind: 'non-merchandise',
      key: exceptionKey({ kind: 'non-merchandise', poNumber: l.poNumber, sku: l.sku }),
      poNumber: toPoFull(l.poNumber), sku: l.sku, units: l.units,
      what: `${l.sku} — ${l.units} unit${l.units === 1 ? '' : 's'} on the slip with nothing purchased to match`,
      why: 'The slip lists it, the PO does not. It looks like an accessory packed with a bag rather than a line anyone ordered — but that read comes from the SKU spelling alone, so it is a suggestion, not a finding.',
      required: true,
      resolutions: resolutionsFor('non-merchandise'),
      suggested: suggestedFor('non-merchandise'),
    })
  }

  const byPoTotals = new Map()
  for (const l of container.skuTotals || []) {
    const po = toPoFull(l.poNumber)
    const m = byPoTotals.get(po) ?? new Map()
    m.set(l.sku, (m.get(l.sku) ?? 0) + l.units)
    byPoTotals.set(po, m)
  }
  for (const [po, shipped] of byPoTotals) {
    const lines = byPo.get(po)
    if (!lines) continue
    for (const [sku, qty] of shipped) {
      const line = lines.get(sku)
      if (!line || qty <= line.remaining) continue
      const kind = line.remaining > 0 ? 'excess-shipped' : 'nothing-remaining'
      out.push({
        kind,
        key: exceptionKey({ kind, poNumber: po, sku }),
        poNumber: po, sku,
        shipped: qty, remaining: line.remaining, ordered: line.ordered,
        received: line.received, excess: qty - line.remaining,
        what: `${sku} — ${qty} shipped against ${line.remaining} remaining (+${qty - line.remaining})`,
        why: kind === 'excess-shipped'
          ? 'The line still had room and the factory sent more than it held. Receiving the extra is an honest record of what arrived.'
          : 'The line has nothing left at all, which is also what it looks like when this container has already been received. There is no way to tell those apart from the quantities, so this one cannot be resolved here.',
        required: kind === 'excess-shipped',
        resolutions: resolutionsFor(kind),
        suggested: suggestedFor(kind),
      })
    }
  }
  return out
}

/**
 * Apply the decisions to the shipped quantities.
 *
 * @param decisions { [exceptionKey]: resolutionId }
 * @returns { container, exceptions, unresolved, adjustments, acceptedExcessKeys }
 *
 * ⚠️ AN UNKNOWN RESOLUTION THROWS RATHER THAN FALLING BACK. A typo'd id silently
 * treated as "no decision" would leave the files blocked with no visible reason; one
 * silently treated as the suggestion would make up an answer. Both are worse than a
 * loud stop.
 */
export function applyDecisions(container = {}, poLines = [], decisions = {}) {
  const exceptions = slipExceptions(container, poLines)
  const byKey = new Map(exceptions.map((e) => [e.key, e]))

  for (const [key, id] of Object.entries(decisions || {})) {
    const e = byKey.get(key)
    if (!e) continue   // a decision for an exception this parse no longer has
    if (!e.resolutions.some((r) => r.id === id)) {
      throw new Error(`"${id}" is not a resolution for ${e.kind} (${e.sku}). Allowed: ${e.resolutions.map((r) => r.id).join(', ') || 'none'}`)
    }
  }

  const chosen = (e) => (decisions || {})[e.key] ?? null
  const unresolved = exceptions.filter((e) => e.required && !chosen(e))

  const adjustments = []
  const acceptedExcessKeys = []
  let skuTotals = [...(container.skuTotals || [])]

  for (const e of exceptions) {
    const id = chosen(e)
    if (!id) continue

    if (e.kind === 'non-merchandise' && id === 'receive-it') {
      const line = (container.nonMerchandise || []).find(
        (l) => l.sku === e.sku && toPoFull(l.poNumber) === e.poNumber)
      if (line) {
        skuTotals.push(line)
        adjustments.push({ ...e, resolution: id, effect: `${e.sku} folded back in as merchandise — ${line.units} units` })
      }
      continue
    }
    if (e.kind === 'non-merchandise') {
      adjustments.push({ ...e, resolution: id, effect: `${e.sku} kept off both files — ${e.units} units arrived and are on neither` })
      continue
    }

    if (e.kind !== 'excess-shipped') continue
    if (id === 'receive-all') {
      acceptedExcessKeys.push(`${e.poNumber}|${e.sku}`)
      adjustments.push({ ...e, resolution: id, effect: `${e.sku}: receipt and transfer both take ${e.shipped} — ${e.excess} over what the PO had left` })
    } else if (id === 'receive-remaining') {
      skuTotals = skuTotals.map((l) => (l.sku === e.sku && toPoFull(l.poNumber) === e.poNumber
        ? { ...l, units: e.remaining } : l))
      adjustments.push({ ...e, resolution: id, effect: `${e.sku}: receipt and transfer both take ${e.remaining}. ${e.excess} unit${e.excess === 1 ? '' : 's'} arrived and will be in no NetSuite record.` })
    } else if (id === 'hold-line') {
      skuTotals = skuTotals.filter((l) => !(l.sku === e.sku && toPoFull(l.poNumber) === e.poNumber))
      adjustments.push({ ...e, resolution: id, effect: `${e.sku}: off both files entirely — all ${e.shipped} units held` })
    }
  }

  // ⚠️ The unit count is recomputed, never carried. Leaving the parse's figure on a
  // container whose lines just changed is how a screen ends up showing 1,482 next to
  // files that move 1,477.
  const adjusted = {
    ...container,
    skuTotals,
    unitCount: skuTotals.reduce((n, r) => n + r.units, 0),
  }
  return { container: adjusted, exceptions, unresolved, adjustments, acceptedExcessKeys }
}
