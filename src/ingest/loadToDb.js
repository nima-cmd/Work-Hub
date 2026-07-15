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

// Purchase orders — inbound supply, one row per (PO#, item) line.
export async function loadPurchaseOrders(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.poNumber || !r.item) continue
    await db.query(
      `INSERT INTO purchase_orders
         (po_number, item, vendor, ship_to, destination, status, expected_receipt,
          qty_ordered, qty_received, qty_remaining, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (po_number, item) DO UPDATE SET
         vendor           = COALESCE(EXCLUDED.vendor, purchase_orders.vendor),
         ship_to          = COALESCE(EXCLUDED.ship_to, purchase_orders.ship_to),
         destination      = COALESCE(EXCLUDED.destination, purchase_orders.destination),
         status           = COALESCE(EXCLUDED.status, purchase_orders.status),
         expected_receipt = COALESCE(EXCLUDED.expected_receipt, purchase_orders.expected_receipt),
         qty_ordered      = COALESCE(EXCLUDED.qty_ordered, purchase_orders.qty_ordered),
         qty_received     = COALESCE(EXCLUDED.qty_received, purchase_orders.qty_received),
         qty_remaining    = COALESCE(EXCLUDED.qty_remaining, purchase_orders.qty_remaining),
         updated_at       = now()`,
      [
        r.poNumber, r.item, r.vendor || null, r.shipTo || null, r.destination || null,
        r.status || null, r.expectedReceipt || null, r.qtyOrdered ?? null,
        r.qtyReceived ?? null, r.qtyRemaining ?? null,
      ],
    )
    n++
  }
  return n
}

// Prune PO lines no longer in the current PO Receiving export (received/closed
// POs drop off the search, so they should drop off the table the same way
// pruneOrders retires closed sales orders).
export async function prunePurchaseOrders(keepPairs, db = pool) {
  const pairs = keepPairs.filter((p) => p.poNumber && p.item)
  if (!pairs.length) return 0 // never prune against an empty set (would wipe the table)
  const { rowCount } = await db.query(
    `DELETE FROM purchase_orders po
     WHERE NOT EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::text[]) AS k(po_number, item)
       WHERE k.po_number = po.po_number AND k.item = po.item
     )`,
    [pairs.map((p) => p.poNumber), pairs.map((p) => p.item)],
  )
  return rowCount
}

// Order confirmations (pre-SO demand) — one row per (OC#, item) line.
// `dismissed`/`dismissed_note` are deliberately absent from this INSERT/UPDATE
// so re-imports never clear a manually-set "ignore until closed" flag.
export async function loadOrderConfirmations(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.ocNumber || !r.item) continue
    await db.query(
      `INSERT INTO order_confirmations
         (oc_number, item, customer, ship_to, location, status, qty, po_check_number, order_start_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (oc_number, item) DO UPDATE SET
         customer         = COALESCE(EXCLUDED.customer, order_confirmations.customer),
         ship_to          = COALESCE(EXCLUDED.ship_to, order_confirmations.ship_to),
         location         = COALESCE(EXCLUDED.location, order_confirmations.location),
         status           = COALESCE(EXCLUDED.status, order_confirmations.status),
         qty              = COALESCE(EXCLUDED.qty, order_confirmations.qty),
         po_check_number  = COALESCE(EXCLUDED.po_check_number, order_confirmations.po_check_number),
         order_start_date = COALESCE(EXCLUDED.order_start_date, order_confirmations.order_start_date),
         updated_at       = now()`,
      [
        r.ocNumber, r.item, r.customer || null, r.shipTo || null, r.location || null,
        r.status || null, r.qty ?? null, r.poCheckNumber || null, r.orderStartDate || null,
      ],
    )
    n++
  }
  return n
}

// Prune OC lines no longer in the current OC export (converted-to-SO or
// manually closed in NetSuite drops it off the search).
export async function pruneOrderConfirmations(keepPairs, db = pool) {
  const pairs = keepPairs.filter((p) => p.ocNumber && p.item)
  if (!pairs.length) return 0 // never prune against an empty set (would wipe the table)
  const { rowCount } = await db.query(
    `DELETE FROM order_confirmations oc
     WHERE NOT EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::text[]) AS k(oc_number, item)
       WHERE k.oc_number = oc.oc_number AND k.item = oc.item
     )`,
    [pairs.map((p) => p.ocNumber), pairs.map((p) => p.item)],
  )
  return rowCount
}

// ── OC↔PO allocation matcher wiring ──────────────────────────────────────────
// Read the current open (non-dismissed) OC/PO lines and existing links, in
// the shape computeOcPoMatches (src/model/ocPoMatch.js) expects.
export async function fetchOrderConfirmations(db = pool) {
  const { rows } = await db.query(
    `SELECT oc_number AS "ocNumber", item, customer, location, status, qty, dismissed, dismissed_note AS "dismissedNote"
     FROM order_confirmations`,
  )
  return rows
}

export async function fetchPurchaseOrders(db = pool) {
  const { rows } = await db.query(
    `SELECT po_number AS "poNumber", item, vendor, destination, status, expected_receipt AS "expectedReceipt",
            qty_remaining AS "qtyRemaining", dismissed, dismissed_note AS "dismissedNote"
     FROM purchase_orders`,
  )
  return rows
}

export async function fetchOcPoLinks(db = pool) {
  const { rows } = await db.query(
    `SELECT id, oc_number AS "ocNumber", po_number AS "poNumber", item, allocated_qty AS "allocatedQty",
            note, created_at AS "createdAt"
     FROM oc_po_links ORDER BY created_at DESC`,
  )
  return rows
}

// Commit one allocation (auto-matched or manually chosen) — idempotent, so
// re-running the matcher against an unchanged situation is a no-op.
export async function upsertOcPoLink({ ocNumber, poNumber, item, allocatedQty, note }, db = pool) {
  await db.query(
    `INSERT INTO oc_po_links (oc_number, po_number, item, allocated_qty, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (oc_number, po_number, item) DO UPDATE SET
       allocated_qty = EXCLUDED.allocated_qty,
       note          = COALESCE(EXCLUDED.note, oc_po_links.note)`,
    [ocNumber, poNumber, item, allocatedQty, note || null],
  )
}

// Undo a commit (mistaken match, plans changed, etc).
export async function deleteOcPoLink(id, db = pool) {
  const { rowCount } = await db.query('DELETE FROM oc_po_links WHERE id = $1', [id])
  return rowCount
}

// "Mark to close" — the reviewable ignore flag from Nima's OC↔PO request
// (2026-07-09): hide a stale/irrelevant OC or PO line from the review queue
// without deleting it, until it's actually closed in NetSuite (which prunes
// the row naturally on a later ingest). Never touched by the ingest upsert.
export async function dismissOrderConfirmation({ ocNumber, item, note, dismissed = true }, db = pool) {
  await db.query(
    `UPDATE order_confirmations SET dismissed = $3, dismissed_note = $4 WHERE oc_number = $1 AND item = $2`,
    [ocNumber, item, dismissed, note || null],
  )
}

export async function dismissPurchaseOrder({ poNumber, item, note, dismissed = true }, db = pool) {
  await db.query(
    `UPDATE purchase_orders SET dismissed = $3, dismissed_note = $4 WHERE po_number = $1 AND item = $2`,
    [poNumber, item, dismissed, note || null],
  )
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

// ── 856 ASN / BOL search — feeds the Orderful 850↔856 join (see src/model/ediPipeline.js) ──
export async function loadEdiFulfillments(rows, db = pool) {
  let n = 0
  for (const r of rows) {
    await db.query(
      `INSERT INTO edi_fulfillments (po_dc_identifier, po_number, dc, bol, scac, pro_number, dc_city, ship_date, edi_synced, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (po_dc_identifier) DO UPDATE SET
         po_number  = EXCLUDED.po_number,
         dc         = EXCLUDED.dc,
         bol        = EXCLUDED.bol,
         scac       = EXCLUDED.scac,
         pro_number = EXCLUDED.pro_number,
         dc_city    = EXCLUDED.dc_city,
         ship_date  = EXCLUDED.ship_date,
         edi_synced = EXCLUDED.edi_synced,
         updated_at = now()`,
      [r.poDcIdentifier, r.poNumber, r.dc, r.bol, r.scac, r.proNumber, r.dcCity, r.shipDate, r.ediSynced],
    )
    n++
  }
  return n
}

export async function fetchEdiFulfillments(db = pool) {
  const { rows } = await db.query(
    `SELECT po_dc_identifier AS "poDcIdentifier", po_number AS "poNumber", dc, bol,
            scac, pro_number AS "proNumber", dc_city AS "dcCity", ship_date AS "shipDate", edi_synced AS "ediSynced"
     FROM edi_fulfillments`,
  )
  return rows
}

// ── EDI manual links — human override for an 856/810 that can't auto-link to
// its 850 (see db/schema.sql). One row per transaction; re-linking overwrites.
export async function fetchEdiManualLinks(db = pool) {
  const { rows } = await db.query(
    `SELECT transaction_id AS "transactionId", business_number AS "businessNumber", note, created_at AS "createdAt"
     FROM edi_manual_links`,
  )
  return rows
}

export async function upsertEdiManualLink({ transactionId, businessNumber, note }, db = pool) {
  await db.query(
    `INSERT INTO edi_manual_links (transaction_id, business_number, note)
     VALUES ($1,$2,$3)
     ON CONFLICT (transaction_id) DO UPDATE SET business_number = EXCLUDED.business_number, note = EXCLUDED.note`,
    [transactionId, businessNumber, note || null],
  )
}

export async function deleteEdiManualLink(transactionId, db = pool) {
  const { rowCount } = await db.query('DELETE FROM edi_manual_links WHERE transaction_id = $1', [transactionId])
  return rowCount
}
