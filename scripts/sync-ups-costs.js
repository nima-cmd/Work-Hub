// scripts/sync-ups-costs.js — harvest real UPS billed costs from ShipStation.
//
//   npm run sync:ups-costs                     last 24 months
//   npm run sync:ups-costs -- --months 36      a longer window
//   npm run sync:ups-costs -- --from 2023-01-01 --to 2025-01-01
//   npm run sync:ups-costs -- --dry            exercise everything, roll back
//
// READ-ONLY against ShipStation (GETs on /shipments); the only writes are to Neon.
// Slow by design — V1 allows 40 requests/minute and a wide window is hundreds of
// pages, so the pull waits out rate limits instead of failing. Run it unattended.
//
// The point of the exercise is the WHOLESALE account (C6J610). Watch the per-account
// summary at the end: a run that returns only 18GE01 rows found no wholesale history
// in the window and the rate lookup will have nothing to compare against.
import { syncShipmentCosts } from '../src/ingest/shipstationCosts.js'
import { shipstationConfigured } from '../src/ingest/shipstationCosts.js'
import { WHOLESALE_ACCOUNT } from '../src/model/upsRates.js'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const dry = argv.some((a) => a === '--dry' || a === '--dry-run')

const months = Number(flag('months')) || 24
const to = flag('to')
let from = flag('from')
if (!from) {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  from = d.toISOString().slice(0, 10)
}

if (!shipstationConfigured()) {
  console.error('✗ ShipStation not configured — set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET (see npm run check:shipstation)')
  await pool.end()
  process.exit(1)
}

console.log(`UPS billed costs ← ShipStation  ${from} → ${to || 'today'}${dry ? '  (DRY RUN — nothing persists)' : ''}`)
console.log('Paging (40 req/min, so this takes a while) …')

let lastLogged = 0
const r = await syncShipmentCosts({
  from, to, dryRun: dry,
  onPage: ({ page, pages, rows }) => {
    // Progress every 10 pages — enough to show it's alive, not a wall of output.
    if (page === 1 || page === pages || page - lastLogged >= 10) {
      console.log(`  page ${page}/${pages} · ${rows} shipments`)
      lastLogged = page
    }
  },
})

if (!r.ok) {
  console.error(`✗ ${r.error}`)
  if (r.configured === false) console.error('  credentials missing')
  await pool.end()
  process.exit(1)
}

console.log(`\nread ${r.rows.length} UPS shipments${r.partial ? ' (PARTIAL — the pull stopped early)' : ''}`)
console.log('\nby UPS account:')
for (const [acct, v] of Object.entries(r.byAccount || {}).sort((a, b) => b[1].n - a[1].n)) {
  const tag = acct === WHOLESALE_ACCOUNT ? '  ← WHOLESALE' : ''
  console.log(`  ${acct.padEnd(12)} ${String(v.n).padStart(6)} shipments · ${String(v.withCost).padStart(6)} with a billed cost · avg $${v.avgCost ?? '—'}${tag}`)
}

const wholesale = r.byAccount?.[WHOLESALE_ACCOUNT]
if (!wholesale?.withCost) {
  console.log(`\n⚠ No billed ${WHOLESALE_ACCOUNT} history in this window — widen it (--months 36) or the rate lookup has nothing to compare.`)
}

console.log(`\n✓ ${r.loaded} rows loaded${r.rolledBack ? ' — then rolled back (dry run)' : ''}`)
await pool.end()
