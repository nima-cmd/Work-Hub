// scripts/weaver-sync.js — reconcile NetSuite against Weaver AND record the result.
//
//   npm run weaver:sync            reconcile, persist, report
//   npm run weaver:sync -- --dry   reconcile and report, write nothing
//
// The read-only sibling is `npm run check:weaver`, which stays pure — it promises
// no writes anywhere and that promise is worth keeping. This one writes to
// Postgres only. It still never writes to NetSuite or Airtable.
//
// WHY PERSIST. `check:weaver` answers "is it diverging?" and forgets. It cannot
// answer "how long has this been wrong?", "is this new?", or "what SKU did this
// item used to have?" — and that last one is the root cause of all 17 MISMATCH
// rows in Weaver, which are style-number drift (NS47300FK -> EF) that Airtable has
// no memory of. Weaver structurally cannot remember; this can.
//
// Exit codes: 0 in sync (or only known-benign)   1 divergence needing a human
//             2 could not run (credentials, network, database)

import { fetchNetsuiteItems, fetchWeaverBackOffice, fetchWeaverProducts, reconcile, PRODUCT_FIELDS as PF }
  from '../src/ingest/weaverBackOffice.js'
import { fetchShopifyProducts, shopifyVariants, compareShopify }
  from '../src/ingest/shopifyStorefront.js'
import { pool, DB_TARGET } from '../src/db.js'

const dry = process.argv.includes('--dry')
const showAll = process.argv.includes('--all')

// Airtable field ids, same as weaverBackOffice.js. Duplicated deliberately: that
// module does not export them, and a wrong id here would silently store nulls.
const F = {
  sku: 'fldkPnSZwrSAxhrxQ',
  internalId: 'fld2iw5QkAElz9uFR',
  upc: 'fldQFco89N5gtV3es',
  hts: 'fldLYAdTtYYXxrStc',
  mismatch: 'fld1H2pahT5tNKesO',
}
const sVal = (v) => (Array.isArray(v) ? v[0] : v) ?? null
const s = sVal
const name = (v) => { const x = sVal(v); return x && typeof x === 'object' ? x.name ?? null : x }
const truthy = (v) => { const x = sVal(v); return x === 1 || x === true || x === '1' }
const bool = (v) => s(v) === 'T' || s(v) === true

console.log(`\n  Weaver sync → ${dry ? 'DRY RUN (no writes)' : DB_TARGET}`)

let nsRows, wvRecs, prRecs, r
let shopProducts = null, shopErr = null
try {
  ;[nsRows, wvRecs, prRecs, shopProducts] = await Promise.all([
    fetchNetsuiteItems(), fetchWeaverBackOffice(), fetchWeaverProducts(),
    // The storefront is a third party. If it is down, the NetSuite half of this
    // run is still worth recording, so this failure is caught and reported
    // rather than allowed to lose everything else.
    fetchShopifyProducts().catch((e) => { shopErr = e.message; return null }),
  ])
  r = reconcile(nsRows, wvRecs)
} catch (e) {
  console.error(`\n  ✗ could not run: ${e.message}\n`)
  process.exit(2)
}

const c = r.counts

// ── Stranded skus ──────────────────────────────────────────────────────────
// A NetSuite sku that matches no Weaver PRODUCT sku. Unlike the history tables
// this is answerable on the very first run, which is the point: it explains the
// existing MISMATCH rows without waiting for a rename to happen under us.
//
// Sized children carry a suffix (`-385`, `-M`) that parent skus do not, so a
// child is matched by its base. Suffixes are not always numeric —
// `Variation Suffix (for SKU)` emits `-` & size*10 for numbers but `-` & UPPER(size)
// otherwise — so strip at the last dash rather than matching \d+.
const productSkus = new Set(
  prRecs.map((x) => sVal(x.fields?.[PF.sku])).filter(Boolean).map((x) => x.toUpperCase()))
const baseOf = (sku) => { const i = sku.lastIndexOf('-'); return i > 0 ? sku.slice(0, i) : null }
const stranded = nsRows.filter((it) => {
  const sku = (it.itemid || '').toUpperCase()
  if (!sku) return false
  if (productSkus.has(sku)) return false
  const base = baseOf(sku)
  return !(base && productSkus.has(base))
})
// Inactive / Ignore-in-Airtable / Internal items are expected to have no Weaver
// product. So is anything predating Weaver — see docs/weaver-mirror.md.
const strandedBenign = (it) =>
  bool(it.isinactive) || bool(it.ignore_in_airtable) || it.product_type === 'Internal'
const strandedReal = stranded.filter((it) => !strandedBenign(it))

// ── UPC collisions ─────────────────────────────────────────────────────────
// A UPC on more than one ACTIVE NetSuite item. Weaver structurally cannot see
// this: `UPC Codes.Count Assigned SKUs` counts WEAVER VARIANTS, and a re-coded
// product still has exactly one variant — so the UPC reports "In Use", count 1,
// while sitting on two live items. UPCs are the one field a retailer keys on, so
// this is the highest-consequence check here and the cheapest to run.
const byUpc = new Map()
for (const it of nsRows) {
  const upc = (it.upccode || '').trim()
  if (!upc || bool(it.isinactive)) continue
  if (!byUpc.has(upc)) byUpc.set(upc, [])
  byUpc.get(upc).push(it)
}
const upcCollisions = [...byUpc.entries()]
  .filter(([, items]) => items.length > 1)
  .map(([upc, items]) => ({
    upc,
    skus: items.map((i) => i.itemid).sort(),
    ids: items.map((i) => String(i.id)),
    // A re-code twin shares silhouette digits AND colour, differing only in the
    // 2-letter weave code. Sharing a UPC there is defensible until the obsolete
    // item is inactivated. Anything else is one UPC on two different products.
    recodeTwin: new Set(items.map((i) =>
      (i.itemid || '').replace(/^([A-Z]{2}\d{5})[A-Z]{2}(-.*)$/, '$1$2'))).size === 1,
  }))
const upcHardConflict = upcCollisions.filter((x) => !x.recodeTwin)

// ── Shopify ────────────────────────────────────────────────────────────────
// Built in memory from the Airtable records so --dry works without a database.
const weaverProductRows = prRecs.map((rec) => {
  const f = rec.fields ?? {}
  return {
    airtable_record_id: rec.id,
    sku: sVal(f[PF.sku]),
    product_name: sVal(f[PF.name]),
    handle: sVal(f[PF.handle]),
    vendor: sVal(f[PF.vendor]),
    product_type: sVal(f[PF.productType]),
    option1_name: sVal(f[PF.option1Name]),
    shopify_product_id: sVal(f[PF.shopifyProductId]) != null
      ? String(sVal(f[PF.shopifyProductId])) : null,
    for_shopify: truthy(f[PF.forShopify]),
    product_status: name(f[PF.status]),
  }
})
const shopVariants = shopProducts ? shopifyVariants(shopProducts) : []
const shop = shopProducts ? compareShopify(shopVariants, weaverProductRows) : null
// Hoisted: both the summary lines and the detail listing need it, and they sit in
// separate `if (shop)` blocks.
const orphanReal = shop ? shop.orphan.filter((x) => !x.benign) : []

// Our SuiteQL filter is a superset of saved search 2419, so "missing" rows that are
// inactive, Internal, or flagged Ignore in Airtable are expected omissions.
const isBenign = (x) => x.inactive || x.ignoreInAirtable || x.internalOnly
const real = r.missingInWeaver.filter((x) => !isBenign(x))
const needsHuman = real.length + r.staleInWeaver.length + r.fieldDrift.length +
                   r.mismatchFlagged.length + upcCollisions.length +
                   (shop ? shop.counts.drift + orphanReal.length : 0)

console.log(`  NetSuite items ${c.netsuite}   Back Office ${c.weaver}   Weaver products ${prRecs.length}` +
  (shopProducts ? `   Shopify ${shopProducts.length}` : `   Shopify unavailable`) + '\n')
if (shopErr) console.log(`  ⚠ Shopify storefront unreachable: ${shopErr}\n`)

let runId = null
let firstSeen = new Map()   // "kind|internalId" -> earliest run date it appeared

if (!dry) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [run] } = await client.query(
      `INSERT INTO weaver_sync_run
         (netsuite_rows, weaver_rows, weaver_products, missing_in_weaver,
          stale_in_weaver, field_drift, mismatch_flagged, stranded_skus, upc_collisions,
          shopify_products, shopify_drift, shopify_orphan, shopify_missing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [c.netsuite, c.weaver, prRecs.length, real.length, c.staleInWeaver,
       c.fieldDrift, c.mismatchFlagged, strandedReal.length, upcCollisions.length,
       shopProducts?.length ?? null, shop?.counts.drift ?? null,
       shop?.counts.orphan ?? null, shop?.counts.missing ?? null],
    )
    runId = run.id

    // NetSuite snapshot. first_seen_at is preserved on conflict — it is the only
    // way to date an item's arrival, and NetSuite does not tell us.
    for (const it of nsRows) {
      await client.query(
        `INSERT INTO weaver_netsuite_item
           (internal_id, sku, upc, hts, parent_internal_id, inactive, ignore_in_airtable,
            product_type, provenance, image_file_id, shopify_gid, raw, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (internal_id) DO UPDATE SET
           sku = EXCLUDED.sku, upc = EXCLUDED.upc, hts = EXCLUDED.hts,
           parent_internal_id = EXCLUDED.parent_internal_id,
           inactive = EXCLUDED.inactive, ignore_in_airtable = EXCLUDED.ignore_in_airtable,
           product_type = EXCLUDED.product_type, provenance = EXCLUDED.provenance,
           image_file_id = EXCLUDED.image_file_id, shopify_gid = EXCLUDED.shopify_gid,
           raw = EXCLUDED.raw, observed_at = now()`,
        [String(it.id), it.itemid ?? null, it.upccode ?? null, it.hts ?? null,
         it.parent_id ? String(it.parent_id) : null, bool(it.isinactive),
         bool(it.ignore_in_airtable), it.product_type ?? null, it.provenance ?? null,
         it.image_file_id ? String(it.image_file_id) : null, it.shopify_gid ?? null,
         JSON.stringify(it)],
      )
      // The point of the whole exercise: every SKU an item has ever carried.
      if (it.itemid) {
        await client.query(
          `INSERT INTO weaver_sku_history (internal_id, sku)
           VALUES ($1,$2)
           ON CONFLICT (internal_id, sku) DO UPDATE SET last_seen_at = now()`,
          [String(it.id), it.itemid],
        )
      }
    }

    // Weaver products + their sku history. bool() on formula fields: Airtable
    // returns 1/0 for checkbox-typed formulas, true/false for real checkboxes.
    for (const rec of prRecs) {
      const f = rec.fields ?? {}
      const sku = sVal(f[PF.sku])
      await client.query(
        `INSERT INTO weaver_product
           (airtable_record_id, sku, style_number, product_name, product_status,
            product_type, has_errors, upc_status, shopify_product_id, duplicate_count,
            should_generate_variants, for_shopify, handle, vendor, option1_name,
            tags, body_html, raw, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
         ON CONFLICT (airtable_record_id) DO UPDATE SET
           sku = EXCLUDED.sku, style_number = EXCLUDED.style_number,
           product_name = EXCLUDED.product_name, product_status = EXCLUDED.product_status,
           product_type = EXCLUDED.product_type, has_errors = EXCLUDED.has_errors,
           upc_status = EXCLUDED.upc_status, shopify_product_id = EXCLUDED.shopify_product_id,
           duplicate_count = EXCLUDED.duplicate_count,
           should_generate_variants = EXCLUDED.should_generate_variants,
           for_shopify = EXCLUDED.for_shopify, handle = EXCLUDED.handle,
           vendor = EXCLUDED.vendor, option1_name = EXCLUDED.option1_name,
           tags = EXCLUDED.tags, body_html = EXCLUDED.body_html,
           raw = EXCLUDED.raw, observed_at = now()`,
        [rec.id, sku, sVal(f[PF.styleNumber]), sVal(f[PF.name]), name(f[PF.status]),
         sVal(f[PF.productType]), truthy(f[PF.hasErrors]), name(f[PF.upcStatus]),
         sVal(f[PF.shopifyProductId]) != null ? String(sVal(f[PF.shopifyProductId])) : null,
         Number.isFinite(Number(sVal(f[PF.duplicateCount]))) ? Number(sVal(f[PF.duplicateCount])) : null,
         truthy(f[PF.shouldGenerateVariants]), truthy(f[PF.forShopify]),
         sVal(f[PF.handle]), sVal(f[PF.vendor]), sVal(f[PF.option1Name]),
         sVal(f[PF.tags]), sVal(f[PF.bodyHtml]),
         JSON.stringify(f)],
      )
      // Only real skus. The formula emits guidance strings ("Select a Color.",
      // "Enter vendor SKU for third party item.") when links are missing, and
      // storing those as history would be noise that never resolves.
      if (sku && !/[a-z ]/.test(sku) && sku.length <= 40) {
        await client.query(
          `INSERT INTO weaver_product_sku_history (airtable_record_id, sku)
           VALUES ($1,$2)
           ON CONFLICT (airtable_record_id, sku) DO UPDATE SET last_seen_at = now()`,
          [rec.id, sku],
        )
      }
    }

    for (const rec of wvRecs) {
      const f = rec.fields ?? {}
      await client.query(
        `INSERT INTO weaver_back_office
           (airtable_record_id, internal_id, sku, upc, hts, mismatch_flag, raw, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (airtable_record_id) DO UPDATE SET
           internal_id = EXCLUDED.internal_id, sku = EXCLUDED.sku, upc = EXCLUDED.upc,
           hts = EXCLUDED.hts, mismatch_flag = EXCLUDED.mismatch_flag,
           raw = EXCLUDED.raw, observed_at = now()`,
        [rec.id, s(f[F.internalId]) != null ? String(s(f[F.internalId])) : null,
         s(f[F.sku]), s(f[F.upc]), s(f[F.hts]), name(f[F.mismatch]), JSON.stringify(f)],
      )
    }

    const finding = (kind, internalId, sku, detail, benign = false) =>
      client.query(
        `INSERT INTO weaver_divergence (run_id, kind, internal_id, sku, detail, benign)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [runId, kind, internalId ? String(internalId) : null, sku ?? null,
         detail ? JSON.stringify(detail) : null, benign],
      )

    for (const x of r.missingInWeaver)
      await finding('missing_in_weaver', x.internalId, x.sku,
        { productType: x.productType, inactive: !!x.inactive,
          ignoreInAirtable: !!x.ignoreInAirtable, internalOnly: !!x.internalOnly },
        isBenign(x))
    for (const x of r.staleInWeaver)
      await finding('stale_in_weaver', x.internalId, x.sku, { recordId: x.recordId })
    for (const x of r.fieldDrift)
      await finding('field_drift', x.internalId, x.sku, { diffs: x.diffs, recordId: x.recordId })
    for (const x of r.mismatchFlagged)
      await finding('mismatch_flagged', x.internalId, x.sku, { flag: x.flag, recordId: x.recordId })
    for (const x of upcCollisions)
      await finding('upc_collision', x.ids[0], x.upc,
        { upc: x.upc, skus: x.skus, internalIds: x.ids, recodeTwin: x.recodeTwin },
        false)
    for (const it of stranded)
      await finding('stranded_sku', it.id, it.itemid,
        { productType: it.product_type, inactive: bool(it.isinactive),
          ignoreInAirtable: bool(it.ignore_in_airtable) },
        strandedBenign(it))

    if (shopProducts) {
      for (const p of shopProducts) {
        await client.query(
          `INSERT INTO weaver_shopify_product
             (product_id, handle, title, vendor, product_type, option1_name, tags,
              image_count, variant_count, published_at, updated_at, raw, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (product_id) DO UPDATE SET
             handle = EXCLUDED.handle, title = EXCLUDED.title, vendor = EXCLUDED.vendor,
             product_type = EXCLUDED.product_type, option1_name = EXCLUDED.option1_name,
             tags = EXCLUDED.tags, image_count = EXCLUDED.image_count,
             variant_count = EXCLUDED.variant_count, published_at = EXCLUDED.published_at,
             updated_at = EXCLUDED.updated_at, raw = EXCLUDED.raw, observed_at = now()`,
          [String(p.id), p.handle ?? null, p.title ?? null, p.vendor ?? null,
           p.product_type ?? null, p.options?.[0]?.name ?? null,
           Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(/,\s*/) : []),
           (p.images ?? []).length, (p.variants ?? []).length,
           p.published_at ?? null, p.updated_at ?? null, JSON.stringify(p)],
        )
      }
      for (const v of shopVariants) {
        await client.query(
          `INSERT INTO weaver_shopify_variant
             (variant_id, product_id, sku, price, available, option1, position, raw, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (variant_id) DO UPDATE SET
             product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, price = EXCLUDED.price,
             available = EXCLUDED.available, option1 = EXCLUDED.option1,
             position = EXCLUDED.position, raw = EXCLUDED.raw, observed_at = now()`,
          [v.variantId, v.productId, v.sku, v.price, v.available, v.option1,
           v.position, JSON.stringify(v)],
        )
      }
      for (const x of shop.drift)
        await finding('shopify_drift', null, x.sku,
          { diffs: x.diffs, productId: x.productId, recordId: x.recordId })
      for (const x of shop.orphan)
        await finding('shopify_orphan', null, x.sku,
          { productId: x.productId, title: x.title, handle: x.handle,
            vendor: x.vendor, productType: x.productType }, !!x.benign)
      // NOT persisted as findings, deliberately. 708 products hold a Shopify ID
      // and are not on the storefront — for a seasonal brand with 1,418 products
      // and ~294 live, that is ordinary unpublishing, not divergence. Writing 708
      // rows per run would bloat the table and bury the 30 findings that matter.
      // The count lives on weaver_sync_run so the trend is still visible.
    }

    await client.query(
      `UPDATE weaver_sync_run SET finished_at = now(), ok = $2 WHERE id = $1`,
      [runId, needsHuman === 0],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`\n  ✗ database write failed, nothing recorded: ${e.message}\n`)
    client.release()
    await pool.end()
    process.exit(2)
  }
  client.release()

  // How long has each finding been present? This is what a snapshot cannot say.
  const { rows } = await pool.query(
    `SELECT kind, internal_id, min(r.started_at) AS since, count(DISTINCT r.id) AS runs
       FROM weaver_divergence d JOIN weaver_sync_run r ON r.id = d.run_id
      WHERE d.benign = false
      GROUP BY kind, internal_id`,
  )
  for (const x of rows) firstSeen.set(`${x.kind}|${x.internal_id}`, x)
}

const age = (kind, id) => {
  const f = firstSeen.get(`${kind}|${id}`)
  if (!f || Number(f.runs) <= 1) return 'new'
  const days = Math.floor((Date.now() - new Date(f.since)) / 86400000)
  return days >= 1 ? `${days}d, ${f.runs} runs` : `${f.runs} runs`
}

const line = (label, n, note = '') =>
  console.log(`  ${n === 0 ? '✓' : '•'} ${label.padEnd(34)} ${String(n).padStart(5)}${note ? '   ' + note : ''}`)
line('missing from Weaver (actionable)', real.length, 'in NetSuite, not mirrored')
line('missing from Weaver (expected)', r.missingInWeaver.length - real.length, 'inactive / Ignore / Internal')
line('stale in Weaver', r.staleInWeaver.length, 'mirrored, not in NetSuite')
line('field drift (sku/upc/hts)', r.fieldDrift.length)
line('flagged MISMATCH by Weaver', r.mismatchFlagged.length)
line('UPC on 2+ active items', upcCollisions.length,
     upcHardConflict.length ? `${upcHardConflict.length} on DIFFERENT products` : 'all re-code twins')
line('stranded sku (no Weaver product)', strandedReal.length,
     `${stranded.length - strandedReal.length} more inactive/ignored`)
if (shop) {
  line('Shopify field drift', shop.counts.drift, 'Shopify vs Weaver formula')
  line('Shopify orphans', orphanReal.length,
       `${shop.orphan.length - orphanReal.length} more gift card / Internal`)
  // Context, not a finding: listing is a merchandising decision and Weaver's
  // `For Shopify` marks eligibility, not intent to publish now.
  console.log(`  · ${String(shop.counts.missing).padStart(5)} eligible products not on the storefront ` +
              `(${shop.counts.notYetListed} never listed) — context, not counted`)
}

const show = (title, kind, rows, fmt, cap = 20) => {
  if (!rows.length) return
  console.log(`\n  ${title}`)
  for (const x of (showAll ? rows : rows.slice(0, cap)))
    console.log(`    ${fmt(x)}${dry ? '' : `   [${age(kind, x.internalId)}]`}`)
  if (!showAll && rows.length > cap) console.log(`    … +${rows.length - cap} more (--all)`)
}
show('NOT MIRRORED — these need a look:', 'missing_in_weaver', real, (x) =>
  `${x.internalId}  ${(x.sku || '').padEnd(24)} ${x.productType || '(no product type)'}`)
show('STALE — in Weaver, gone from NetSuite:', 'stale_in_weaver', r.staleInWeaver, (x) => `${x.internalId}  ${x.sku}`)
show('FIELD DRIFT:', 'field_drift', r.fieldDrift, (x) =>
  `${x.sku}  ` + x.diffs.map((d) => `${d.field}: NS='${d.netsuite}' vs Weaver='${d.weaver}'`).join('  '))
show('MISMATCH flagged by Weaver:', 'mismatch_flagged', r.mismatchFlagged, (x) => `${x.sku}  ${x.flag}`)
show('UPC COLLISIONS — Weaver reports these as healthy:', 'upc_collision',
  upcCollisions.map((x) => ({ internalId: x.ids[0], ...x })),
  (x) => `${x.upc}  ${x.recodeTwin ? 're-code twin ' : '⚠ DIFFERENT PRODUCTS '} ${x.skus.join(' + ')}`, 25)
show('STRANDED — active in NetSuite, no Weaver product:', 'stranded_sku',
  strandedReal.map((it) => ({ internalId: it.id, sku: it.itemid, productType: it.product_type })),
  (x) => `${x.internalId}  ${(x.sku || '').padEnd(28)} ${x.productType || '(none)'}`, 15)

if (shop) {
  const cap = showAll ? 1e9 : 12
  const sec = (title, rows, fmt) => {
    if (!rows.length) return
    console.log(`\n  ${title}`)
    for (const x of rows.slice(0, cap)) console.log('    ' + fmt(x))
    if (rows.length > cap) console.log(`    … +${rows.length - cap} more (--all)`)
  }
  sec('SHOPIFY DRIFT — Shopify disagrees with Weaver:', shop.drift, (x) =>
    `${(x.sku || '').padEnd(26)} ` +
    x.diffs.map((d) => `${d.field}: Shopify='${String(d.shopify).slice(0, 40)}' vs Weaver='${String(d.weaver).slice(0, 40)}'`).join('  '))
  sec('SHOPIFY ORPHANS — live, but no Weaver product owns the sku:', orphanReal, (x) =>
    `${(x.sku || '').padEnd(26)} ${x.vendor || ''} · ${x.title || ''}`)

}

if (!dry) {
  const { rows: [h] } = await pool.query(
    `SELECT count(*) FILTER (WHERE n > 1) AS renamed, count(*) AS items FROM (
       SELECT internal_id, count(*) AS n FROM weaver_sku_history GROUP BY internal_id) t`)
  console.log(`\n  recorded as run #${runId} · ${h.items} items tracked · ${h.renamed} have carried more than one SKU`)
}
console.log(needsHuman === 0
  ? '\n  ✓ in sync — nothing to do\n'
  : `\n  ${needsHuman} item(s) need a decision. Nothing was changed in NetSuite or Airtable.\n`)

await pool.end()
process.exit(needsHuman === 0 ? 0 : 1)
