// src/ingest/loadToDb.js
// Upserts parsed pipeline data into Postgres. Keyed on NetSuite natural keys
// (SO#, IF#, INV#) so re-importing the same saved search UPDATES rows instead
// of duplicating them — that's what lets us snapshot over time and detect stalls.

import { pool } from '../db.js'

// Orders — one row per SO. `last_movement` only bumps when the stage changes,
// so we can later flag "stuck N days in the same stage".
export async function loadOrders(orders, db = pool) {
  let n = 0
  for (const o of orders) {
    if (!o.soNumber || o.soNumber === 'UNLINKED') continue
    await db.query(
      `INSERT INTO orders
         (so_number, customer, location, po_number, is_ats, source, stage, so_status,
          qty_ordered, qty_allocated, qty_fulfilled, amount_paid, shipping_status,
          start_date, ship_date, cancel_date, notes, approval_status, billing_status,
          last_seen, last_movement, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), now(), now())
       ON CONFLICT (so_number) DO UPDATE SET
         customer        = COALESCE(EXCLUDED.customer, orders.customer),
         location        = COALESCE(EXCLUDED.location, orders.location),
         po_number       = COALESCE(EXCLUDED.po_number, orders.po_number),
         is_ats          = EXCLUDED.is_ats,
         source          = COALESCE(EXCLUDED.source, orders.source),
         so_status       = COALESCE(EXCLUDED.so_status, orders.so_status),
         qty_ordered     = COALESCE(EXCLUDED.qty_ordered, orders.qty_ordered),
         qty_allocated   = COALESCE(EXCLUDED.qty_allocated, orders.qty_allocated),
         qty_fulfilled   = COALESCE(EXCLUDED.qty_fulfilled, orders.qty_fulfilled),
         amount_paid     = COALESCE(EXCLUDED.amount_paid, orders.amount_paid),
         shipping_status = COALESCE(EXCLUDED.shipping_status, orders.shipping_status),
         start_date      = COALESCE(EXCLUDED.start_date, orders.start_date),
         ship_date       = COALESCE(EXCLUDED.ship_date, orders.ship_date),
         cancel_date     = COALESCE(EXCLUDED.cancel_date, orders.cancel_date),
         notes           = COALESCE(EXCLUDED.notes, orders.notes),
         approval_status = COALESCE(EXCLUDED.approval_status, orders.approval_status),
         billing_status  = COALESCE(EXCLUDED.billing_status, orders.billing_status),
         last_seen       = now(),
         last_movement   = CASE WHEN orders.stage IS DISTINCT FROM EXCLUDED.stage
                                THEN now() ELSE orders.last_movement END,
         stage           = EXCLUDED.stage,
         updated_at      = now()`,
      [
        o.soNumber, o.customer || null, o.location || null, o.poNumber || null, o.isAts ?? null,
        o.source || null, o.stage, o.soStatus || null, o.qtyOrdered ?? null,
        o.qtyAllocated ?? null, o.qtyFulfilled ?? null, o.amountPaid ?? null,
        o.shippingStatus || null, o.startDate || null, o.shipDate || null,
        o.cancelDate || null, o.notes || null, o.approvalStatus || null, o.billingStatus || null,
      ],
    )
    n++
  }
  return n
}

// Item fulfillments — from any source record that carries an IF number.
export async function loadFulfillments(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.ifNumber) continue
    const so = r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null
    await db.query(
      `INSERT INTO fulfillments
         (if_number, so_number, status, packed_status, days_pending, invoice_number, if_date, actual_ship_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (if_number) DO UPDATE SET
         so_number        = COALESCE(EXCLUDED.so_number, fulfillments.so_number),
         status           = COALESCE(EXCLUDED.status, fulfillments.status),
         packed_status    = COALESCE(EXCLUDED.packed_status, fulfillments.packed_status),
         days_pending     = COALESCE(EXCLUDED.days_pending, fulfillments.days_pending),
         invoice_number   = COALESCE(EXCLUDED.invoice_number, fulfillments.invoice_number),
         if_date          = COALESCE(EXCLUDED.if_date, fulfillments.if_date),
         actual_ship_date = COALESCE(EXCLUDED.actual_ship_date, fulfillments.actual_ship_date),
         updated_at       = now()`,
      [
        r.ifNumber, so, r.ifStatus || r.packedStatus || null, r.packedStatus || null,
        r.daysPending ?? null, r.invoice || null, r.date || null, r.actualShipDate || null,
      ],
    )
    n++
  }
  return n
}

// Invoices — from records carrying an INV number tied to an SO.
export async function loadInvoices(records, db = pool) {
  let n = 0
  for (const r of records) {
    const inv = r.invoice
    if (!inv || !/^INV/i.test(inv)) continue
    const so = r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null
    await db.query(
      `INSERT INTO invoices
         (inv_number, so_number, status, shipping_status, amount_remaining, ship_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (inv_number) DO UPDATE SET
         so_number        = COALESCE(EXCLUDED.so_number, invoices.so_number),
         status           = COALESCE(EXCLUDED.status, invoices.status),
         shipping_status  = COALESCE(EXCLUDED.shipping_status, invoices.shipping_status),
         amount_remaining = COALESCE(EXCLUDED.amount_remaining, invoices.amount_remaining),
         ship_date        = COALESCE(EXCLUDED.ship_date, invoices.ship_date),
         updated_at       = now()`,
      [inv, so, r.invoiceStatus || r.soStatus || null, r.shippingStatus || null, r.amountRemaining ?? null, r.shipDate || null],
    )
    n++
  }
  return n
}

// Prune orders no longer in the current Order Pipeline export. Once an order
// leaves that search it has progressed past the open pipeline (shipped/closed),
// so it should drop off the board rather than linger with a stale stage.
// Cascades to its fulfillments; invoices unlink (ON DELETE SET NULL).
// Call ONLY when the full order-pipeline export was part of this ingest —
// pruning against a partial upload would wrongly delete live orders.
export async function pruneOrders(keepSoNumbers, db = pool) {
  const keep = [...new Set(keepSoNumbers.filter((s) => s && s !== 'UNLINKED'))]
  if (!keep.length) return 0 // never prune against an empty set (would wipe the table)
  const { rowCount } = await db.query('DELETE FROM orders WHERE so_number <> ALL($1::text[])', [keep])
  return rowCount
}

// Record that an import happened (for stall detection + freshness warnings).
// fileModified = the export file's mtime, so we can tell how old the data is.
export async function recordSnapshot(source, rowCount, fileModified = null, db = pool) {
  await db.query(
    'INSERT INTO import_snapshots (source, row_count, file_modified) VALUES ($1, $2, $3)',
    [source, rowCount, fileModified],
  )
}
