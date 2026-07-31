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

  const unitsFrom = (prev?.lineItems || []).reduce((s, l) => s + (l.qty || 0), 0)
  const unitsTo = (next?.lineItems || []).reduce((s, l) => s + (l.qty || 0), 0)

  const changed =
    Object.keys(dates).length > 0 || added.length > 0 || removed.length > 0 ||
    qtyChanges.length > 0 || priceChanges.length > 0

  return { changed, dates, added, removed, qtyChanges, priceChanges, unitsFrom, unitsTo }
}

// Short badge strings for a diff — what the UI shows on a version step and in
// the re-check prompt. Compact on purpose (one glance).
export function summarizePoDiff(diff) {
  if (!diff || !diff.changed) return []
  const out = []
  if (diff.dates.shipNotBefore) out.push(`ship-window start ${diff.dates.shipNotBefore.from || '—'}→${diff.dates.shipNotBefore.to || '—'}`)
  if (diff.dates.cancelAfter) out.push(`cancel date ${diff.dates.cancelAfter.from || '—'}→${diff.dates.cancelAfter.to || '—'}`)
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
