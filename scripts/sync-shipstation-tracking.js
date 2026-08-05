#!/usr/bin/env node
// Pull carrier facts back onto the ShipStation orders we pushed. READ-ONLY
// against ShipStation — see src/ingest/shipstationTracking.js for why that
// matters and why a ship date here is not a departure.
//
//   npm run sync:shipstation-tracking
//
// Safe to run as often as you like: it only ever UPDATEs rows we already own.
import { syncShipstationTracking } from '../server/queries.js'
import { pool } from '../src/db.js'

const pages = Number(process.argv.find((a) => a.startsWith('--pages='))?.split('=')[1] || 3)
// --backfill rebuilds rows for orders pushed before shipstation_order existed.
const backfill = process.argv.includes('--backfill')

try {
  const r = await syncShipstationTracking({ pages, backfill })
  if (!r.ok) {
    console.error(`✗ ${r.configured === false ? 'ShipStation is not configured' : r.error}`)
    process.exitCode = 1
  } else if (!r.known) {
    console.log('Nothing pushed yet — no orders to harvest against.')
  } else {
    if (r.backfilled) console.log(`Backfilled ${r.backfilled} order(s) pushed before this table existed.`)
    console.log(`Scanned ${r.scanned} recent shipments · ${r.matched} were ours · ${r.applied} rows updated (of ${r.known} pushed).`)
    if (r.matched < r.known) {
      console.log(`${r.known - r.matched} pushed order(s) have no label yet — expected: a human buys those in ShipStation.`)
    }
  }
} finally {
  await pool.end()
}
