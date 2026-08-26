// src/model/customsReconcile.js — does the commercial invoice match NetSuite, and
// will it match the box?
//
// Nima, 2026-08-26: "the old csv was what led me to find the improperly priced item
// which was a happy accident. We need to make sure it matches what's in netsuite and
// will be in the box."
//
// That accident is worth understanding, because it is the whole design here. The
// customs line key is (category, unit price), so ONE product sold at TWO prices splits
// into two lines — and on SO12300 "St. Barths Small Tote" appeared at $114 and at $102.
// The form made a pricing error VISIBLE. It did not detect it; a person noticed.
// These two checks are that noticing, done mechanically.
//
// ⚠️ BOTH ARE WARNINGS, NEVER A REFUSAL. A markdown is legitimate and a partial
// shipment is legitimate; what is not legitimate is sending the form without knowing.
// customsInvoice.js's `problems` gate the CSV because an unclassified line cannot be
// declared at all — these are a different thing and must not block a real shipment.

/**
 * The STYLE, which is the product — the item id up to its first hyphen.
 *
 * ⚠️ NOT the display name, which carries the colour: "St. Barths Small Tote | Bordeaux"
 * and "… | Pacific" are different strings, so grouping by name finds no duplicate and
 * the $102/$114 split stays invisible. SN03012LD-BORDEAUX and SN03012LD-PACIFIC share
 * the style SN03012LD, which is the thing that should have one price.
 *
 * ⚠️ And the style is compared WHOLE. SN03012LD (Small Tote) and SN03013LD (Medium
 * Tote) differ by one digit and are different products — see the style-number rule.
 * Any prefix-matching here would merge two real products into one false anomaly.
 */
export function styleOf(itemId) {
  const s = String(itemId || '').trim()
  if (!s) return null
  const i = s.indexOf('-')
  return (i === -1 ? s : s.slice(0, i)).toUpperCase() || null
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100

/**
 * One style carrying more than one unit price.
 * @param lines [{ item, displayName, qty, rate }]
 */
export function priceAnomalies(lines = []) {
  const byStyle = new Map()
  for (const l of lines) {
    const style = styleOf(l.item)
    if (!style || !Number(l.qty || 0)) continue
    if (!byStyle.has(style)) byStyle.set(style, { style, name: null, prices: new Map() })
    const g = byStyle.get(style)
    // The product name without its colour — what the reader recognises.
    g.name = g.name || String(l.displayName || l.item || '').split('|')[0].trim() || null
    const p = money(l.rate)
    if (!g.prices.has(p)) g.prices.set(p, [])
    g.prices.get(p).push({ item: l.item, qty: Number(l.qty || 0) })
  }
  const out = []
  for (const g of byStyle.values()) {
    if (g.prices.size < 2) continue
    const prices = [...g.prices.entries()]
      .map(([price, items]) => ({ price, units: items.reduce((n, i) => n + i.qty, 0), items: items.map((i) => i.item) }))
      .sort((a, b) => b.units - a.units)   // the majority price first — the likely-correct one
    out.push({ style: g.style, name: g.name, prices, spread: money(prices[0].price - prices[prices.length - 1].price) })
  }
  // Biggest price gap first: the most likely to be an error and the most costly.
  return out.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread))
}

/**
 * Per-item agreement between what the SO priced and what the IF ships.
 *
 * ⚠️ REPLACES A TOTAL-COUNT COMPARISON, which could not see a SWAP. Shipping 2 Onyx in
 * place of 2 Rosso keeps the total at 18 and changes every declared line — the form
 * would name goods that are not in the box, which is the one thing a customs document
 * must never do.
 *
 * @param priced  [{ item, qty }] from the sales order
 * @param shipped [{ item, qty }] from the fulfilment — POSITIVE InvtPart lines only
 *                (an IF writes -qty/+qty/-qty per item; see ediPackagesLive.ifUnitsSql)
 */
export function reconcileShipment({ priced = [], shipped = [] } = {}) {
  const roll = (rows) => {
    const m = new Map()
    for (const r of rows) {
      const k = String(r.item || '').trim()
      if (!k) continue
      m.set(k, (m.get(k) || 0) + Number(r.qty || 0))
    }
    return m
  }
  const p = roll(priced)
  const s = roll(shipped)

  // ⚠️ An empty fulfilment means WE COULD NOT READ IT, not that the box is empty.
  // Treating it as zero would report every item as "priced but not shipped" and bury
  // a lookup failure under 14 confident findings.
  if (!s.size) return { checked: false, agrees: false, notShipped: [], notPriced: [], quantityDiffs: [], pricedUnits: sum(p), shippedUnits: 0 }

  const notShipped = [] // priced, not in the box → the form over-declares
  const notPriced = []  // in the box, never priced → the form omits goods
  const quantityDiffs = []
  for (const [item, qty] of p) {
    if (!s.has(item)) notShipped.push({ item, qty })
    else if (s.get(item) !== qty) quantityDiffs.push({ item, priced: qty, shipped: s.get(item) })
  }
  for (const [item, qty] of s) if (!p.has(item)) notPriced.push({ item, qty })

  return {
    checked: true,
    agrees: !notShipped.length && !notPriced.length && !quantityDiffs.length,
    notShipped, notPriced, quantityDiffs,
    pricedUnits: sum(p), shippedUnits: sum(s),
  }
}

const sum = (m) => [...m.values()].reduce((n, v) => n + v, 0)

/** One line each, for the panel and the CLI. */
export function reconcileWarnings(rec, anomalies = [], { ifNumber = 'the fulfilment', soNumber = 'the order' } = {}) {
  const w = []
  if (rec && rec.checked === false) {
    w.push(`Could not read ${ifNumber}'s lines from NetSuite — the declaration has NOT been checked against the box.`)
  } else if (rec && !rec.agrees) {
    for (const d of rec.quantityDiffs) w.push(`${d.item}: ${soNumber} prices ${d.priced}, ${ifNumber} ships ${d.shipped}.`)
    for (const n of rec.notShipped) w.push(`${n.item}: priced on ${soNumber} (${n.qty}) but NOT in ${ifNumber} — the form would declare goods that are not in the box.`)
    for (const n of rec.notPriced) w.push(`${n.item}: shipping on ${ifNumber} (${n.qty}) but NOT priced on ${soNumber} — the form would omit goods that are.`)
  }
  for (const a of anomalies) {
    const bits = a.prices.map((p) => `$${p.price} x${p.units}`).join('  vs  ')
    w.push(`${a.name || a.style}: one style at ${a.prices.length} prices — ${bits}. Check the ${a.prices.length > 1 ? 'odd one' : 'price'} before declaring.`)
  }
  return w
}
