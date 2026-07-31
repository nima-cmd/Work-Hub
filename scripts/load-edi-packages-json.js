// scripts/load-edi-packages-json.js — load the EDI Packages Volume feed from a
// JSON file instead of a CSV export.
//
//   node --env-file=.env.local scripts/load-edi-packages-json.js <file.json>
//   … --dry    parse, diff and print; write nothing
//
// Why this exists (Nima, 2026-08-01): the routing feed is the ONE remaining
// CSV-only source. Its NetSuite saved search (customsearch3947 "EDI Packages
// Volume", record type Packages) reads Naghedi's custom EDI fields — which is
// why the standard ItemFulfillmentPackage table's weights don't match it — and
// SuiteQL cannot run saved searches, so the app's TBA path can't pull it. Until
// a RESTlet or a SuiteQL equivalent exists, the search's rows can be handed over
// as JSON and loaded here, skipping the CSV round-trip.
//
// Input is the saved search's OWN column names, so the rows go through the
// existing fromEdiPackagesVolume mapper untouched:
//   [{ "PO Number - DC": "7242978-SC", "Total Weight (lbs)": "361",
//      "Carton Count": "10", "Total Units": "287",
//      "Cubic Feet (Rounded)": "38", "Cubic Feet": "35.1", "BOL": "…" }]
//
// REPLACES the feed rather than upserting into it. That matters: the search
// returns what is packed and awaiting routing, so a PO-DC absent from it has
// been routed and shipped. Leaving stale rows behind would be actively harmful —
// consolidateRouting groups by (partner, DC) across every feed row, so an old
// shipped PO sharing a DC with new work merges into one group, changes its
// dcPoKey, and detaches the archived BOL that used to match it.
import { readFileSync } from 'node:fs'
import { fromEdiPackagesVolume } from '../src/ingest/savedSearches.js'
import { loadEdiPackages, recordSnapshot } from '../src/ingest/loadToDb.js'
import { pool, withTransaction } from '../src/db.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry') || args.includes('--dry-run')
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('usage: load-edi-packages-json.js <file.json> [--dry]')
  process.exit(1)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const rows = Array.isArray(raw) ? raw : raw.rows
const mapped = fromEdiPackagesVolume(rows)
if (!mapped.length) {
  console.error('✗ no usable rows — expected the saved search\'s own column names')
  process.exit(1)
}

const { rows: existing } = await pool.query('SELECT po_dc FROM edi_packages')
const incoming = new Set(mapped.map((r) => r.poDc))
const dropping = existing.map((r) => r.po_dc).filter((k) => !incoming.has(k))

console.log(`incoming ${mapped.length} PO-DC rows:`)
for (const r of mapped) {
  console.log(`  ${String(r.poDc).padEnd(14)} cartons=${String(r.cartons).padStart(3)}  ${String(r.weight).padStart(4)} lb  ${String(r.units).padStart(4)} units  ${r.cubicFeetRaw} cu ft`)
}
if (dropping.length) {
  console.log(`\nremoving ${dropping.length} PO-DC row(s) no longer in the search (routed & shipped):`)
  console.log('  ' + dropping.join(', '))
}

if (dry) {
  console.log('\n(dry run — nothing written)')
  await pool.end()
  process.exit(0)
}

await withTransaction(async (db) => {
  await db.query('DELETE FROM edi_packages')
  const n = await loadEdiPackages(mapped, db)
  await recordSnapshot('ediPackagesVolume', n, new Date(), db)
  console.log(`\n✓ feed replaced — ${n} rows loaded`)
})

await pool.end()
