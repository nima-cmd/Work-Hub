// src/ingest/loadToDb.js
// Upserts parsed pipeline data into Postgres. Keyed on NetSuite natural keys
// (SO#, IF#, INV#) so re-importing the same saved search UPDATES rows instead
// of duplicating them — that's what lets us snapshot over time and detect stalls.

import { pool } from '../db.js'
import { resolveCharacterForSender } from '../model/characters.js'

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

// Stamp the FIRST time an IF is observed cleared for shipping ("Approved to
// Ship") into the ledger — this is the "launch day" the Launch Bay measures
// its delay warning from. The recurring pain (Nima, 2026-07-17): we physically
// ship but forget to mark the Item Fulfillment shipped that day, so the record
// is lost. An approved ship still sitting here a day after its launch day is
// exactly that miss. Idempotent: one REACHED_APPROVED per IF, ever — so the
// launch day is pinned to first observation and never drifts on re-imports.
export async function stampApprovedForShipping(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.ifNumber) continue
    if (!/approved to ship/i.test(r.packedStatus || '')) continue
    const so = r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null
    const { rowCount } = await db.query(
      `INSERT INTO order_events (event_type, doc_type, doc_number, so_number, source)
       SELECT 'REACHED_APPROVED', 'IF', $1, $2, 'derived'
       WHERE NOT EXISTS (
         SELECT 1 FROM order_events
         WHERE event_type = 'REACHED_APPROVED' AND doc_type = 'IF' AND doc_number = $1
       )`,
      [r.ifNumber, so],
    )
    n += rowCount
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
// EDI PO resolutions (Nima, 2026-07-18) — the human open/closed override per
// EDI PO. Upsert semantics: saving again just updates the same row.
export async function fetchEdiPoResolutions(db = pool) {
  const { rows } = await db.query(
    `SELECT business_number AS "businessNumber", closed, cancelled, netsuite_ref AS "netsuiteRef", note,
            updated_at AS "updatedAt"
     FROM edi_po_resolutions`,
  )
  return rows
}

export async function upsertEdiPoResolution({ businessNumber, closed = false, cancelled = false, netsuiteRef, note }, db = pool) {
  await db.query(
    `INSERT INTO edi_po_resolutions (business_number, closed, cancelled, netsuite_ref, note, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (business_number) DO UPDATE SET
       closed = EXCLUDED.closed, cancelled = EXCLUDED.cancelled, netsuite_ref = EXCLUDED.netsuite_ref,
       note = EXCLUDED.note, updated_at = now()`,
    [businessNumber, !!closed, !!cancelled, netsuiteRef || null, note || null],
  )
}

export async function deleteEdiPoResolution(businessNumber, db = pool) {
  await db.query('DELETE FROM edi_po_resolutions WHERE business_number = $1', [businessNumber])
}

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

// ── EDI transaction acknowledgments — per-document, distinct from the
// per-PO edi_po_resolutions above (see db/schema.sql).
export async function fetchEdiTransactionAcks(db = pool) {
  const { rows } = await db.query(
    `SELECT transaction_id AS "transactionId", linked_transaction_id AS "linkedTransactionId", note, created_at AS "createdAt"
     FROM edi_transaction_acks`,
  )
  return rows
}

export async function upsertEdiTransactionAck({ transactionId, linkedTransactionId, note }, db = pool) {
  await db.query(
    `INSERT INTO edi_transaction_acks (transaction_id, linked_transaction_id, note)
     VALUES ($1,$2,$3)
     ON CONFLICT (transaction_id) DO UPDATE SET linked_transaction_id = EXCLUDED.linked_transaction_id, note = EXCLUDED.note`,
    [transactionId, linkedTransactionId || null, note || null],
  )
}

export async function deleteEdiTransactionAck(transactionId, db = pool) {
  await db.query('DELETE FROM edi_transaction_acks WHERE transaction_id = $1', [transactionId])
}

// ── Doc seasons — free-text season tag on any OC/PO (see db/schema.sql).
// Saving an empty season clears the tag (deletes the row) rather than storing
// blanks, same convention as quest_emails.note.
export async function fetchSeasons(db = pool) {
  const { rows } = await db.query(
    `SELECT doc_type AS "docType", doc_number AS "docNumber", season, updated_at AS "updatedAt" FROM doc_seasons`,
  )
  return rows
}

export async function upsertSeason({ docType, docNumber, season }, db = pool) {
  if (!season?.trim()) {
    await db.query('DELETE FROM doc_seasons WHERE doc_type = $1 AND doc_number = $2', [docType, docNumber])
    return
  }
  await db.query(
    `INSERT INTO doc_seasons (doc_type, doc_number, season, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (doc_type, doc_number) DO UPDATE SET season = EXCLUDED.season, updated_at = now()`,
    [docType, docNumber, season.trim()],
  )
}

// ── EDI manual orders — hand-entered gap-fillers (kept apart from the pipeline)
export async function createEdiManualOrder({ businessNumber, tradingPartner, note }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO edi_manual_orders (business_number, trading_partner, note)
     VALUES ($1,$2,$3) RETURNING id`,
    [businessNumber, tradingPartner || null, note || null],
  )
  return rows[0].id
}

export async function fetchEdiManualOrders(db = pool) {
  const { rows } = await db.query(
    `SELECT id, business_number AS "businessNumber", trading_partner AS "tradingPartner",
            note, created_at AS "createdAt"
     FROM edi_manual_orders ORDER BY created_at DESC`,
  )
  return rows
}

export async function deleteEdiManualOrder(id, db = pool) {
  const { rowCount } = await db.query('DELETE FROM edi_manual_orders WHERE id = $1', [id])
  return rowCount
}

// ── Quest emails (Gmail-to-quest hologram transmissions) ────────────────────
export async function fetchEmailCharacterPrefs(db = pool) {
  const { rows } = await db.query(
    `SELECT from_address AS "fromAddress", character_id AS "characterId" FROM email_character_prefs`,
  )
  return Object.fromEntries(rows.map((r) => [r.fromAddress, r.characterId]))
}

// character_id is deliberately absent from the ON CONFLICT UPDATE below (same
// reasoning as dismissed elsewhere): it's only ever set on first INSERT, via
// resolveCharacterForSender — a re-sync must never re-randomize an email that
// already has a messenger assigned.
export async function loadQuestEmails(messages, db = pool) {
  const prefs = await fetchEmailCharacterPrefs(db)
  let n = 0
  for (const m of messages) {
    if (!m.id) continue
    const characterId = resolveCharacterForSender(m.fromAddress, prefs)
    await db.query(
      `INSERT INTO quest_emails
         (id, thread_id, from_address, from_name, subject, snippet, body, received_at, is_unread, label_ids, character_id, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET
         thread_id    = EXCLUDED.thread_id,
         from_address = EXCLUDED.from_address,
         from_name    = EXCLUDED.from_name,
         subject      = EXCLUDED.subject,
         snippet      = EXCLUDED.snippet,
         body         = EXCLUDED.body,
         received_at  = EXCLUDED.received_at,
         is_unread    = EXCLUDED.is_unread,
         label_ids    = EXCLUDED.label_ids,
         synced_at    = now()`,
      [
        m.id, m.threadId || null, m.fromAddress || null, m.fromName || null, m.subject || null,
        m.snippet || null, m.body || null, m.receivedAt || null, m.isUnread ?? true, m.labelIds || [], characterId,
      ],
    )
    n++
  }
  return n
}

// fetchInboxMessages only ever returns currently-unread mail, so anything we
// previously stored as unread but that ISN'T in this sync's fetch must have
// been read since (either through this app's own markMessageRead, or
// directly in Gmail) — flip it locally so it drops out of the transmissions
// list without a per-message API call.
export async function reconcileReadStatus(currentUnreadIds, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE quest_emails SET is_unread = false WHERE is_unread = true AND NOT (id = ANY($1::text[]))`,
    [currentUnreadIds],
  )
  return rowCount
}

export async function fetchQuestEmails(db = pool) {
  const { rows } = await db.query(
    `SELECT id, thread_id AS "threadId", from_address AS "fromAddress", from_name AS "fromName",
            subject, snippet, body, note, received_at AS "receivedAt", is_unread AS "isUnread",
            label_ids AS "labelIds", character_id AS "characterId"
     FROM quest_emails
     WHERE dismissed = false
       AND (is_unread = true OR received_at > now() - interval '3 days')
     ORDER BY received_at DESC`,
  )
  return rows
}

// Looked up regardless of unread/dismissed state — creating a task from a
// transmission has to work even the instant after it's already been read.
export async function fetchQuestEmailById(id, db = pool) {
  const { rows } = await db.query(
    `SELECT id, thread_id AS "threadId", from_address AS "fromAddress", from_name AS "fromName",
            subject, snippet, body, note, received_at AS "receivedAt", is_unread AS "isUnread",
            label_ids AS "labelIds", character_id AS "characterId"
     FROM quest_emails WHERE id = $1`,
    [id],
  )
  return rows[0] || null
}

// Every quest_emails row regardless of dismissed/unread state, for search.
export async function searchQuestEmails(q, db = pool) {
  const { rows } = await db.query(
    `SELECT id, from_address AS "fromAddress", from_name AS "fromName", subject, snippet, note,
            received_at AS "receivedAt", is_unread AS "isUnread", dismissed, character_id AS "characterId"
     FROM quest_emails
     WHERE subject ILIKE $1 OR snippet ILIKE $1 OR body ILIKE $1 OR note ILIKE $1 OR from_name ILIKE $1 OR from_address ILIKE $1
     ORDER BY received_at DESC LIMIT 100`,
    [`%${q}%`],
  )
  return rows
}

// The note ledger (Nima, 2026-07-18): a personal summary/highlight per email,
// kept for later reference. App-owned — the sync upsert never writes note, so
// re-syncs can't clobber it. Empty string clears it back to NULL.
export async function setQuestEmailNote(id, note, db = pool) {
  await db.query('UPDATE quest_emails SET note = NULLIF($2, \'\') WHERE id = $1', [id, String(note ?? '').trim()])
}

// Reassigning a character remembers it for the sender (see resolveCharacterForSender)
// so future emails from the same address inherit the same messenger.
export async function assignQuestEmailCharacter({ id, characterId, fromAddress }, db = pool) {
  await db.query('UPDATE quest_emails SET character_id = $2 WHERE id = $1', [id, characterId])
  if (fromAddress) {
    await db.query(
      `INSERT INTO email_character_prefs (from_address, character_id, updated_at)
       VALUES ($1,$2, now())
       ON CONFLICT (from_address) DO UPDATE SET character_id = EXCLUDED.character_id, updated_at = now()`,
      [fromAddress, characterId],
    )
  }
}

// Called after a successful Gmail-side markMessageRead so local state mirrors it.
export async function markQuestEmailReadLocal(id, db = pool) {
  await db.query('UPDATE quest_emails SET is_unread = false WHERE id = $1', [id])
}

// App-only hide — never touches Gmail. Mirrors dismissOrderConfirmation/dismissPurchaseOrder.
export async function dismissQuestEmail(id, dismissed = true, db = pool) {
  await db.query('UPDATE quest_emails SET dismissed = $2 WHERE id = $1', [id, dismissed])
}

// ── Quest tasks (a transmission promoted to something durable) ──────────────
export async function createQuestTask({ emailId, threadId, characterId, fromAddress, fromName, subject, snippet }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO quest_tasks (email_id, thread_id, character_id, from_address, from_name, subject, snippet)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [emailId, threadId || null, characterId, fromAddress || null, fromName || null, subject || null, snippet || null],
  )
  return rows[0].id
}

// A task Nima writes himself (Nima, 2026-07-17) — no source email, so email_id
// stays NULL. Otherwise identical to an email-derived task, so it flows through
// the same Dashboard/Kanban/Tasks surfaces. from_name is a human label for who
// it's "from" (defaults to a self tag) so the card has something to show.
export async function createManualTask({ subject, snippet, characterId, urgency, needsType, needsNote, fromName }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO quest_tasks (email_id, character_id, from_name, subject, snippet, urgency, needs_type, needs_note)
     VALUES (NULL,$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [characterId || null, fromName || 'Manual entry', subject || null, snippet || null,
     urgency || null, needsType || 'none', needsNote || null],
  )
  return rows[0].id
}

// Open instances of one recurring template, oldest first — used to keep a
// 'daily' task single (one open at a time) and escalate it instead of spawning
// duplicates (Nima, 2026-07-17).
export async function fetchOpenRecurringInstances(recurringKey, db = pool) {
  const { rows } = await db.query(
    `SELECT id, created_at AS "createdAt", urgency, character_id AS "characterId"
     FROM quest_tasks WHERE recurring_key = $1 AND status = 'open' ORDER BY created_at ASC`,
    [recurringKey],
  )
  return rows
}

// characterId is optional (Nima, 2026-07-20): a repeat-asked task can hand off
// to a different messenger, not just get louder in the same voice.
export async function escalateRecurringTask(id, { urgency, snippet, characterId }, db = pool) {
  await db.query(
    `UPDATE quest_tasks SET urgency = COALESCE($2, urgency), snippet = COALESCE($3, snippet),
                            character_id = COALESCE($4, character_id) WHERE id = $1`,
    [id, urgency || null, snippet || null, characterId || null],
  )
}

// Hard-remove a task + its activity (used to collapse duplicate recurring
// spawns — they're redundant, not completed work, so they must NOT count as
// done/affection). Deliberately deletes activity too so no orphan rows linger.
export async function deleteQuestTask(id, db = pool) {
  await db.query('DELETE FROM quest_task_activity WHERE task_id = $1', [id])
  const { rowCount } = await db.query('DELETE FROM quest_tasks WHERE id = $1', [id])
  return rowCount
}

const TASK_FIELDS = `id, email_id AS "emailId", thread_id AS "threadId", character_id AS "characterId",
  from_address AS "fromAddress", from_name AS "fromName", subject, snippet, status,
  needs_type AS "needsType", needs_note AS "needsNote",
  netsuite_doc_type AS "netsuiteDocType", netsuite_doc_number AS "netsuiteDocNumber",
  urgency, recurring_key AS "recurringKey", completion_mode AS "completionMode",
  verify_key AS "verifyKey", checklist, created_at AS "createdAt", completed_at AS "completedAt"`

export async function fetchQuestTasks(db = pool) {
  const { rows } = await db.query(
    `SELECT ${TASK_FIELDS} FROM quest_tasks ORDER BY (status = 'open') DESC, created_at DESC`,
  )
  return rows
}

export async function fetchQuestTaskById(id, db = pool) {
  const { rows } = await db.query(`SELECT ${TASK_FIELDS} FROM quest_tasks WHERE id = $1`, [id])
  return rows[0] || null
}

// Open reply-needed tasks with a thread to check — see checkRepliedTasks in
// server/queries.js, which scans each thread for an outbound reply.
export async function fetchOpenReplyTasks(db = pool) {
  const { rows } = await db.query(
    `SELECT ${TASK_FIELDS} FROM quest_tasks WHERE status = 'open' AND needs_type = 'reply' AND thread_id IS NOT NULL`,
  )
  return rows
}

// ── Recurring tasks ──────────────────────────────────────────────────────────
export async function fetchActiveRecurringTemplates(db = pool) {
  const { rows } = await db.query(
    `SELECT key, title, description, character_id AS "characterId", schedule_type AS "scheduleType",
            schedule_times AS "scheduleTimes", completion_mode AS "completionMode",
            verify_key AS "verifyKey", checklist_items AS "checklistItems", urgency
     FROM recurring_task_templates WHERE active = true`,
  )
  return rows
}

// ON CONFLICT DO NOTHING on instance_key is the whole dedupe mechanism — safe
// to call this for an instance that already exists; returns null (not created).
export async function createRecurringTaskInstance(
  { recurringKey, instanceKey, characterId, subject, snippet, completionMode, verifyKey, urgency, checklist },
  db = pool,
) {
  const { rows } = await db.query(
    `INSERT INTO quest_tasks
       (recurring_key, instance_key, character_id, subject, snippet, completion_mode, verify_key, urgency, checklist, needs_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'none')
     ON CONFLICT (instance_key) DO NOTHING
     RETURNING id`,
    [recurringKey, instanceKey, characterId, subject, snippet || null, completionMode, verifyKey || null, urgency || null, checklist ? JSON.stringify(checklist) : null],
  )
  return rows[0]?.id || null
}

export async function updateTaskChecklistItem(id, itemKey, done, db = pool) {
  const { rows } = await db.query('SELECT checklist FROM quest_tasks WHERE id = $1', [id])
  const checklist = (rows[0]?.checklist || []).map((c) => (c.key === itemKey ? { ...c, done } : c))
  await db.query('UPDATE quest_tasks SET checklist = $2 WHERE id = $1', [id, JSON.stringify(checklist)])
  return checklist
}

export async function completeQuestTask(id, done = true, db = pool) {
  await db.query(
    `UPDATE quest_tasks SET status = $2, completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END WHERE id = $1`,
    [id, done ? 'done' : 'open'],
  )
}

// Reassigning a task's messenger doesn't touch email_character_prefs — that
// table is keyed off sender address for future TRANSMISSIONS, and a task's
// character is a one-off override on an already-claimed item.
export async function updateTaskCharacter(id, characterId, db = pool) {
  await db.query('UPDATE quest_tasks SET character_id = $2 WHERE id = $1', [id, characterId])
}

// needsType: 'none' | 'reply' | 'acknowledgment' | 'file' | 'netsuite_doc'
// netsuite_doc_type/number only meaningful when needsType is 'netsuite_doc'
// (normalization — e.g. prepending 'SO' — happens in queries.js, not here).
export async function updateTaskNeeds({ id, needsType, needsNote, netsuiteDocType, netsuiteDocNumber }, db = pool) {
  await db.query(
    `UPDATE quest_tasks SET needs_type = $2, needs_note = $3, netsuite_doc_type = $4, netsuite_doc_number = $5 WHERE id = $1`,
    [id, needsType, needsNote || null, netsuiteDocType || null, netsuiteDocNumber || null],
  )
}

// urgency: 'hi' | 'mid' | 'lo' | null
export async function updateTaskUrgency(id, urgency, db = pool) {
  await db.query('UPDATE quest_tasks SET urgency = $2 WHERE id = $1', [id, urgency || null])
}

// Every quest_tasks row regardless of status, for search.
export async function searchQuestTasks(q, db = pool) {
  const { rows } = await db.query(
    `SELECT ${TASK_FIELDS} FROM quest_tasks
     WHERE subject ILIKE $1 OR snippet ILIKE $1 OR from_name ILIKE $1 OR from_address ILIKE $1
     ORDER BY created_at DESC LIMIT 100`,
    [`%${q}%`],
  )
  return rows
}

// ── Order events ledger (Nima, 2026-07-17) — custody scans first ─────────────
// Append-only: re-handoffs happen (an IF can go back out after a fix), so
// custody STATE is derived from the latest OUT vs latest IN, never stored.
export async function insertOrderEvent({ eventType, docType, docNumber, soNumber, note, source = 'scan', occurredAt }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO order_events (event_type, doc_type, doc_number, so_number, note, source, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()))
     RETURNING id, occurred_at AS "occurredAt"`,
    [eventType, docType, docNumber, soNumber || null, note || null, source, occurredAt || null],
  )
  return rows[0]
}

// Snapshot a shipment's dollar value the first time we observe its IF shipped
// (Nima, 2026-07-17) — feeds the "shipped this month" header credits. Snapshotting
// at ship time means later payment (amount_remaining → 0) can't erase the value.
// occurred_at is pinned to the ACTUAL ship date so month-bucketing is correct,
// not to import time. Value = the IF's invoice amount_remaining at this moment
// (Naghedi ships FOB/pre-payment, so that's ~the full value), else the order's.
// Idempotent: one SHIPPED_VALUE per IF, ever.
export async function stampShippedValue(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.ifNumber || !r.actualShipDate) continue
    const exists = await db.query(
      `SELECT 1 FROM order_events WHERE event_type='SHIPPED_VALUE' AND doc_type='IF' AND doc_number=$1`,
      [r.ifNumber],
    )
    if (exists.rowCount) continue
    const so = r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null
    const { rows: amt } = await db.query(
      `SELECT COALESCE(
         (SELECT amount_remaining FROM invoices WHERE inv_number = $1),
         (SELECT amount_remaining FROM orders   WHERE so_number  = $2),
         0) AS value`,
      [r.invoice || null, so],
    )
    await db.query(
      `INSERT INTO order_events (event_type, doc_type, doc_number, so_number, note, source, occurred_at)
       VALUES ('SHIPPED_VALUE','IF',$1,$2,$3,'derived',$4)`,
      [r.ifNumber, so, String(amt[0].value ?? 0), r.actualShipDate],
    )
    n++
  }
  return n
}

// ── Fulfillment boxes (Nima, 2026-07-17) — the IN-scan box capture ──────────
// A carton's weight + L×W×H, captured (optionally) when an IF is scanned back
// IN. One row per carton. Nulls are fine — a scanner in a hurry can capture
// weight only, or dimensions only, or skip the whole thing.
export async function insertFulfillmentBox(
  { ifNumber, weightLb, lengthIn, widthIn, heightIn, note }, db = pool,
) {
  const { rows } = await db.query(
    `INSERT INTO fulfillment_boxes (if_number, weight_lb, length_in, width_in, height_in, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, if_number AS "ifNumber", weight_lb AS "weightLb",
               length_in AS "lengthIn", width_in AS "widthIn", height_in AS "heightIn",
               note, captured_at AS "capturedAt"`,
    [ifNumber, weightLb ?? null, lengthIn ?? null, widthIn ?? null, heightIn ?? null, note || null],
  )
  return rows[0]
}

// All boxes for one IF (newest first), or every un-departed box when ifNumber
// is omitted — the custody register batches this to avoid an N+1.
export async function fetchFulfillmentBoxes(ifNumber = null, db = pool) {
  const { rows } = await db.query(
    `SELECT id, if_number AS "ifNumber", weight_lb AS "weightLb",
            length_in AS "lengthIn", width_in AS "widthIn", height_in AS "heightIn",
            note, captured_at AS "capturedAt"
     FROM fulfillment_boxes
     ${ifNumber ? 'WHERE if_number = $1' : ''}
     ORDER BY captured_at DESC`,
    ifNumber ? [ifNumber] : [],
  )
  return rows
}

// Departure cleanup (Nima, 2026-07-17) — when an IF actually ships, the custody
// chapter closes: the working box rows are pruned so the register only ever
// shows things still in the bay, and ONE CUSTODY_CLEARED ledger event preserves
// the summary (how many boxes, total weight) permanently. Runs at ingest time
// alongside stampShippedValue; idempotent via the CUSTODY_CLEARED marker, and
// only touches IFs that were actually in custody (had a scan) so it stays quiet
// for the overwhelming majority of IFs that never went through the bay.
export async function clearDepartedCustody(records, db = pool) {
  let n = 0
  for (const r of records) {
    if (!r.ifNumber || !r.actualShipDate) continue
    const already = await db.query(
      `SELECT 1 FROM order_events WHERE event_type='CUSTODY_CLEARED' AND doc_type='IF' AND doc_number=$1`,
      [r.ifNumber],
    )
    if (already.rowCount) continue
    const scanned = await db.query(
      `SELECT 1 FROM order_events
       WHERE doc_type='IF' AND doc_number=$1 AND event_type IN ('CUSTODY_OUT','CUSTODY_IN') LIMIT 1`,
      [r.ifNumber],
    )
    if (!scanned.rowCount) continue
    const { rows: box } = await db.query(
      `SELECT COUNT(*)::int AS boxes, COALESCE(SUM(weight_lb),0) AS weight
       FROM fulfillment_boxes WHERE if_number=$1`,
      [r.ifNumber],
    )
    const summary = box[0].boxes
      ? `departed — ${box[0].boxes} box${box[0].boxes === 1 ? '' : 'es'}, ${Number(box[0].weight)} lb`
      : 'departed — no box captured'
    const so = r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null
    await db.query(
      `INSERT INTO order_events (event_type, doc_type, doc_number, so_number, note, source, occurred_at)
       VALUES ('CUSTODY_CLEARED','IF',$1,$2,$3,'derived',$4)`,
      [r.ifNumber, so, summary, r.actualShipDate],
    )
    await db.query(`DELETE FROM fulfillment_boxes WHERE if_number=$1`, [r.ifNumber])
    n++
  }
  return n
}

// Ledger feed — the Calendar's "what occurred every day" and the searchable
// history. date scopes to one day (same convention as fetchTaskActivity).
export async function fetchOrderEvents({ date, docNumber, soNumber } = {}, db = pool) {
  const conds = []
  const params = []
  if (date) { params.push(date); conds.push(`e.occurred_at::date = $${params.length}::date`) }
  if (docNumber) { params.push(docNumber); conds.push(`e.doc_number = $${params.length}`) }
  if (soNumber) { params.push(soNumber); conds.push(`e.so_number = $${params.length}`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const { rows } = await db.query(
    `SELECT e.id, e.event_type AS "eventType", e.doc_type AS "docType", e.doc_number AS "docNumber",
            e.so_number AS "soNumber", e.note, e.source, e.occurred_at AS "occurredAt",
            o.customer
     FROM order_events e LEFT JOIN orders o ON o.so_number = e.so_number
     ${where}
     ORDER BY e.occurred_at DESC
     LIMIT 500`,
    params,
  )
  return rows
}

// ── Journal — "track what was done within the day" (Nima, 2026-07-15) ───────
export async function logTaskActivity({ taskId, kind, note }, db = pool) {
  await db.query('INSERT INTO quest_task_activity (task_id, kind, note) VALUES ($1,$2,$3)', [taskId, kind, note || null])
}

// date: 'YYYY-MM-DD' to scope to one day (the Journal section / Calendar
// view); omitted for a general recent feed.
export async function fetchTaskActivity({ date } = {}, db = pool) {
  const where = date ? 'WHERE a.created_at::date = $1::date' : ''
  const { rows } = await db.query(
    `SELECT a.id, a.task_id AS "taskId", a.kind, a.note, a.created_at AS "createdAt",
            t.subject, t.character_id AS "characterId"
     FROM quest_task_activity a JOIN quest_tasks t ON t.id = a.task_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT 200`,
    date ? [date] : [],
  )
  return rows
}
