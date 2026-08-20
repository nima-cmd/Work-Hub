// src/ingest/weaverBackOffice.js  (destined for Work-Hub)
//
// Step 2 of the Weaver round trip, automated: read NetSuite item state, read
// Weaver's Netsuite Back Office mirror, and report what diverges.
//
// READ-ONLY. Nothing here writes to NetSuite or Airtable. `reconcile()` returns a
// plain object; deciding what to do about it is a separate, explicit step.
//
// Why SuiteQL and not saved search 2419:
//   The search's filter is not exposed by any API, so a replica would drift
//   silently the moment someone edits it in the UI. We own the filter here
//   instead. It is deliberately a SUPERSET of 2419 (4,231 InvtPart rows vs the
//   search's 4,099) — a superset can never hide a NetSuite item from us, and the
//   extra rows become an explicit classification we control rather than a
//   mystery we inherit. Verified against 2419 on 2026-08-19; see
//   docs/step2-reconciliation.md.

import crypto from 'node:crypto'

// ── NetSuite ───────────────────────────────────────────────────────────────
// Reuses Work-Hub's existing signer: buildAuthHeader + netsuiteCreds from
// ./netsuiteApi.js. SuiteQL paginates via limit/offset QUERY params, and those
// must be inside the OAuth signature base string — netsuiteApi.js already does
// this correctly; do not hand-roll it.
import { netsuiteCreds, buildAuthHeader, normalizeAccount } from './netsuiteApi.js'

const SUITEQL = (acct) =>
  `https://${normalizeAccount(acct)}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`

// One row per NetSuite item we consider Weaver's business.
const ITEM_SQL = `
  SELECT id, itemid, upccode, custitem_harmonized_system_code AS hts,
         custitem_hb_parentitem AS parent_id, isinactive,
         custitem_ignore_in_airtable AS ignore_in_airtable,
         custitem_product_type AS product_type,
         custitem_provenance AS provenance,
         custitem_atlas_item_image AS image_file_id,
         custitem_shopify_product_gid AS shopify_gid
  FROM item
  WHERE itemtype = 'InvtPart'
  ORDER BY id`

const PAGE = 1000

export async function fetchNetsuiteItems({ fetchImpl = fetch } = {}) {
  const creds = netsuiteCreds()
  const baseUrl = SUITEQL(creds.account)
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const queryParams = { limit: String(PAGE), offset: String(offset) }
    const url = `${baseUrl}?limit=${PAGE}&offset=${offset}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: buildAuthHeader({ method: 'POST', baseUrl, queryParams, creds }),
        'Content-Type': 'application/json',
        Prefer: 'transient',
      },
      body: JSON.stringify({ q: ITEM_SQL }),
    })
    if (!res.ok) throw new Error(`SuiteQL ${res.status}: ${(await res.text()).slice(0, 400)}`)
    const body = await res.json()
    rows.push(...(body.items || []))
    // hasMore is authoritative; totalResults alone has bitten us before.
    if (!body.hasMore) {
      if (body.totalResults != null && rows.length !== body.totalResults) {
        throw new Error(`short read: got ${rows.length} of ${body.totalResults}`)
      }
      break
    }
  }
  return rows
}

// ── Weaver (Airtable) ──────────────────────────────────────────────────────
// NOTE: the Airtable REST API caps pageSize at 100 — not 2000. 4,099 records is
// ~41 requests. The rate limit is 5 req/sec per base, so pace it or you will
// start collecting 429s.

const BASE = 'app4dbJIctbXUrCxp'
const TBL_BACK_OFFICE = 'tbl2gb0rQeKVIabww'
const F = {
  sku: 'fldkPnSZwrSAxhrxQ',
  internalId: 'fld2iw5QkAElz9uFR',
  upc: 'fldQFco89N5gtV3es',
  hts: 'fldLYAdTtYYXxrStc',
  mismatch: 'fld1H2pahT5tNKesO',
}

// Weaver's Products table — the authoring side, where a SKU is COMPUTED from
// silhouette + weave code. That computation is why we need this table at all:
// when a weave code changes (FK -> EF), the Airtable record id stays put and the
// SKU moves underneath it. NetSuite keeps the old SKU forever. Nothing in Weaver
// records that the old one existed, so its Back Office rows strand — which is all
// 17 MISMATCH rows. Record id is the stable key here, exactly as internal id is
// on the NetSuite side.
const TBL_PRODUCTS = 'tbl05Cacp1frIPEWI'
const PF = {
  sku: 'fld8IRom6kEaze0at',
  styleNumber: 'fldIWELbIiQkT0Sdb',
  name: 'fldCxNaG1cOK5opN7',
  status: 'fldANEWdBXRSndcNR',
  productType: 'fldtfNOLHiOCGCBIy',
  hasErrors: 'fldV1vDX59FxejdKV',
  upcStatus: 'fldp4gANu2EejKeri',
  shopifyProductId: 'fldWZGZtxnoNzx9l6',
  duplicateCount: 'fldUvjHzcx4HyK0Gt',
  shouldGenerateVariants: 'fld83Z3Acwe1PFCW4',
  forShopify: 'fldzubDqRq6iCN1QC',
  // Added for the Shopify comparison. Each is a Weaver formula, so a difference
  // against Shopify means Shopify was edited directly or an upload never landed.
  handle: 'fldTEVd2s337aoxDe',
  vendor: 'flds8rQC1yFp0uene',
  option1Name: 'fldKvRxtIWHwBGcmU',
  tags: 'flddOK3YKlkjwgJzg',
  bodyHtml: 'fldXzKPAaFYJjYkRG',
}
export const PRODUCT_FIELDS = PF

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Shared pager. pageSize is capped at 100 by the REST API (NOT 2000 — that is the
// MCP tool's limit, and confusing the two produces a silent short read), and the
// rate limit is 5 req/sec per base, so this paces itself at ~4.5.
async function fetchAirtableTable(tableId, fieldIds, { token, fetchImpl }) {
  if (!token) throw new Error('AIRTABLE_PAT is not set (must be scoped to Weaver BY NAME)')
  const fields = fieldIds.map((f) => `fields%5B%5D=${f}`).join('&')
  const out = []
  let offset
  do {
    const url = `https://api.airtable.com/v0/${BASE}/${tableId}` +
                `?pageSize=100&returnFieldsByFieldId=true&${fields}` +
                (offset ? `&offset=${offset}` : '')
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 429) { await sleep(1500); continue }   // documented backoff
    if (!res.ok) throw new Error(`Airtable ${res.status} on ${tableId}: ${(await res.text()).slice(0, 400)}`)
    const body = await res.json()
    out.push(...body.records)
    offset = body.offset
    await sleep(220)
  } while (offset)
  return out
}

export async function fetchWeaverBackOffice({ token = process.env.AIRTABLE_PAT, fetchImpl = fetch } = {}) {
  return fetchAirtableTable(TBL_BACK_OFFICE, Object.values(F), { token, fetchImpl })
}

export async function fetchWeaverProducts({ token = process.env.AIRTABLE_PAT, fetchImpl = fetch } = {}) {
  return fetchAirtableTable(TBL_PRODUCTS, Object.values(PF), { token, fetchImpl })
}

// ── Reconcile ──────────────────────────────────────────────────────────────
// Keyed on Internal ID, never on sku. SKUs move when a weave code changes (the
// NS47300EF/FK Biarritz case), and a sku-keyed join reports one style as both
// missing AND stale — two phantom findings from one real change.

const s = (v) => (v == null ? '' : String(v).trim())

export function reconcile(nsRows, weaverRecords) {
  const ns = new Map(nsRows.map((r) => [s(r.id), r]))
  const wv = new Map()
  for (const rec of weaverRecords) {
    const id = s(rec.fields?.[F.internalId])
    if (id) wv.set(id, rec)
  }

  const missingInWeaver = []   // NetSuite has it, the mirror does not
  const staleInWeaver = []     // mirror has it, NetSuite (our filter) does not
  const fieldDrift = []        // both have it, a field disagrees
  const mismatchFlagged = []   // Weaver's own MISMATCH formula fired

  for (const [id, item] of ns) {
    if (!wv.has(id)) {
      // Not automatically a problem: our filter is a superset of the saved
      // search. Classify, do not assume.
      //
      // product_type = 'Internal' is the clean discriminator for everything the
      // saved search excludes on purpose: bag straps (STRAP-SMALL-*,
      // STRAP-PETIT-*), placeholder styles (SN000-*), legacy SKUs (SN0218-*,
      // SN315-356-*) and junk ('X', 'STRAP'). Verified 2026-08-19 — an
      // attribute, not a regex on SKU shape, because SKU shapes drift.
      missingInWeaver.push({
        internalId: id, sku: item.itemid,
        productType: s(item.product_type),
        ignoreInAirtable: s(item.ignore_in_airtable) === 'T',
        inactive: s(item.isinactive) === 'T',
        internalOnly: s(item.product_type) === 'Internal',
      })
    }
  }
  for (const [id, rec] of wv) {
    if (!ns.has(id)) staleInWeaver.push({ internalId: id, sku: s(rec.fields?.[F.sku]), recordId: rec.id })
  }
  for (const [id, item] of ns) {
    const rec = wv.get(id)
    if (!rec) continue
    const f = rec.fields || {}
    const diffs = []
    if (s(item.itemid) !== s(f[F.sku])) diffs.push({ field: 'sku', netsuite: s(item.itemid), weaver: s(f[F.sku]) })
    if (s(item.upccode) !== s(f[F.upc])) diffs.push({ field: 'upc', netsuite: s(item.upccode), weaver: s(f[F.upc]) })
    if (s(item.hts) !== s(f[F.hts])) diffs.push({ field: 'hts', netsuite: s(item.hts), weaver: s(f[F.hts]) })
    if (diffs.length) fieldDrift.push({ internalId: id, sku: item.itemid, recordId: rec.id, diffs })
    const mm = f[F.mismatch]
    const mmName = typeof mm === 'object' && mm ? mm.name : mm
    if (mmName) mismatchFlagged.push({ internalId: id, sku: item.itemid, recordId: rec.id, flag: mmName })
  }

  return {
    counts: {
      netsuite: ns.size, weaver: wv.size,
      missingInWeaver: missingInWeaver.length,
      staleInWeaver: staleInWeaver.length,
      fieldDrift: fieldDrift.length,
      mismatchFlagged: mismatchFlagged.length,
    },
    missingInWeaver, staleInWeaver, fieldDrift, mismatchFlagged,
  }
}
