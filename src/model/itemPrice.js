// src/model/itemPrice.js — what an item costs, and which number belongs where.
//
// NetSuite keeps prices on the `pricing` sublist, one row per price level. Measured
// live 2026-08-27, the whole catalogue:
//
//   1  Wholesale Price            4,237 items    $-100 – $383
//   2  Retail Price               4,230 items    $0    – $635
//   8  Order Confirmation Price   4,072 items    $0    – $340
//
// ⚠️ `item.baseprice` IS A TRAP. It queries successfully and returns NOTHING — an
// empty result that reads as "this item has no price" rather than "you asked the wrong
// question". The sublist is the only real source.
//
// ⚠️ AND A PRICE OF ZERO IS NOT A PRICE. The ranges above include $0 and even -$100.
// A hang tag is read at a register; printing $0.00 or a negative onto one is worse than
// printing nothing, because nothing gets noticed and a wrong number gets charged. Every
// accessor here refuses rather than returns a figure it cannot stand behind.

export const LEVEL = { WHOLESALE: '1', RETAIL: '2', ORDER_CONFIRMATION: '8' }

export const LEVEL_NAME = {
  [LEVEL.WHOLESALE]: 'Wholesale Price',
  [LEVEL.RETAIL]: 'Retail Price',
  [LEVEL.ORDER_CONFIRMATION]: 'Order Confirmation Price',
}

/**
 * Is this a figure we can put in front of a customer?
 * ⚠️ Zero, negative, null and NaN are all "no". Only a positive number is a price.
 */
export function isUsablePrice(v) {
  if (v === null || v === undefined || v === '') return false
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

/** Round to cents without floating-point drift showing up on a printed tag. */
export const money = (v) => Math.round(Number(v) * 100) / 100

/**
 * Collapse a pricing sublist into one record per item.
 * @param rows [{ internalId, sku, priceLevel, unitPrice }]
 */
export function pricesByItem(rows = []) {
  const out = new Map()
  for (const r of rows) {
    const id = String(r.internalId ?? '').trim()
    if (!id) continue
    if (!out.has(id)) out.set(id, { internalId: id, sku: r.sku || null, levels: {} })
    const g = out.get(id)
    // ⚠️ The SKU is carried but never the key — it MOVES when a weave code changes
    // (SN030xx → SN130xx), which is the drift weaver_netsuite_item exists to record.
    if (!g.sku && r.sku) g.sku = r.sku
    g.levels[String(r.priceLevel)] = isUsablePrice(r.unitPrice) ? money(r.unitPrice) : null
  }
  return out
}

/** The number that goes on a hang tag. Null when there isn't an honest one. */
export const retailPrice = (levels = {}) =>
  isUsablePrice(levels[LEVEL.RETAIL]) ? money(levels[LEVEL.RETAIL]) : null

/** What a wholesale line SHOULD bill at, for comparing against an order rate. */
export const wholesalePrice = (levels = {}) =>
  isUsablePrice(levels[LEVEL.WHOLESALE]) ? money(levels[LEVEL.WHOLESALE]) : null

/**
 * Why a label cannot be printed. Returns null when it can.
 *
 * ⚠️ NAMES THE MISSING FIELD. "Cannot print" sends someone hunting; "no Retail Price in
 * NetSuite" is a thing they can go and fix.
 */
export function labelBlocker({ levels = {}, upc = null } = {}) {
  if (!retailPrice(levels)) return 'no Retail Price in NetSuite (price level 2)'
  if (!upc || !String(upc).trim()) return 'no UPC on the item record'
  return null
}

/**
 * Does an order line agree with the price list?
 *
 * ⚠️ A DIFFERENT AND STRONGER CHECK than "one style at two prices". That one only fires
 * when an order disagrees with ITSELF — SO12300's St. Barths Small Tote at $114 and
 * $102. This compares the line against what NetSuite says it should be, so a mispriced
 * line is caught even when every line on the order agrees with the others. The $102 was
 * $12 under the Wholesale Price NetSuite holds.
 *
 * ⚠️ Returns null when there is no list price. An absent comparison is not a finding.
 */
export function priceDeviation({ rate, levels = {}, tolerance = 0.005 } = {}) {
  const list = wholesalePrice(levels)
  if (list === null || !isUsablePrice(rate)) return null
  const charged = money(rate)
  const diff = money(charged - list)
  // A hair of floating-point noise is not a deviation.
  if (Math.abs(diff) <= tolerance) return null
  return { charged, list, diff, under: diff < 0 }
}
