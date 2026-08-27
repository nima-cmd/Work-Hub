// src/ingest/transferOrders.js — pull the transfers we track, and their fulfilments.
//
// Read-only against NetSuite; writes transfer_order and fulfillments.
//
// ⚠️ ONLY THE TRACKED TRANSFERS ARE LOADED, and that restriction is load-bearing. There
// are 187 transfer orders and 173 of them are not this work — mostly stock moving INTO
// the warehouse. Loading every transfer's fulfilment into `fulfillments` would put 173
// unrelated shipments in front of the ~15 queries that read that table WITHOUT joining
// orders, which is precisely the silent-inflation this design avoided by keeping
// transfers out of `orders` in the first place.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { transferOrderSql, transferFulfillmentSql, transferTrackingSql, IF_STATUS } from './netsuiteSync.js'
import { trackedTransfers, untrackedDestinations } from '../model/transferOrder.js'
import { pool } from '../db.js'

export async function syncTransferOrders({ dryRun = false } = {}) {
  if (!netsuiteConfigured()) return { configured: false }

  const all = (await runSuiteQL(transferOrderSql())).rows || []
  const keep = trackedTransfers(all.map((r) => ({
    toNumber: r.to_number, destination: r.destination, status: r.status, trandate: r.trandate,
  })))
  const kept = new Set(keep.map((t) => t.toNumber))

  const allIfs = (await runSuiteQL(transferFulfillmentSql())).rows || []
  const ifs = allIfs.filter((r) => kept.has(r.to_number))

  // Tracking is the number Nima checks by hand — ShipStation's delivery endpoint is
  // behind a plan upgrade, so this is how a transfer's progress is followed at all.
  const allTracking = (await runSuiteQL(transferTrackingSql())).rows || []
  const ifNumbers = new Set(ifs.map((r) => r.if_number))
  const tracking = new Map()
  for (const r of allTracking) {
    if (!ifNumbers.has(r.if_number)) continue
    if (!tracking.has(r.if_number)) tracking.set(r.if_number, [])
    tracking.get(r.if_number).push(r.trackingnumber)
  }

  const report = {
    configured: true,
    fetched: all.length,
    tracked: keep.length,
    fulfillments: ifs.length,
    withTracking: tracking.size,
    // ⚠️ Reported, not silently dropped. A NEW destination appearing in NetSuite is a
    // thing to tell Nima about — the alternative is freight quietly going untracked
    // because nobody knew a location had been added.
    untracked: untrackedDestinations(all.map((r) => ({ destination: r.destination }))),
  }
  if (dryRun) return { ...report, dryRun: true }

  for (const t of keep) {
    await pool.query(
      `INSERT INTO transfer_order (to_number, destination, status, trandate, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (to_number) DO UPDATE SET
         destination = COALESCE(EXCLUDED.destination, transfer_order.destination),
         status      = COALESCE(EXCLUDED.status, transfer_order.status),
         trandate    = COALESCE(EXCLUDED.trandate, transfer_order.trandate),
         updated_at  = now()`,
      [t.toNumber, t.destination || null, t.status || null, t.trandate || null])
  }

  for (const f of ifs) {
    // ⚠️ so_number carries the TRANSFER number. There is no FK any more precisely so
    // this is legal; check:counters asserts it resolves to exactly one parent table.
    await pool.query(
      `INSERT INTO fulfillments (if_number, so_number, status, if_date, tracking_numbers, if_created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (if_number) DO UPDATE SET
         so_number        = COALESCE(EXCLUDED.so_number, fulfillments.so_number),
         status           = COALESCE(EXCLUDED.status, fulfillments.status),
         if_date          = COALESCE(EXCLUDED.if_date, fulfillments.if_date),
         tracking_numbers = COALESCE(EXCLUDED.tracking_numbers, fulfillments.tracking_numbers),
         if_created_at    = COALESCE(EXCLUDED.if_created_at, fulfillments.if_created_at),
         updated_at       = now()`,
      // ⚠️ MAPPED, not stored raw. NetSuite returns 'A'/'B'/'C'; the sales-order path
      // stores 'Picked'/'Packed'/'Shipped' through IF_STATUS, and a transfer landing in
      // the same column with a one-letter code would make every status comparison in the
      // app — and every human reading the table — quietly wrong for exactly these rows.
      [f.if_number, f.to_number, IF_STATUS[f.status] || f.status || null, f.trandate || null,
       tracking.get(f.if_number) || null, f.createddate || null])
  }

  return { ...report, written: keep.length + ifs.length }
}
