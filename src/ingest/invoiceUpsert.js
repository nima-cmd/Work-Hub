// src/ingest/invoiceUpsert.js — the pure half of the invoice upsert.
//
// Deliberately imports NOTHING from db.js. `loadToDb.js` pulls in the connection
// pool at module load (db.js throws when DATABASE_URL is unset, by design), which
// makes every function in that file unreachable from `npm test` — the suite runs
// without a database on purpose. Same shape as shipstationCosts.js, which keeps
// its loader db-free for the same reason.
//
// What lives here is the part worth testing: the fold that stops one statement
// touching a row twice, and the SQL that refuses to assert a sales-order link it
// can't back up.

export const INVOICE_COLUMNS = 12

// records → one parameter tuple per invoice, deduped.
//
// Keyed by invoice number so ONE statement can't touch the same row twice —
// Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
// time", and a DISTINCT SuiteQL pull still yields two rows for one invoice
// whenever any selected column disagrees (the link table is LINE-level). Last
// occurrence wins, matching the one-query-per-row loop this replaced.
export function foldInvoiceRows(records = []) {
  const byInvoice = new Map()
  for (const r of records) {
    const inv = r.invoice
    if (!inv || !/^INV/i.test(inv)) continue
    byInvoice.set(inv.toUpperCase(), [
      inv,
      r.soNumber && r.soNumber !== 'UNLINKED' ? r.soNumber : null,
      r.invoiceStatus || r.soStatus || null,
      r.shippingStatus || null,
      r.amountRemaining ?? null,
      r.amountTotal ?? null,
      r.shipDate || null,
      // Nordstrom's consolidated ref. Many of our invoices legitimately share
      // one, so this is never used as a key for a single invoice.
      r.nordstromRef ? String(r.nordstromRef).trim().toUpperCase() : null,
      r.tranDate || null,
      // Terms text verbatim (matched loosely by paymentGate.js, never by id) and
      // the due date — the objective inputs to "is payment blocking this?".
      r.terms || null,
      r.dueDate || null,
      r.billTo || null,
    ])
  }
  return [...byInvoice.values()]
}

// The batched upsert for `rowCount` invoices.
//
// ⚠️ THE SO IS RESOLVED THROUGH `orders`, NOT TRUSTED FROM THE RECORD
// (2026-08-03). `invoices.so_number` has an enforced FK and `orders` is a 30-day
// working WINDOW, not the universe — so once the invoice pull got its own much
// wider document window it routinely carries a real SO number with no row here
// (all 309 invoices missing from the INV10996–INV11416 span were in exactly that
// position). Passing it verbatim raises 23503 and aborts the whole load.
//
// The subquery yields NULL for an out-of-window order, which is the honest
// answer: we hold the invoice, we do not hold its order. Storing the number
// anyway would recreate the #32 bug — a key that resolves to nothing, and is
// indistinguishable from a real link once written.
//
// Nothing is lost when the order later enters the window: the COALESCE fills
// `so_number` in on the next sync, and `ON DELETE SET NULL` already nulls it when
// an order is pruned, so a null SO is a state this table was built for (5 rows
// carried one before this change).
export function invoiceUpsertSql(rowCount) {
  const values = Array.from({ length: rowCount }, (_, j) => {
    const b = j * INVOICE_COLUMNS
    // The casts are load-bearing in a multi-row VALUES: without them a chunk
    // whose column is entirely NULL gives Postgres nothing to infer a type from.
    return `($${b + 1}::text, (SELECT o.so_number FROM orders o WHERE o.so_number = $${b + 2}::text),
             $${b + 3}::text, $${b + 4}::text, $${b + 5}::numeric, $${b + 6}::numeric, $${b + 7}::date,
             $${b + 8}::text, $${b + 9}::date, $${b + 10}::text, $${b + 11}::date,
             $${b + 12}::text, now())`
  }).join(',')

  return `INSERT INTO invoices
       (inv_number, so_number, status, shipping_status, amount_remaining, amount_total, ship_date,
        nordstrom_ref, trandate, terms, due_date, bill_to, updated_at)
     VALUES ${values}
     ON CONFLICT (inv_number) DO UPDATE SET
       so_number        = COALESCE(EXCLUDED.so_number, invoices.so_number),
       status           = COALESCE(EXCLUDED.status, invoices.status),
       shipping_status  = COALESCE(EXCLUDED.shipping_status, invoices.shipping_status),
       -- amount_remaining legitimately goes to 0 when an invoice is paid, so it
       -- must NOT be COALESCE-protected (that would freeze it at the first
       -- non-null we ever saw). Only skip when the source didn't supply it.
       amount_remaining = CASE WHEN EXCLUDED.amount_remaining IS NULL THEN invoices.amount_remaining
                               ELSE EXCLUDED.amount_remaining END,
       amount_total     = COALESCE(EXCLUDED.amount_total, invoices.amount_total),
       ship_date        = COALESCE(EXCLUDED.ship_date, invoices.ship_date),
       nordstrom_ref    = COALESCE(EXCLUDED.nordstrom_ref, invoices.nordstrom_ref),
       trandate         = COALESCE(EXCLUDED.trandate, invoices.trandate),
       terms            = COALESCE(EXCLUDED.terms, invoices.terms),
       due_date         = COALESCE(EXCLUDED.due_date, invoices.due_date),
       bill_to          = COALESCE(EXCLUDED.bill_to, invoices.bill_to),
       updated_at       = now()`
}

// Records how far back the invoice document window has EVER reached — the floor
// behind the trail's "this 810 predates our invoice records" verdict.
//
// LEAST, never overwrite: the window start rolls FORWARD daily (180 days before
// now), but documents pulled under an earlier window stay in the table — so
// coverage only ever extends backwards (a one-off 365-day pull moves it back for
// good). Taking the latest run's value instead would claim documents we hold
// were never pulled. YYYY-MM-DD compares correctly as text.
//
// ⚠️ min(invoices.trandate) is NOT this floor and must never substitute for it:
// the table also carries invoices riding in on still-open sales orders, which
// reach arbitrarily far back (measured live: a 2024-11-19 stray against a
// 2026-02 window). Only the sync knows what span it systematically covered.
export const INVOICE_WINDOW_KEY = 'invoice_documents_from'

export function invoiceWindowUpsertSql() {
  return `INSERT INTO sync_meta (key, value, updated_at)
     VALUES ('${INVOICE_WINDOW_KEY}', $1, now())
     ON CONFLICT (key) DO UPDATE SET
       value      = LEAST(sync_meta.value, EXCLUDED.value),
       updated_at = now()`
}
