-- Warehouse Order Pipeline Tracker — Postgres schema (Neon)
--
-- Canonical data model. Populated from CSV exports of NetSuite saved searches
-- (and Orderful EDI later). The BitaQuest game reads THIS model to generate quests.
-- Design principle: NetSuite natural keys (SO#, IF#, INV#, PO#) are the primary
-- keys so re-imports UPSERT cleanly and nothing is double-tracked.

-- ── Orders: one row per Sales Order / Order Confirmation. The spine. ──────────
CREATE TABLE IF NOT EXISTS orders (
  so_number        TEXT PRIMARY KEY,           -- 'SO12043'
  customer         TEXT,
  location         TEXT,                        -- NetSuite Location, e.g. 'Warehouse Bulk : Nordstrom'
  po_number        TEXT,                        -- customer PO/check number on the order
  is_ats           BOOLEAN,                     -- true = ships from stock; false = presold from a PO
  source           TEXT,                        -- 'edi' | 'dtc' | 'manual'
  stage            TEXT,                        -- derived pipeline stage (see src/model/stages.js)
  so_status        TEXT,                        -- raw NetSuite status letter (B/D/F/G…)
  qty_ordered      NUMERIC,
  qty_allocated    NUMERIC,
  qty_fulfilled    NUMERIC,
  amount_paid      NUMERIC,
  shipping_status  TEXT,
  start_date       DATE,
  ship_date        DATE,
  cancel_date      DATE,
  notes            TEXT,
  approval_status  TEXT,                        -- 'Approved' | 'On Hold' — gates whether an IF may be created
  billing_status   TEXT,                        -- e.g. 'Fully Billed'
  first_seen       TIMESTAMPTZ DEFAULT now(),   -- first import we saw this order
  last_seen        TIMESTAMPTZ DEFAULT now(),   -- most recent import
  last_movement    TIMESTAMPTZ DEFAULT now(),   -- last time stage changed → stall detection
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS is a no-op once the table already exists in Neon,
-- so new columns need an explicit, idempotent ALTER to actually apply on re-run.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location TEXT; -- NetSuite Location, e.g. 'Warehouse Bulk : Nordstrom'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS approval_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_status TEXT;

-- ── Item Fulfillments linked to an order ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS fulfillments (
  if_number        TEXT PRIMARY KEY,
  so_number        TEXT REFERENCES orders(so_number) ON DELETE CASCADE,
  status           TEXT,                        -- Picked / Packed / Shipped
  packed_status    TEXT,                        -- IF-Packed-Status (Approved to Ship, FOB…, Pending Invoice, Waiting On Payment)
  days_pending     INTEGER,
  invoice_number   TEXT,
  if_date          DATE,
  actual_ship_date DATE,                        -- the day this IF actually shipped (distinct from orders.ship_date, a target)
  updated_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE fulfillments ADD COLUMN IF NOT EXISTS actual_ship_date DATE;

-- ── Invoices linked to an order ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  inv_number       TEXT PRIMARY KEY,
  so_number        TEXT REFERENCES orders(so_number) ON DELETE SET NULL,
  status           TEXT,                        -- Open / Paid In Full
  shipping_status  TEXT,                        -- Pending Payment / FOB Pending Approval / Approved For Shipping
  amount_remaining NUMERIC,
  ship_date        DATE,
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Purchase Orders (inbound supply) — from the PO-receiving saved search ─────
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_number        TEXT,
  item             TEXT,
  vendor           TEXT,
  ship_to          TEXT,                        -- who the container was produced for; '000 NAGHEDI' = in-house (ecomm/boutique)
  destination      TEXT,                        -- Final Naghedi Destination — THE OC<->PO match key (joins to orders.location)
  status           TEXT,                        -- Pending Receipt / Partially Received / …
  expected_receipt DATE,                        -- ETA that drives "covered by ~date"
  qty_ordered      NUMERIC,
  qty_received     NUMERIC,
  qty_remaining    NUMERIC,
  linked_oc        TEXT,                         -- OC# read from the manual custom field, if present
  updated_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (po_number, item)
);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ship_to TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS destination TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS qty_remaining NUMERIC;

-- dismissed = app-only "needs to be closed in NetSuite, ignore until then" flag.
-- Never written by the ingest upsert (see loadPurchaseOrders) so re-imports never
-- clear it — only the row disappearing from the export (pruned) clears it, which
-- happens naturally once it's actually closed/received in NetSuite.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS dismissed BOOLEAN DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS dismissed_note TEXT;

-- ── Order Confirmations (pre-SO demand) — from the OC/Estimate saved search ──
-- NetSuite record type: Estimate, filtered to ones with NO Sales Order created
-- from them yet (so this never double-counts against `orders`). Line-level,
-- one row per (OC#, item). Status is 'Open' (still live) or 'Expired' (passed
-- its date without converting — NetSuite doesn't auto-close these, so stale
-- ones accumulate; the `dismissed` flag is how the app hides them without
-- waiting on a NetSuite cleanup).
CREATE TABLE IF NOT EXISTS order_confirmations (
  oc_number         TEXT NOT NULL,
  item              TEXT NOT NULL,
  customer          TEXT,
  ship_to           TEXT,                       -- channel proxy, same idea as purchase_orders.ship_to
  location          TEXT,                       -- joins to purchase_orders.destination for matching
  status            TEXT,                       -- Open / Expired
  qty               NUMERIC,
  po_check_number   TEXT,                       -- free-text production-run/collection label —
                                                 -- NOT the numeric PO# (confirmed on real data: values
                                                 -- like 'Bloom Fall Shoe 2025', 'NordFebStore26'), so it
                                                 -- is NOT the OC<->PO join key. Item + location/destination is.
  order_start_date  DATE,
  dismissed         BOOLEAN DEFAULT false,      -- same semantics as purchase_orders.dismissed
  dismissed_note    TEXT,
  updated_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (oc_number, item)
);

-- ── OC ↔ PO allocation links — THE APP OWNS THIS ─────────────────────────────
-- Single source of truth, replacing the manual dual cross-reference in NetSuite.
-- Link once here; the app maintains both directions and can push back to NetSuite later.
-- Line-level (item), so one OC/PO pair can allocate across several shared items,
-- and allocated_qty tracks how much of the OC's demand this PO line is committed
-- to cover — the basis for the "maximize each PO across its OCs" allocation view.
CREATE TABLE IF NOT EXISTS oc_po_links (
  id               SERIAL PRIMARY KEY,
  oc_number        TEXT NOT NULL,               -- Order Confirmation
  po_number        TEXT NOT NULL,
  item             TEXT,
  allocated_qty    NUMERIC,
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (oc_number, po_number)
);

ALTER TABLE oc_po_links ADD COLUMN IF NOT EXISTS item TEXT;
ALTER TABLE oc_po_links ADD COLUMN IF NOT EXISTS allocated_qty NUMERIC;
-- widen uniqueness to per-item allocations (one OC/PO pair can share several items)
ALTER TABLE oc_po_links DROP CONSTRAINT IF EXISTS oc_po_links_oc_number_po_number_key;
DO $$ BEGIN
  ALTER TABLE oc_po_links ADD CONSTRAINT oc_po_links_oc_po_item_key UNIQUE (oc_number, po_number, item);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- ── Activity log per order — follow-ups, handoffs, inquiries ──────────────────
-- Drives the "lost visibility" fix (explicit warehouse handoff + acknowledgment)
-- and gives an audit trail of who chased what, when.
CREATE TABLE IF NOT EXISTS order_activity (
  id               SERIAL PRIMARY KEY,
  so_number        TEXT REFERENCES orders(so_number) ON DELETE CASCADE,
  kind             TEXT,                         -- 'handoff' | 'ack' | 'inquiry' | 'note'
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Import snapshots — one row per CSV import ────────────────────────────────
-- Lets us detect stalls ("stuck N imports in a row") that a single search can't show.
CREATE TABLE IF NOT EXISTS import_snapshots (
  id               SERIAL PRIMARY KEY,
  source           TEXT,                         -- which saved search was imported
  imported_at      TIMESTAMPTZ DEFAULT now(),
  row_count        INTEGER
);
-- Modified time of the underlying export file, so we can warn when data is stale.
ALTER TABLE import_snapshots ADD COLUMN IF NOT EXISTS file_modified TIMESTAMPTZ;

-- ── EDI transactions (Orderful) — 850/856/810/860 pipeline per business number ──
-- Pulled straight from Orderful's API (GET /v3/transactions), not via Airtable/CSV.
-- id is Orderful's own transaction id, so re-syncs upsert cleanly.
CREATE TABLE IF NOT EXISTS edi_transactions (
  id                     TEXT PRIMARY KEY,       -- Orderful transaction id
  type                   TEXT,                   -- '850_PURCHASE_ORDER' | '856_SHIP_NOTICE' | '810_INVOICE' | '860_PURCHASE_ORDER_CHANGE' | …
  direction              TEXT,                   -- 'IN' (Naghedi is receiver) | 'OUT' (Naghedi is sender)
  business_number        TEXT,                   -- the PO — joins 850↔856↔810 for one order
  trading_partner        TEXT,                   -- the non-Naghedi party's name, e.g. 'Bloomingdale''s'
  stream                 TEXT,                   -- 'LIVE' | 'TEST'
  validation_status      TEXT,                   -- PROCESSING | VALID | INVALID
  delivery_status        TEXT,                   -- PENDING | SENT | DELIVERED | FAILED
  acknowledgment_status  TEXT,                   -- NOT_ACKNOWLEDGED | ACCEPTED | REJECTED | OVERDUE | ACCEPTED_WITH_ERRORS
  created_at             TIMESTAMPTZ,            -- Orderful's own createdAt (when the transaction happened)
  last_updated_at        TIMESTAMPTZ,
  -- 850s only: pulled from the DTM segment inside the per-transaction /message
  -- body (NOT exposed on the list endpoint) — see src/ingest/orderful.js.
  -- DTM 064 = "Do Not Deliver Before", DTM 001 = "Cancel After" (confirmed
  -- against real X12 850 content 2026-07-10). Replaces Nima's manual lookup.
  ship_not_before        DATE,
  cancel_after           DATE,
  -- 856/810 only: businessNumber is NOT the PO# for these (confirmed on real
  -- data — an 810's businessNumber is its own invoice number; some 856s use a
  -- carrier tracking number). The real PO# lives inside the message body:
  -- 810 → beginningSegmentForInvoice.purchaseOrderNumber (one);
  -- 856 → HL_loop[].purchaseOrderReference (one per order-level HL entry, can
  -- be several — see edi_document_po_refs below). This flag just means "we
  -- already checked", so re-syncs don't refetch a message with genuinely no PO ref.
  po_refs_checked        BOOLEAN DEFAULT false,
  synced_at              TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS ship_not_before DATE;
ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS cancel_after DATE;
ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS po_refs_checked BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_edi_business_number ON edi_transactions(business_number);
CREATE INDEX IF NOT EXISTS idx_edi_partner         ON edi_transactions(trading_partner);

-- One row per (856 or 810 transaction, PO it actually references) — an 856
-- covering a consolidated shipment can reference several POs, mirroring the
-- BOL fan-out in edi_fulfillments.
CREATE TABLE IF NOT EXISTS edi_document_po_refs (
  transaction_id TEXT NOT NULL,
  po_number      TEXT NOT NULL,
  PRIMARY KEY (transaction_id, po_number)
);
CREATE INDEX IF NOT EXISTS idx_edi_po_refs_po ON edi_document_po_refs(po_number);

-- ── EDI manual links — the human override when an 856/810 can't auto-link to
-- its 850 (Nima, 2026-07-10). The 850 is the master document everything else
-- joins against; when businessNumber/BOL matching finds no 850 for a stray
-- 856 or 810, this is where a person says "this one actually belongs to PO X"
-- — always visibly flagged as a manual override, never silently treated the
-- same as an automated match (see src/model/ediPipeline.js).
CREATE TABLE IF NOT EXISTS edi_manual_links (
  transaction_id   TEXT PRIMARY KEY,
  business_number  TEXT NOT NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── NetSuite Fulfillments (856 ASN search) — the BOL join key ────────────────
-- One row per PO DC Identifier, from the NetSuite saved search Nima already
-- exports for Airtable's "NetSuite Fulfillments" table. BOL is what actually
-- links an Orderful 856 to its originating 850 — NOT business_number, which
-- for some partners (e.g. Shopbop) holds a carrier tracking number on the 856
-- side instead of the PO number. po_number here is the 850's business_number.
CREATE TABLE IF NOT EXISTS edi_fulfillments (
  po_dc_identifier TEXT PRIMARY KEY,
  po_number        TEXT,
  dc               TEXT,
  bol              TEXT,
  scac             TEXT,
  pro_number       TEXT,
  dc_city          TEXT,
  ship_date        DATE,
  edi_synced       BOOLEAN,
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edi_fulfillments_po  ON edi_fulfillments(po_number);
CREATE INDEX IF NOT EXISTS idx_edi_fulfillments_bol ON edi_fulfillments(bol);

CREATE INDEX IF NOT EXISTS idx_orders_stage       ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_fulfillments_so    ON fulfillments(so_number);
CREATE INDEX IF NOT EXISTS idx_invoices_so        ON invoices(so_number);
CREATE INDEX IF NOT EXISTS idx_po_item            ON purchase_orders(item);
CREATE INDEX IF NOT EXISTS idx_oc_item             ON order_confirmations(item);
CREATE INDEX IF NOT EXISTS idx_ocpo_oc            ON oc_po_links(oc_number);
CREATE INDEX IF NOT EXISTS idx_ocpo_po            ON oc_po_links(po_number);
