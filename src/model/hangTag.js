// src/model/hangTag.js — what goes on a Naghedi hang tag.
//
// ⚠️ NOT DESIGNED, TRANSCRIBED. Nima photographed a real tag (SN03012LD Bordeaux) rather
// than describe it, and every field on it was already in the database. The tag reads:
//
//     St. Barths Small Tote      ← catalogue_skus.description
//     SN03012LD                  ← catalogue_skus.product_id
//     Bordeaux                   ← catalogue_skus.color
//     ‖‖│‖ 8 40470 89796 6 ‖‖    ← catalogue_skus.upc, as UPC-A
//     $285.00                    ← ns_item_price, Retail Price level
//
// Rebuilt from the database on 2026-08-31 it reproduced all five fields exactly. That is
// the whole spec, and it is worth noting nothing had to be invented.
//
// ── ⚠️ THE PRICE IS PER COLOUR, NOT PER STYLE, and this nearly went wrong ────
//
// My first join read `ns_item_price` on `catalogue_skus.product_id` — the style — and
// matched ZERO of 77 rows. `ns_item_price.sku` is per colour (`SN03012LD-ADOBE`) while
// the catalogue keys on `SN03012LD|ADOBE`. Had the join happened to work on the style
// alone it would have been WORSE than failing: SN03012LD is $240 in Adobe and $285 in
// Ash, so every tag for the style would have carried one colour's price. A join that
// silently picks the wrong row prints a wrong price on a physical tag that then goes on
// a bag.
//
// So the key is the sku_key with its separator swapped, and `tagJoinKey` is the single
// place that transformation lives.
//
// ⚠️ 72 OF 77 catalogue SKUs have a Retail Price. The other five (SN03011LD and
// SN03012LD in Ink Blue and Shell Pink, SN03012LD Bottle Green) have NONE — null, not
// zero. They cannot be tagged, and the tool says which field is missing rather than
// printing a blank space or $0.00 where a price belongs.

import { retailPrice, labelBlocker, money, LEVEL } from './itemPrice.js'
import { upcError, upcHumanReadable } from './upcBarcode.js'

/**
 * The key that joins a catalogue SKU to its price row.
 *
 * ⚠️ ONE IMPLEMENTATION, because the two tables disagree about the separator and that
 * disagreement is exactly the kind of thing that gets re-derived slightly differently in
 * a second place. `SN03012LD|BORDEAUX` → `SN03012LD-BORDEAUX`.
 */
export const tagJoinKey = (skuKey) => String(skuKey ?? '').trim().toUpperCase().replace(/\|/g, '-')

/** The price as it is printed. Always two decimals — "$285" on a tag looks unfinished. */
export const formatTagPrice = (v) =>
  v === null || v === undefined ? null : `$${money(v).toFixed(2)}`

/**
 * Why this SKU cannot be hang-tagged, or null when it can.
 *
 * ⚠️ Composes `labelBlocker` from itemPrice.js rather than restating it — that function
 * already owns "no Retail Price" and "no UPC", and a second copy would drift. What is
 * added here is the one thing it does not check: whether the UPC is SELF-CONSISTENT.
 * A present-but-wrong UPC passes a presence test and then prints bars that scan as a
 * different product, which is the failure worth the most care.
 */
export function hangTagBlocker({ description, productId, color, upc, retail } = {}) {
  if (!String(productId ?? '').trim()) return 'no style number on the catalogue row'
  if (!String(description ?? '').trim()) return 'no product name on the catalogue row'
  if (!String(color ?? '').trim()) return 'no colour on the catalogue row'
  const levels = { [LEVEL.RETAIL]: retail }
  const missing = labelBlocker({ levels, upc })
  if (missing) return missing
  return upcError(upc)
}

/**
 * A hang tag, ready to draw — or a refusal that names what is missing.
 *
 * Returns { ok: true, tag } or { ok: false, reason }. ⚠️ Never a partial tag: a tag with
 * a blank where the price goes is worse than no tag, because it still gets attached to a
 * bag and then has to be found again.
 */
export function hangTag(row = {}) {
  const description = String(row.description ?? '').trim()
  const productId = String(row.productId ?? row.product_id ?? '').trim()
  const color = String(row.color ?? '').trim()
  const upc = String(row.upc ?? '').trim()
  const retail = row.retail ?? row.unitPrice ?? null

  const reason = hangTagBlocker({ description, productId, color, upc, retail })
  if (reason) return { ok: false, reason, skuKey: row.skuKey ?? row.sku_key ?? null, productId, color }

  return {
    ok: true,
    tag: {
      skuKey: row.skuKey ?? row.sku_key ?? `${productId}|${color.toUpperCase().replace(/\s+/g, '')}`,
      name: description,
      style: productId,
      color,
      upc,
      human: upcHumanReadable(upc),
      price: formatTagPrice(retailPrice({ [LEVEL.RETAIL]: retail })),
    },
  }
}

/**
 * Build tags for a list of catalogue rows, keeping the refusals.
 *
 * ⚠️ THE REFUSALS ARE RETURNED, NOT DROPPED. A tool that silently prints 72 tags when 77
 * were asked for is how five bags end up on a shelf with no tag and nobody knowing why.
 */
export function hangTags(rows = []) {
  const tags = []
  const blocked = []
  for (const r of rows) {
    const res = hangTag(r)
    if (res.ok) tags.push(res.tag)
    else blocked.push({ skuKey: res.skuKey, productId: res.productId, color: res.color, reason: res.reason })
  }
  return { tags, blocked }
}
