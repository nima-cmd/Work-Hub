// src/ingest/shopifyStorefront.js — read Shopify without credentials.
//
// WHY THIS EXISTS. Weaver's whole purpose is keeping NetSuite and Shopify from
// diverging, and its NetSuite half works. Its Shopify half never has: the
// `Shopify Product Diff` and `Metafields Diff` formulas compare a field TO
// ITSELF on every branch, so they are permanently empty and always have been. A
// blank diff there is not evidence of agreement. There is no field in Weaver
// holding Shopify's actual state, so the comparison cannot be fixed in Airtable.
//
// NO TOKEN NEEDED. The public storefront serves /products.json, which carries
// title, handle, body_html, vendor, product_type, tags, options, images and every
// variant's sku and price — 8 of the 11 keys Weaver's own comparison key lists.
// Status, category and theme_template need the Admin API and a custom app token
// that has not been requested yet; metafields need it too.
//
// The storefront shows PUBLISHED products only. That is a feature for the
// missing/orphan checks (absence means "not live") and a limitation for status
// (we cannot tell draft from archived from deleted).
//
// READ-ONLY. Nothing here writes anywhere.

const SHOP = process.env.SHOPIFY_STOREFRONT || 'https://naghedinyc.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function fetchShopifyProducts({ fetchImpl = fetch, limit = 250, maxPages = 40 } = {}) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const url = `${SHOP}/products.json?limit=${limit}&page=${page}`
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (res.status === 429) { await sleep(2000); page--; continue }
    if (!res.ok) throw new Error(`Shopify storefront ${res.status} on page ${page}`)
    const body = await res.json()
    const products = body?.products ?? []
    out.push(...products)
    // The endpoint pages until it returns an empty array; there is no cursor and
    // no total, so an empty page is the only end-of-list signal there is.
    if (products.length < limit) return out
    await sleep(300)
  }
  // Hitting maxPages means we may have truncated. Say so rather than returning a
  // short list that reads as authoritative — a silent truncation here would
  // report every unlisted product as "missing from Shopify".
  throw new Error(`storefront paging exceeded ${maxPages} pages — raise maxPages`)
}

// Flatten to one row per variant, since SKU lives on the variant and SKU is the
// only key shared with Weaver and NetSuite.
export function shopifyVariants(products) {
  const out = []
  for (const p of products) {
    for (const v of p.variants ?? []) {
      out.push({
        variantId: String(v.id),
        productId: String(p.id),
        sku: (v.sku || '').trim().toUpperCase() || null,
        price: v.price ?? null,
        available: !!v.available,
        option1: v.option1 ?? null,
        position: v.position ?? null,
        title: p.title ?? null,
        handle: p.handle ?? null,
        vendor: p.vendor ?? null,
        productType: p.product_type ?? null,
        tags: p.tags ?? [],
        optionName: p.options?.[0]?.name ?? null,
        imageCount: (p.images ?? []).length,
        publishedAt: p.published_at ?? null,
        updatedAt: p.updated_at ?? null,
      })
    }
  }
  return out
}

const norm = (x) => (x == null ? '' : String(x).trim())

// Compare Shopify against Weaver on the fields both sides actually hold. Weaver
// computes each of these as a formula, so a difference means Shopify was edited
// directly or an upload never landed — either way it is divergence, which is the
// thing Weaver exists to prevent and cannot currently see.
const FIELDS = [
  { key: 'title', shopify: (v) => v.title, weaver: (p) => p.product_name },
  { key: 'handle', shopify: (v) => v.handle, weaver: (p) => p.handle },
  { key: 'vendor', shopify: (v) => v.vendor, weaver: (p) => p.vendor },
  { key: 'product_type', shopify: (v) => v.productType, weaver: (p) => p.product_type },
  { key: 'option_1_name', shopify: (v) => v.optionName, weaver: (p) => p.option1_name },
  { key: 'shopify_product_id', shopify: (v) => v.productId, weaver: (p) => p.shopify_product_id },
]

export function compareShopify(shopVariants, weaverProducts) {
  // ⚠ THE MATCH IS NOT sku-TO-sku. Weaver products are PARENT level
  // (`NS32130NG-ORE`); Shopify variants carry the sized child sku
  // (`NS32130NG-ORE-350`). Comparing them directly reported 666 orphans and 901
  // missing on the first run — every sized style counted twice, once in each
  // direction. Strip at the LAST dash to get the base, because the suffix is not
  // always numeric (`Variation Suffix (for SKU)` emits `-` & size*10 for numbers
  // but `-` & UPPER(size) otherwise), and parent skus contain dashes of their own.
  const baseOf = (sku) => { const i = sku.lastIndexOf('-'); return i > 0 ? sku.slice(0, i) : null }

  const byWeaverSku = new Map()
  for (const p of weaverProducts) {
    const sku = norm(p.sku).toUpperCase()
    // Guidance strings ("Select a Color.") are not skus; they carry lowercase or
    // spaces, which a real sku never does.
    if (!sku || /[a-z ]/.test(norm(p.sku))) continue
    byWeaverSku.set(sku, p)
  }

  const byShopSku = new Map()
  for (const v of shopVariants) if (v.sku && !byShopSku.has(v.sku)) byShopSku.set(v.sku, v)

  // Every sku Shopify covers, parent-level: the sku itself and its base.
  const shopCovers = new Set()
  for (const sku of byShopSku.keys()) {
    shopCovers.add(sku)
    const b = baseOf(sku)
    if (b) shopCovers.add(b)
  }

  const drift = []
  const orphan = []      // live on Shopify, no Weaver product owns it at any level
  const missing = []     // Weaver says it belongs on Shopify, Shopify has nothing

  // One drift entry per Weaver product, not per variant — otherwise an 11-size
  // shoe reports the same title mismatch eleven times.
  const seen = new Set()
  for (const [sku, v] of byShopSku) {
    const p = byWeaverSku.get(sku) || byWeaverSku.get(baseOf(sku) || '')
    if (!p) {
      // Gift cards and Internal items are Shopify-only by design and never come
      // from NetSuite — the same two product types the NetSuite side already
      // excludes (that exclusion took its false positives from 62 to 5). Marked
      // rather than dropped, so the page can show them as expected instead of
      // silently hiding a category.
      orphan.push({ ...v, benign: ['Gift Card', 'Internal'].includes(norm(v.productType)) })
      continue
    }
    if (seen.has(p.airtable_record_id)) continue
    seen.add(p.airtable_record_id)
    const diffs = []
    for (const f of FIELDS) {
      const a = norm(f.shopify(v)), b = norm(f.weaver(p))
      // An empty Weaver side means the field was not ingested for this product,
      // not that Shopify is wrong. Only compare where both sides have a value.
      if (a && b && a !== b) diffs.push({ field: f.key, shopify: a, weaver: b })
    }
    if (diffs.length) drift.push({ sku: p.sku, productId: v.productId,
                                   recordId: p.airtable_record_id, diffs })
  }

  // ⚠ "Not on Shopify" is mostly NOT an error. Weaver holds 1,418 products and the
  // storefront lists ~294: listing something is a merchandising decision, and
  // `For Shopify` marks ELIGIBILITY, not intent to publish now. Reporting all of
  // them gave 852 "findings", which is a backlog wearing an alert's clothing.
  //
  // The sharp signal is a CONTRADICTION: Weaver holds a Shopify product ID —
  // so it believes a Shopify product exists — and the storefront does not show
  // it. That means the product was unpublished, archived or deleted in Shopify
  // while Weaver still thinks it is live. Everything else is just not-yet-listed.
  let notYetListed = 0
  for (const [sku, p] of byWeaverSku) {
    if (shopCovers.has(sku)) continue
    if (!p.for_shopify) continue
    if (['Canceled', 'Sample', 'Inactive/Discontinued'].includes(norm(p.product_status))) continue
    if (!p.shopify_product_id) { notYetListed++; continue }
    missing.push({ sku, recordId: p.airtable_record_id, status: p.product_status,
                   name: p.product_name, shopifyProductId: p.shopify_product_id })
  }

  return { drift, orphan, missing,
           counts: { shopifyVariants: shopVariants.length, shopifySkus: byShopSku.size,
                     weaverSkus: byWeaverSku.size, drift: drift.length,
                     orphan: orphan.length, missing: missing.length, notYetListed } }
}
