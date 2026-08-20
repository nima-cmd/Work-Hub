// scripts/check-weaver.js  (destined for Work-Hub)
//
// Is Weaver's picture of NetSuite still true? Reports; changes nothing.
//
//   npm run check:weaver              human-readable
//   npm run check:weaver -- --json    machine-readable, for the cron
//
// Exit codes:  0 in sync (or only known-benign)   1 divergence needing a human
//              2 could not run (credentials, network)
//
// Safe to run any time. No writes to NetSuite, Airtable or Postgres.

import { fetchNetsuiteItems, fetchWeaverBackOffice, reconcile } from '../src/ingest/weaverBackOffice.js'

const json = process.argv.includes('--json')
const showAll = process.argv.includes('--all')

let r
try {
  const [ns, wv] = await Promise.all([fetchNetsuiteItems(), fetchWeaverBackOffice()])
  r = reconcile(ns, wv)
} catch (e) {
  if (json) console.log(JSON.stringify({ ok: false, error: e.message }))
  else console.error(`✗ could not run: ${e.message}`)
  process.exit(2)
}

if (json) { console.log(JSON.stringify({ ok: true, ...r })); process.exit(0) }

const c = r.counts
console.log(`NetSuite items ${c.netsuite}   Weaver Back Office ${c.weaver}\n`)

// Split the benign from the actionable. Our SuiteQL filter is a superset of
// saved search 2419, so "missing" rows that are inactive or flagged
// "Ignore in Airtable" are expected — the mirror is right to omit them.
const isBenign = (x) => x.inactive || x.ignoreInAirtable || x.internalOnly
const benign = r.missingInWeaver.filter(isBenign)
const real   = r.missingInWeaver.filter((x) => !isBenign(x))

const line = (label, n, note = '') =>
  console.log(`  ${n === 0 ? '✓' : '•'} ${label.padEnd(34)} ${String(n).padStart(5)}${note ? '   ' + note : ''}`)

line('missing from Weaver (actionable)', real.length, 'in NetSuite, not mirrored')
line('missing from Weaver (expected)', benign.length, 'inactive / Ignore in Airtable / Internal')
line('stale in Weaver', r.staleInWeaver.length, 'mirrored, not in NetSuite')
line('field drift (sku/upc/hts)', r.fieldDrift.length)
line('flagged MISMATCH by Weaver', r.mismatchFlagged.length)

const show = (title, rows, fmt, cap = 20) => {
  if (!rows.length) return
  console.log(`\n${title}`)
  for (const x of (showAll ? rows : rows.slice(0, cap))) console.log('    ' + fmt(x))
  if (!showAll && rows.length > cap) console.log(`    … +${rows.length - cap} more (--all)`)
}
show('NOT MIRRORED — these need a look:', real, (x) =>
  `${x.internalId}  ${(x.sku || '').padEnd(24)} ${x.productType || '(no product type)'}`)
show('STALE — in Weaver, gone from NetSuite:', r.staleInWeaver, (x) => `${x.internalId}  ${x.sku}  (${x.recordId})`)
show('FIELD DRIFT:', r.fieldDrift, (x) =>
  `${x.sku}  ` + x.diffs.map((d) => `${d.field}: NS='${d.netsuite}' vs Weaver='${d.weaver}'`).join('  '))
show('MISMATCH flagged by Weaver:', r.mismatchFlagged, (x) => `${x.sku}  ${x.flag}`)

const needsHuman = real.length + r.staleInWeaver.length + r.fieldDrift.length + r.mismatchFlagged.length
console.log(needsHuman === 0
  ? '\n✓ in sync — nothing to do'
  : `\n${needsHuman} item(s) need a decision. Nothing was changed.`)
process.exit(needsHuman === 0 ? 0 : 1)
