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
-- Per-SO DC + store (Nima, 2026-07-22): these live on the Sales Order (the
-- store is the SO's customer; its DC is the customer's parent in the hierarchy).
-- Folding the 856-ASN search's "DC Code" + "Store Number" columns into the Order
-- Pipeline export makes the DC available per SO — no separate CSV — which is the
-- reliable source for DC breakdown / tags / custody. Nullable: populated only
-- once those columns are added to the Order Pipeline search and re-imported.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dc TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_number TEXT;

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

-- Carrier tracking numbers on the IF (2026-07-30), pulled from NetSuite's
-- TrackingNumberMap → trackingnumber join. An array because a multi-box shipment
-- carries several (IF7285 and IF7268 each have two). These power two checks Nima
-- asked for: an IF that HAS tracking but is still "Packed" was labelled and
-- physically shipped and just never got marked shipped in NetSuite (that's the
-- SO12288/SO12293 case) — while a packed IF with NO tracking is one that still
-- genuinely needs a label.
ALTER TABLE fulfillments ADD COLUMN IF NOT EXISTS tracking_numbers TEXT[];

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

-- Invoice TOTAL, distinct from amount_remaining (2026-07-30). The shipped-$
-- credit (stampShippedValue) valued a shipment by what was still OWED at ship
-- time — fine while Naghedi ships FOB/pre-payment and we observe it unpaid, but
-- it credits $0 for any shipment we first see after payment landed (exactly the
-- recently-closed orders the live NetSuite pull now surfaces). The total is the
-- stable value, so it's the fallback. Populated from the live pull's
-- `foreigntotal`; nullable for rows that predate this.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_total NUMERIC;

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

-- ── order_activity: REMOVED 2026-08-02 ───────────────────────────────────────
-- An early sketch of a per-order audit trail that was never wired up: it held 0
-- rows and had no reader or writer anywhere in the codebase. `order_events`
-- below is the real ledger and does the job properly. Dropped so a future reader
-- can't mistake this for the ledger and build against an empty table.
DROP TABLE IF EXISTS order_activity;

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
  -- 850s only: "we already pulled this 850's /message and extracted its ship-
  -- window dates". Gates backfillPoDates so partners that carry only one of the
  -- two dates (Nordstrom: cancel but no start; Shopbop: start but no cancel)
  -- still get fetched exactly once instead of being skipped by a "both NULL"
  -- test. Same idempotency idiom as po_refs_checked. (Phase D, 2026-07-28.)
  po_dates_checked       BOOLEAN DEFAULT false,
  synced_at              TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS ship_not_before DATE;
ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS cancel_after DATE;
ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS po_refs_checked BOOLEAN DEFAULT false;
ALTER TABLE edi_transactions ADD COLUMN IF NOT EXISTS po_dates_checked BOOLEAN DEFAULT false;

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

-- ── New-850 arrival alerts (Nima, 2026-07-29) ────────────────────────────────
-- The 10-min recurring-check cron now pulls Orderful (it used to only sync
-- Gmail), so a fresh 850 with no matching NetSuite SO can't sit unseen until
-- someone happens to click Sync on the EDI tab. One row per genuinely-NEW 850
-- transaction — "new" = a fresh INSERT into edi_transactions (detected via the
-- upsert's RETURNING (xmax=0)), NOT a re-sync of one we already had. That's why
-- this is its own table and not a boolean on edi_transactions: a default-false
-- column would flag the ENTIRE 850 history on first deploy; here only rows born
-- from a real insert ever exist, so existing POs are never mistaken for new.
-- Drives a dismissable banner (undismissed rows) and an auto-created quest_task
-- (instance_key edi:<bn>, so it collapses with any later EDI task for that PO).
-- Dismissing the banner does NOT close the task — banner = "heads-up since you
-- last looked"; the task is the durable "this PO still needs handling".
CREATE TABLE IF NOT EXISTS edi_arrivals (
  transaction_id   TEXT PRIMARY KEY,       -- → edi_transactions.id
  business_number  TEXT,                   -- the PO#
  trading_partner  TEXT,
  po_created_at    TIMESTAMPTZ,            -- the 850's own createdAt
  detected_at      TIMESTAMPTZ DEFAULT now(),
  dismissed        BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_edi_arrivals_open ON edi_arrivals(dismissed) WHERE dismissed = false;

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

-- ── EDI transaction acknowledgments (Nima, 2026-07-20) ───────────────────────
-- "We did have them validly sent, we have a valid version in the history" —
-- Bloomingdale's 856s that Orderful flagged INVALID but were actually
-- resent and accepted. hasIssue (src/model/ediPipeline.js) checks EVERY
-- transaction in a PO's group, so one bad historical 856 blocks the PO from
-- ever auto-closing even after a valid resend. This is the per-DOCUMENT
-- acknowledgment (deliberately separate from edi_po_resolutions, which closes
-- the whole PO's WORK) — linked_transaction_id records which later document
-- actually superseded it, if any; null + a note covers "confirmed nothing to
-- link, this one really has no valid replacement."
CREATE TABLE IF NOT EXISTS edi_transaction_acks (
  transaction_id        TEXT PRIMARY KEY,
  linked_transaction_id TEXT,
  note                  TEXT,
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- ── Doc seasons (Nima, 2026-07-20) ───────────────────────────────────────────
-- NetSuite tracks season (not year) on orders already, but there's no export
-- for it yet — lives app-only for now, same "do our work here" reasoning as
-- edi_po_resolutions. Free text so it covers both a dated season ("Summer
-- 2026") and 'Core' (year-round, not tied to a season) — useful across OC↔PO
-- matching AND EDI (surfacing a Bloomingdale's PO that's Core when everything
-- else on the board is a dated season, or vice versa). doc_type/doc_number is
-- the same natural-key pattern as `notes`. doc_type keeps 'PO' (inbound vendor
-- supply, purchase_orders.po_number) and 'EDI_PO' (the customer's own PO
-- number on the sales side, edi_transactions.business_number) SEPARATE —
-- they're different numbering domains and could collide on the same digits.
CREATE TABLE IF NOT EXISTS doc_seasons (
  doc_type    TEXT NOT NULL,     -- 'OC' | 'PO' | 'EDI_PO'
  doc_number  TEXT NOT NULL,
  season      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (doc_type, doc_number)
);

-- ── Document links (Nima, 2026-07-20) — the thing NetSuite can't do ─────────
-- A first-class, bidirectional association between ANY two documents /
-- transactions the app knows: attach an email to a Sales Order, tie an Item
-- Fulfillment to a task, connect an EDI PO to an SO, etc. Endpoints are typed
-- natural keys (a_type/a_number ↔ b_type/b_number), so this links across every
-- record type without a schema change per pairing. `label` is an optional
-- human note on the relationship (e.g. the email's subject, or "payment
-- dispute"). Distinct from notes.linked_doc_* (a note that happens to point
-- somewhere) — this is a pure link, no note required.
--   types: 'EMAIL' | 'TASK' | 'SO' | 'IF' | 'INV' | 'EDI_PO' | 'PO' | 'OC'
CREATE TABLE IF NOT EXISTS doc_links (
  id         SERIAL PRIMARY KEY,
  a_type     TEXT NOT NULL,
  a_number   TEXT NOT NULL,
  b_type     TEXT NOT NULL,
  b_number   TEXT NOT NULL,
  label      TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (a_type, a_number, b_type, b_number)
);
CREATE INDEX IF NOT EXISTS idx_doc_links_a ON doc_links(a_type, a_number);
CREATE INDEX IF NOT EXISTS idx_doc_links_b ON doc_links(b_type, b_number);

-- ── EDI supply link (Nima, 2026-07-20) ──────────────────────────────────────
-- Which INBOUND production PO an EDI order's goods come from — the vendor/
-- container PO (purchase_orders.po_number) that supplies it — OR a from_stock
-- flag when it ships from existing inventory with no inbound PO. Distinct from
-- edi_po_resolutions (the sales-side open/closed + NetSuite-ref override) and
-- from the auto-matched NetSuite SO/IF/invoice: this is the supply side. One
-- row per EDI order (business_number). po_number is free text — it may name a
-- real purchase_orders row or a PO the searches don't carry yet.
CREATE TABLE IF NOT EXISTS edi_supply (
  business_number  TEXT PRIMARY KEY,
  po_number        TEXT,                    -- inbound production/vendor PO
  from_stock       BOOLEAN DEFAULT false,   -- fulfilled from inventory, no inbound PO
  note             TEXT,
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ── EDI manual orders — the gap-filler (Nima, 2026-07-17) ────────────────────
-- Older EDI orders that already SHIPPED have aged out of every saved search and
-- the Orderful pull, so they can't appear in the automated pipeline at all — yet
-- Nima still needs to find them (this already helped locate two Bloomingdale's
-- orders + a ShopBop one). This table is a deliberately-separate, hand-entered
-- record: surfaced in its OWN section in the EDI view, every row stamped
-- "MANUAL — not confirmed by our process", never merged into or counted with the
-- automated orders. Purely additive; nothing else reads or trusts it.
CREATE TABLE IF NOT EXISTS edi_manual_orders (
  id               SERIAL PRIMARY KEY,
  business_number  TEXT NOT NULL,       -- the PO number (same key the pipeline groups on)
  trading_partner  TEXT,                -- Bloomingdale's / Nordstrom / ShopBop / …
  note             TEXT,                -- whatever's known: ship date, docs seen, where it was found
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── EDI PO resolutions (Nima, 2026-07-18) — the human's open/closed override ─
-- "Manually connect an 850 to data in NetSuite we may or may not have access
-- to in these saved searches." One row per EDI PO (business number):
--   netsuite_ref — the NetSuite doc it corresponds to (SO/IF/INV #, free text),
--                  recorded while the PO stays OPEN;
--   closed       — the human says this PO's work is DONE (shipped pre-Orderful,
--                  handled outside EDI, cancelled…) — takes it off the open queue.
-- Always displayed as a manual override, never merged silently with inference
-- (same principle as edi_manual_links).
CREATE TABLE IF NOT EXISTS edi_po_resolutions (
  business_number  TEXT PRIMARY KEY,
  closed           BOOLEAN NOT NULL DEFAULT false,
  netsuite_ref     TEXT,
  note             TEXT,
  updated_at       TIMESTAMPTZ DEFAULT now()
);
-- cancelled (Nima, 2026-07-20): the buyer killed the PO — no further documents
-- are ever coming. Off the open queue like closed, but recorded distinctly so
-- a cancelled PO can't be mistaken for completed work.
ALTER TABLE edi_po_resolutions ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT false;
-- review_state (Nima, 2026-07-28): a human-driven gate for old/uncertain POs.
--   'in_review'  — parked: someone flagged it for review; the app STOPS looking
--                  for its 856/810 (no point chasing docs on a PO we haven't
--                  confirmed is real). Sits in the per-partner In-Review tab.
--   'validated'  — confirmed real by tying it to its NetSuite order; the normal
--                  856/810 flow resumes. (Nima's "review to park, validate by
--                  confirming the NS order" model.)
--   null         — never touched; automatic tracking as before.
ALTER TABLE edi_po_resolutions ADD COLUMN IF NOT EXISTS review_state TEXT;

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

-- ── Quest emails (Gmail-to-quest hologram transmissions) ─────────────────────
-- Inbound Gmail messages, surfaced in the app as a "hologram" delivered by a
-- character from src/model/characters.js. id is Gmail's own message id, so
-- re-syncs upsert cleanly (same convention as edi_transactions.id).
-- character_id and dismissed are app-owned — deliberately excluded from the
-- sync upsert (see loadQuestEmails in src/ingest/loadToDb.js) so a re-sync
-- never clobbers a manual character reassignment or a dismissal, same
-- reasoning as order_confirmations.dismissed above.
CREATE TABLE IF NOT EXISTS quest_emails (
  id             TEXT PRIMARY KEY,        -- Gmail message id
  thread_id      TEXT,
  from_address   TEXT,
  from_name      TEXT,
  subject        TEXT,
  snippet        TEXT,
  body           TEXT,                    -- full decoded plain-text body (fixes forwarded content, which snippet alone never showed)
  received_at    TIMESTAMPTZ,
  is_unread      BOOLEAN DEFAULT true,    -- refreshed from Gmail's own UNREAD label every sync
  label_ids      TEXT[],
  character_id   TEXT,                    -- src/model/characters.js id; null until first sync assigns one
  dismissed      BOOLEAN DEFAULT false,   -- app-only hide; never touches Gmail
  synced_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE quest_emails ADD COLUMN IF NOT EXISTS body TEXT;
-- Note ledger (Nima, 2026-07-18): a hand-written summary/highlight per email,
-- for later reference. App-owned like character_id/dismissed — the Gmail sync
-- upsert never writes it, so a re-sync can't clobber a note.
ALTER TABLE quest_emails ADD COLUMN IF NOT EXISTS note TEXT;
CREATE INDEX IF NOT EXISTS idx_quest_emails_received ON quest_emails(received_at);

-- Remembers which character was manually assigned for a given sender, so
-- future emails from the same address inherit it instead of a fresh random
-- pick (Nima, 2026-07-15: "select a different messenger for that type of
-- message" — sender is the simplest definition of "type" available before
-- any Gmail label taxonomy exists).
CREATE TABLE IF NOT EXISTS email_character_prefs (
  from_address   TEXT PRIMARY KEY,
  character_id   TEXT NOT NULL,
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Promoting a transmission to a durable task (Nima, 2026-07-15): once an
-- email matters enough to act on, it shouldn't just cycle out of the unread-
-- only transmissions list — it becomes its own row here, carrying its
-- character/subject/snippet along so the task keeps the same "who delivered
-- this" identity. email_id is a loose reference (no FK) — quest_emails rows
-- aren't guaranteed to stick around, but a task must survive regardless.
-- needs_type (Nima, 2026-07-15): 'none' | 'reply' | 'acknowledgment' | 'file' | 'netsuite_doc'
--   reply          — we owe a reply; closes itself once one is sent (see
--                    checkRepliedTasks in server/queries.js scanning the
--                    Gmail thread for an outbound message after created_at)
--   acknowledgment — no action beyond recording "seen and understood"
--   file           — a non-NetSuite file/document is needed; needs_note holds
--                    a REFERENCE (a link or where-to-find-it note), never the
--                    file itself — the app doesn't store attachments
--   netsuite_doc   — a NetSuite transaction is needed; netsuite_doc_type +
--                    netsuite_doc_number hold the normalized reference
--                    (typing "1213" under Sales Order saves as "SO1213")
CREATE TABLE IF NOT EXISTS quest_tasks (
  id                  SERIAL PRIMARY KEY,
  email_id            TEXT,
  thread_id           TEXT,                -- copied from the source email; used to auto-detect a reply
  character_id        TEXT,
  from_address        TEXT,
  from_name           TEXT,
  subject             TEXT,
  snippet             TEXT,
  status              TEXT DEFAULT 'open', -- 'open' | 'done'
  needs_type          TEXT DEFAULT 'none',
  needs_note          TEXT,
  netsuite_doc_type   TEXT,                -- 'PO'|'SO'|'IF'|'IR'|'IT'|'TO' — only when needs_type='netsuite_doc'
  netsuite_doc_number TEXT,                -- normalized, e.g. 'SO1213'
  urgency             TEXT,                -- 'hi' | 'mid' | 'lo' | null — reuses the app's existing sev-hi/mid/lo tiers
  created_at          TIMESTAMPTZ DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS needs_type TEXT DEFAULT 'none';
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS needs_note TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS urgency TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS thread_id TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS netsuite_doc_type TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS netsuite_doc_number TEXT;
CREATE INDEX IF NOT EXISTS idx_quest_tasks_status ON quest_tasks(status);

-- Recurring tasks (Nima, 2026-07-16) — a quest_task can be spawned by a
-- recurring_task_templates row instead of an email. Reuses the same table
-- (and therefore the same Dashboard/Kanban/Tasks UI, activity log, etc.)
-- rather than a parallel model — a recurring instance IS a task.
--   completion_mode: 'standard' (today's manual mark-done/needs-type flow,
--     the default for transmission-derived tasks) | 'checkbox' (no needs-
--     type/urgency UI, just a plain done toggle) | 'verified' (Mark done is
--     REJECTED server-side unless verify_key's check passes AND every
--     checklist item is checked — see runVerification in server/queries.js)
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS recurring_key TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS instance_key TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS completion_mode TEXT DEFAULT 'standard';
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS verify_key TEXT;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS checklist JSONB;
-- Daily Flight Plan scheduling (Nima, 2026-07-28) — a real due time and a
-- measured/estimated duration per task. Both nullable: the planner falls back
-- to an urgency-derived deadline and a per-kind default duration when unset
-- (see src/model/routeItems.js), so existing tasks keep working untouched.
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE quest_tasks ADD COLUMN IF NOT EXISTS duration_min INTEGER;
-- Plain (non-partial) unique index — NULLs never conflict with each other in
-- Postgres uniqueness checks, so this is already safe for transmission-
-- derived tasks (instance_key NULL) while still deduping recurring instances,
-- AND (unlike a partial index) it works directly as an ON CONFLICT target.
-- Dropped and recreated because an earlier version of this migration created
-- it as a partial index (WHERE instance_key IS NOT NULL) under the same
-- name — IF NOT EXISTS alone won't redefine an index that already exists.
DROP INDEX IF EXISTS idx_quest_tasks_instance_key;
CREATE UNIQUE INDEX idx_quest_tasks_instance_key ON quest_tasks(instance_key);

-- The template a recurring task is generated from. schedule_times is only
-- meaningful for schedule_type='daily_times' (e.g. '{09:00,14:00}' — one
-- instance per listed time per day); 'daily' just means once per day,
-- whenever the app is next opened/synced after midnight.
CREATE TABLE IF NOT EXISTS recurring_task_templates (
  key             TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  character_id    TEXT,                          -- fixed messenger; null = random each occurrence
  schedule_type   TEXT NOT NULL,                  -- 'daily' | 'daily_times'
  schedule_times  TEXT[],
  completion_mode TEXT NOT NULL DEFAULT 'checkbox',
  verify_key      TEXT,
  checklist_items JSONB,
  urgency         TEXT,
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed templates — ON CONFLICT DO NOTHING so re-running migrate never resets
-- an active/inactive toggle or edits made after creation.
INSERT INTO recurring_task_templates
  (key, title, description, character_id, schedule_type, schedule_times, completion_mode, verify_key, checklist_items, urgency)
VALUES
  -- Catalog + PO Warehouse View became auto-verified on 2026-07-17 (they land
  -- in Naghedi-Warehouse's Supabase with timestamps — see getNwFreshness).
  -- Only the NetSuite Items CSV stays manual: it lives solely in that app's
  -- local browser storage, so nothing remote can confirm it ran.
  ('csv-freshness-monitor', 'Upload the latest CSVs',
   'Work-Hub''s saved-search exports and the Naghedi-Warehouse Catalog/PO imports are checked automatically. The NetSuite Items CSV can''t be checked remotely — check it off once you''ve actually run it.',
   'bugs', 'daily', NULL, 'verified', 'csv_freshness_workhub',
   '[{"key":"nw-items","label":"Naghedi-Warehouse: NetSuite Items CSV","done":false}]'::jsonb,
   'hi'),
  ('airtable-daily-reminder', 'Airtable upload reminder', 'We need an Airtable upload.',
   NULL, 'daily_times', ARRAY['09:00','14:00'], 'checkbox', NULL, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- ── Order events ledger (Nima, 2026-07-17) ───────────────────────────────────
-- "A ledger, a repository we can go back and search through, and the basis for
-- the calendar showing what occurred every day." One row per OBSERVED document
-- transition. First writers are the QR custody scans (label printed per IF,
-- scanned OUT when handed to the warehouse, IN when it comes back) — the two
-- transitions NetSuite has no record of at all. Ingest-derived transitions
-- (stage changes seen between imports) join later under the same table.
-- Custody rows are append-only on purpose: re-handoffs happen (an IF can go
-- back out after a fix), so state = the LATEST OUT vs latest IN, and the full
-- history stays queryable.
--
-- ── The document-transition spine (2026-08-02) ───────────────────────────────
-- The "join later" above is now done. src/model/orderEvents.js derives the rest
-- of the pipeline from synced document state, and deriveOrderEvents() in
-- src/ingest/loadToDb.js writes it at the end of every sync (CSV import, live
-- NetSuite pull, and the CLI ingest alike). Full event vocabulary:
--
--   SO_IMPORTED       SO   orders.first_seen
--   IF_CREATED        IF   fulfillments.if_date
--   CUSTODY_OUT/IN    IF   QR scans          (written by the scan handlers)
--   PACKED            IF   status = Packed   — observed, see below
--   INVOICED          INV  invoice exists    — observed
--   REACHED_APPROVED  IF   packed_status     (written by stampApprovedForShipping)
--   PAID              INV  status = Paid In Full — observed
--   ROUTED            DC   routing_shipment.bol_generated_at
--   DEPARTED          IF   fulfillments.actual_ship_date
--   ASN_SENT          PO   856 OUT/LIVE transmitted to Orderful
--   INVOICE_SENT      PO   810 OUT/LIVE transmitted to Orderful
--
-- Two other event types predate the spine and are written elsewhere:
-- SHIPPED_VALUE (a shipment's dollar value, note = the amount) and
-- CUSTODY_CLEARED (departure cleanup; pinned to the ship date).
--
-- ⚠️ occurred_at is NOT uniformly trustworthy, and that is deliberate. Most
-- events carry a real date from the source row. PACKED / INVOICED / PAID have no
-- recorded date anywhere in NetSuite's saved-search shape — we only ever see the
-- state a document is in right now — so their occurred_at is when the sync first
-- OBSERVED that state, accurate to within one sync interval. The backfill refuses
-- to write those at all rather than date 98 invoices "today" and invent a history
-- that never happened. Anything reading this table for a precise date should
-- prefer the events above that are not marked observed.
--
-- Idempotent by (event_type, doc_type, doc_number) — enforced in code rather than
-- by a unique constraint, because the CUSTODY_* rows are legitimately repeatable
-- (an IF can go back out to the warehouse after a fix).
CREATE TABLE IF NOT EXISTS order_events (
  id          SERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,        -- see the vocabulary above
  doc_type    TEXT NOT NULL,        -- 'IF' | 'SO' | 'INV' | 'PO' | 'DC'
  doc_number  TEXT NOT NULL,        -- normalized, e.g. 'IF12345'
  so_number   TEXT,                 -- denormalized spine ref (loose — no FK; events must survive doc churn)
  note        TEXT,
  source      TEXT DEFAULT 'scan',  -- 'scan' | 'manual' | 'derived'
  occurred_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_doc      ON order_events(doc_type, doc_number);
CREATE INDEX IF NOT EXISTS idx_order_events_so       ON order_events(so_number);
CREATE INDEX IF NOT EXISTS idx_order_events_occurred ON order_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_order_events_type     ON order_events(event_type);

-- ── Fulfillment boxes (Nima, 2026-07-17) — the IN-scan box capture ───────────
-- When a packed IF is scanned back IN from the warehouse, the scanner may
-- capture its carton's weight and L×W×H here. Always SKIPPABLE — a custody
-- scan never blocks on it. One row per carton, so a multi-box IF gets several
-- rows. This is a WORKING table for the custody register, NOT the ledger: on
-- departure the rows are pruned and a single CUSTODY_CLEARED order_event keeps
-- the summary (box count + total weight), the same "snapshot before it's gone"
-- pattern as stampShippedValue. Loose if_number ref (no FK) — a box can be
-- captured before the IF lands in an import, same as the custody scans.
CREATE TABLE IF NOT EXISTS fulfillment_boxes (
  id           SERIAL PRIMARY KEY,
  if_number    TEXT NOT NULL,
  weight_lb    NUMERIC,
  length_in    NUMERIC,
  width_in     NUMERIC,
  height_in    NUMERIC,
  note         TEXT,
  captured_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_boxes_if ON fulfillment_boxes(if_number);

-- Weaver → NetSuite update, twice daily (Nima, 2026-07-17) — same seed
-- pattern as above: ON CONFLICT DO NOTHING so re-migrating never resets edits.
INSERT INTO recurring_task_templates
  (key, title, description, character_id, schedule_type, schedule_times, completion_mode, verify_key, checklist_items, urgency)
VALUES
  ('weaver-netsuite-update', 'Update Weaver → NetSuite',
   'Push the latest Weaver production data into NetSuite so inventory and PO receipts stay current.',
   NULL, 'daily_times', ARRAY['09:00','14:00'], 'checkbox', NULL, NULL, 'mid')
ON CONFLICT (key) DO NOTHING;

-- Journal (Nima, 2026-07-15): "track what was done within the day and go
-- back and review quickly" — one row per meaningful quest_task state change,
-- also folded into the Calendar view (see client/src/views/Calendar.jsx).
CREATE TABLE IF NOT EXISTS quest_task_activity (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER REFERENCES quest_tasks(id) ON DELETE CASCADE,
  kind       TEXT,   -- 'created' | 'needs_set' | 'urgency_set' | 'done' | 'reopened' | 'reply_detected'
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quest_task_activity_task    ON quest_task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_quest_task_activity_created ON quest_task_activity(created_at);

-- ── Notes (Nima, 2026-07-20) — the universal Datapad, generalized off the
-- email-only quest_emails.note. One row per note-on-anything: doc_type +
-- doc_number is the natural key it's attached to (email id / task id /
-- business_number / so_number / if_number / inv_number). linked_doc_* is an
-- optional second attachment — "attach a sales order/fulfillment to it as we
-- go" — nullable, no FK (the referenced doc may not exist in any table here,
-- e.g. an SO#/IF# typed by hand). quest_emails.note is left in place and
-- UNIONed at query time rather than migrated, so nothing existing moves.
CREATE TABLE IF NOT EXISTS notes (
  id                SERIAL PRIMARY KEY,
  doc_type          TEXT NOT NULL,   -- 'EMAIL' | 'TASK' | 'EDI_PO' | 'SO' | 'IF' | 'INV'
  doc_number        TEXT NOT NULL,
  note              TEXT NOT NULL,
  linked_doc_type   TEXT,
  linked_doc_number TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_doc ON notes(doc_type, doc_number);

-- ── EDI routing + BOL (Nima, 2026-07-22) ─────────────────────────────────────
-- Replaces the NetSuite routing_helper.js Suitelet + Google-Sheet BOL step.
--
-- edi_packages: the routing feed (EDIPackagesVolume, searchid=3947), one row
-- per PO-DC — exactly the grain the export ships. Natural key po_dc so a
-- re-import upserts. This is the raw material the Routing view consolidates by
-- DC. Rows for a PO that's fully shipped simply stop appearing on re-export;
-- we keep the last-seen values (no prune) since a routed PO's numbers don't
-- change and the shipment rows below are the durable record.
CREATE TABLE IF NOT EXISTS edi_packages (
  po_dc                TEXT PRIMARY KEY,   -- "7527064-CG"
  po_number            TEXT,
  dc                   TEXT,               -- DC code: "CG", "584"
  weight_lb            NUMERIC,            -- total weight for this PO-DC
  cartons              INTEGER,
  units                INTEGER,
  cubic_feet_rounded   NUMERIC,            -- feed's own per-row round-up
  cubic_feet_raw       NUMERIC,            -- unrounded; the rollup sums then ceils
  suggested_bol        TEXT,               -- feed's suggestion, reference-only
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edi_packages_po ON edi_packages(po_number);
CREATE INDEX IF NOT EXISTS idx_edi_packages_dc ON edi_packages(dc);

-- edi_fulfillment_pack (Nima, 2026-08-02): the pack check. edi_packages above is
-- PO-DC grain, which is what a BOL needs but is useless for "WHICH fulfilment is
-- short" — the rollup has already summed that away. This keeps the per-IF pair:
-- units the fulfilment says it ships vs units actually in its cartons.
--
-- Packing EDI freight is manual and a missed item is otherwise invisible: the
-- cartons ship, the 856 claims quantities that aren't in the boxes, and it
-- surfaces as a chargeback weeks later. See src/model/packCheck.js for why this
-- is checked per-IF and not against the sales order.
--
-- REPLACED wholesale by each sync, exactly like edi_packages — an IF absent from
-- the pull has shipped and must not linger and re-flag a closed shipment.
CREATE TABLE IF NOT EXISTS edi_fulfillment_pack (
  if_number     TEXT PRIMARY KEY,
  po_dc         TEXT NOT NULL,      -- "50073677-799"; joins to edi_packages.po_dc
  po_number     TEXT,
  dc            TEXT,
  if_units      INTEGER,            -- POSITIVE InvtPart lines only (see ifUnitsSql)
  packed_units  INTEGER,            -- summed across this IF's carton records
  cartons       INTEGER,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edi_fulfillment_pack_podc ON edi_fulfillment_pack(po_dc);

-- fulfillment_dc (Nima, 2026-08-02): which PO and destination DC each item
-- fulfilment belongs to — the durable IF↔BOL link.
--
-- Why this exists separately from edi_fulfillment_pack above: that table is
-- REPLACED every sync and only ever holds UNSHIPPED fulfilments, so the moment
-- freight departs its DC is forgotten. That's precisely when we need it, because
-- a departure is counted per BOL and the BOL is identified by (partner, DC, POs).
--
-- The number this fixes: 2026-07-30 shows 50 fulfilments shipped, which reads as
-- 50 shipments. It was 8 — seven Bloomingdale's BOLs plus one parcel. Each DC on
-- an EDI PO gets its own IF, so counting IFs inflates departures roughly 6×.
-- Nima: "each DC has multiple IF … that inflates the number … we should be able
-- to associate the IF with the BOL and consolidate them as one big massive
-- shipment."
--
-- UPSERT, never deleted — unlike every other EDI table here. A fulfilment that
-- has shipped keeps its row forever; that is the entire point.
CREATE TABLE IF NOT EXISTS fulfillment_dc (
  if_number   TEXT PRIMARY KEY,
  po_dc       TEXT NOT NULL,   -- raw custbody_po_cd_identifier, e.g. "7590875-SC"
  po_number   TEXT,
  dc          TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_dc_po ON fulfillment_dc(po_number);
CREATE INDEX IF NOT EXISTS idx_fulfillment_dc_dc ON fulfillment_dc(dc);

-- BOL number sequence — the "never reuse a BOL" guarantee. A Postgres sequence
-- never hands out the same value twice, even across rollbacks or deletes, so a
-- voided shipment can never recycle its number. Base is arbitrary/readability
-- only (Nima: the 1731230… base isn't meaningful) — uniqueness is the point.
CREATE SEQUENCE IF NOT EXISTS bol_number_seq START WITH 1731231;

-- bol_registry: append-only ledger of every BOL number ever minted, and to
-- what. Rows are NEVER deleted — voiding a shipment leaves its number claimed
-- here forever. The UNIQUE PK is the belt to the sequence's suspenders.
CREATE TABLE IF NOT EXISTS bol_registry (
  bol_number   TEXT PRIMARY KEY,
  partner      TEXT,
  dc           TEXT,
  member_pos   TEXT[],
  minted_at    TIMESTAMPTZ DEFAULT now()
);

-- routing_shipment: one shipment = (partner, DC) rolling up 1..many POs, with
-- ONE BOL. The rollup is computed live in the Routing view; a row is persisted
-- when Nima assigns a BOL. dc_po_key (partner|dc|sorted-POs) is the idempotency
-- key: re-assigning the same DC+PO set returns the same shipment/BOL instead of
-- burning a new number; adding/removing a PO is a genuinely different shipment.
-- Reference + auth fields (phase 2) and BOL-doc fields (phase 3) are nullable.
CREATE TABLE IF NOT EXISTS routing_shipment (
  id               SERIAL PRIMARY KEY,
  dc_po_key        TEXT UNIQUE NOT NULL,
  partner          TEXT NOT NULL,
  dc               TEXT NOT NULL,
  member_pos       TEXT[] NOT NULL,
  cartons          INTEGER,
  units            INTEGER,
  weight_lb        INTEGER,     -- rounded UP whole pounds (portal entry)
  cubic_feet       INTEGER,     -- ceil(sum raw cubic feet) (portal entry)
  bol_number       TEXT UNIQUE, -- assigned from bol_number_seq; NULL until assigned
  -- A freshly-assigned BOL still needs to be routed (Nima, 2026-07-22) — that's
  -- the default state until it's submitted to the portal / authorized / routed.
  status           TEXT DEFAULT 'needs_routing',
  -- phase 2: routing references captured off the portal/routing email
  project_number   TEXT,        -- Bloomingdale's returns this on portal entry
  shipment_number  TEXT,        -- Bloomingdale's returns this too
  auth_number      TEXT,        -- from the routing email (may be shared across shipments)
  carrier          TEXT,
  scac             TEXT,
  ship_date        DATE,
  -- phase 3: generated BOL document
  bol_generated_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routing_shipment_partner ON routing_shipment(partner);
-- Macy's guide fields (Nima, 2026-07-22): which 1:1 Merge Center this
-- Bloomingdale's shipment routes through (assigned per routing — CA/NJ/HP), plus
-- the physical trailer + seal numbers that must appear on the BOL.
ALTER TABLE routing_shipment ADD COLUMN IF NOT EXISTS merge_center   TEXT DEFAULT 'CA';
ALTER TABLE routing_shipment ADD COLUMN IF NOT EXISTS trailer_number TEXT;
ALTER TABLE routing_shipment ADD COLUMN IF NOT EXISTS seal_number    TEXT;
-- FedEx pickup confirmation number (Nima, 2026-07-27): goes on the routing guide
-- / BOL. Per-shipment; the master carries its own on the auth (below).
ALTER TABLE routing_shipment ADD COLUMN IF NOT EXISTS fedex_pickup_number TEXT;
-- shipped_at (Nima, 2026-07-29): stamped when the physical shipment leaves. The
-- record is KEPT (BOL number never reused), but a shipped shipment moves out of
-- the active Routing queue into a "Shipped" archive tab so gone BOLs stop
-- cluttering the board. Explicit "Mark shipped" action — nothing auto-ships.
ALTER TABLE routing_shipment ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;

-- routing_auth: a routing authorization is its OWN entity, not a per-shipment
-- field (Nima, 2026-07-22). One auth number covers a SET of shipments — it can
-- cover everything routed in one go, or there can be several auths each
-- covering a subset — so shipments point at an auth (routing_shipment.auth_number
-- is the soft FK), not the reverse. Bloomingdale's provides the auth# + carrier
-- + SCAC together in the routing email; assigning the auth to shipments stamps
-- their carrier/SCAC from here. Nordstrom is always CTE/CAIE with no auth email,
-- so its shipments can carry carrier/SCAC without an auth row.
CREATE TABLE IF NOT EXISTS routing_auth (
  auth_number  TEXT PRIMARY KEY,
  partner      TEXT,
  carrier      TEXT,
  scac         TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
-- Master BOL number (Nima, 2026-07-22): when one authorization covers several
-- final-destination DCs via a merge center, the app mints ONE Master BOL number
-- (from bol_number_seq, same never-reuse guarantee) recorded on the auth. It is
-- NOT transmitted on the 856; the underlying per-DC BOLs are.
ALTER TABLE routing_auth ADD COLUMN IF NOT EXISTS master_bol_number TEXT UNIQUE;
ALTER TABLE routing_auth ADD COLUMN IF NOT EXISTS merge_center TEXT DEFAULT 'CA';
-- Master BOL ship date + FedEx pickup number (Nima, 2026-07-27): when BOLs are
-- grouped into one master shipment, the master gets its own date (printed on the
-- master BOL) and a FedEx pickup number.
ALTER TABLE routing_auth ADD COLUMN IF NOT EXISTS ship_date DATE;
ALTER TABLE routing_auth ADD COLUMN IF NOT EXISTS fedex_pickup_number TEXT;
-- Master BOL pallet count (Nima, 2026-07-28): the real number of pallets isn't
-- known until the shipment is physically built, so it's MANUALLY assigned per
-- master BOL (not the old ceil(weight/45) estimate). Drives the master BOL's
-- H.U. QTY and adds PALLET_LB per pallet to the printed carrier weight.
ALTER TABLE routing_auth ADD COLUMN IF NOT EXISTS pallet_count INTEGER;

-- routing_hold (Nima, 2026-07-22): a PO-DC deliberately pulled OUT of routing —
-- packed but can't ship yet, so it must NOT be consolidated onto another PO's
-- BOL. A held (po, dc) is excluded from consolidation and shown in a "held"
-- section until released. Holding a PO already on a BOL restructures that
-- shipment (the PO is dropped from it; the shipment is recomputed or voided).
CREATE TABLE IF NOT EXISTS routing_hold (
  po          TEXT NOT NULL,
  dc          TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (po, dc)
);

-- email_links (Nima, 2026-07-22): attach a Gmail message to any document (a
-- routing shipment/BOL, an authorization, an order, a task…). Lightweight — we
-- store only a deep link to the Gmail version + the subject (the link label),
-- never the body. doc_type + doc_number is the natural key it hangs off; the
-- same reusable widget drops onto anything.
CREATE TABLE IF NOT EXISTS email_links (
  id           SERIAL PRIMARY KEY,
  doc_type     TEXT NOT NULL,   -- 'ROUTING_SHIPMENT' | 'AUTH' | 'SO' | 'PO' | 'IF' | 'INV' | 'EDI_PO' | 'TASK'
  doc_number   TEXT NOT NULL,
  subject      TEXT,            -- shown as the clickable link's label
  gmail_url    TEXT NOT NULL,   -- deep link to the Gmail message/thread
  gmail_id     TEXT,            -- Gmail message id (when picked from synced mail)
  thread_id    TEXT,
  from_addr    TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_links_doc ON email_links(doc_type, doc_number);

-- catalogue_skus (Nima, 2026-07-27): the product SKUs uploaded to the GS1/GTIN
-- catalogue (the "uploaded" set). One row per color-level SKU. Imported from the
-- catalogue export; sku_key = "<PRODUCTID>|<COLORNORM>" is how we match a PO
-- line (which carries no raw UPC) to its catalogue entry. Currently one master
-- list applied to Nordstrom; extensible to more partners later.
CREATE TABLE IF NOT EXISTS catalogue_skus (
  sku_key      TEXT PRIMARY KEY,   -- '<PRODUCTID>|<COLORNORM>'
  upc          TEXT,               -- GTIN
  product_id   TEXT,
  color        TEXT,
  color_code   TEXT,               -- GS1USColorCode (≈ NRF color code)
  description  TEXT,
  size_code    TEXT,
  size_desc    TEXT,
  change_date  TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalogue_upc ON catalogue_skus(upc);
CREATE INDEX IF NOT EXISTS idx_catalogue_pid ON catalogue_skus(product_id);

-- ShipCentral SO queue (Nima, 2026-07-27) — the pack-readiness signal from the
-- native NetSuite pack/ship station. One row per Sales Order sitting in the
-- ShipCentral queue at pendingFulfillment (staged to pack, not yet fulfilled).
-- Source: CSV export of saved search customsearch_shipcentralsalesordersearch.
-- SO-keyed, so it joins the orders/fulfillments tables directly. Pruned on
-- re-import: a SO that's been packed drops off the queue, so its "pack queue"
-- badge should disappear — the current export IS the complete live queue.
CREATE TABLE IF NOT EXISTS shipcentral_queue (
  so_number        TEXT PRIMARY KEY,   -- "SO12375"
  location         TEXT,               -- station location id (e.g. "7")
  status           TEXT,               -- "pendingFulfillment"
  ship_date        DATE,
  actual_ship_date DATE,
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipcentral_status ON shipcentral_queue(status);

-- day_plan_item (Nima, 2026-07-28) — persisted per-day state for the Daily
-- Flight Plan. The plan itself is recomputed on every load from live
-- orders/tasks/EDI via computeRoute (EDF), so this table stores ONLY the human
-- overrides for a given day:
--   • sort_index — a manual sequence. If ANY row for a date has a non-null
--     sort_index, that whole day is in MANUAL mode (the planner preserves the
--     order and just recomputes clock times + at-risk); otherwise it's auto
--     (EDF). "Reset to auto" nulls the day's sort_index.
--   • done/done_at — check-off for the NON-task legs (EDI routing, shippable
--     orders) whose completion has no home in quest_tasks. Task legs use
--     quest_tasks.status as their source of truth.
-- Keyed by the synthetic route-item id ('task-<id>', 'edi-<po>', 'ship-<so>',
-- 'inv-<so>'). label is a snapshot for a future completed-work ledger.
CREATE TABLE IF NOT EXISTS day_plan_item (
  plan_date   DATE NOT NULL,
  item_id     TEXT NOT NULL,
  sort_index  INTEGER,
  done        BOOLEAN DEFAULT false,
  done_at     TIMESTAMPTZ,
  label       TEXT,
  PRIMARY KEY (plan_date, item_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_stage       ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_fulfillments_so    ON fulfillments(so_number);
CREATE INDEX IF NOT EXISTS idx_invoices_so        ON invoices(so_number);
CREATE INDEX IF NOT EXISTS idx_po_item            ON purchase_orders(item);
CREATE INDEX IF NOT EXISTS idx_oc_item             ON order_confirmations(item);
CREATE INDEX IF NOT EXISTS idx_ocpo_oc            ON oc_po_links(oc_number);
CREATE INDEX IF NOT EXISTS idx_ocpo_po            ON oc_po_links(po_number);

-- ── The EDI paper trail for a routed shipment (Nima, 2026-08-01) ────────────
-- "We want the BOL information archived, saved, linked with that 850 and 856,
-- all for reference if we need to go back to it."
--
-- The lineage is derivable today — an outbound 856's business_number IS the BOL
-- number, and edi_document_po_refs ties that ASN back to the member POs, whose
-- own inbound 850s carry the PO number as their business_number. But derivation
-- alone is not an archive: the Orderful sync works over a moving window, so a
-- transaction that ages out takes the reference with it, and the business_number
-- convention is a partner habit, not a contract. So the lineage is SNAPSHOTTED
-- when the shipment is archived — ids and timestamps frozen at that moment.
--
-- One row per shipment. po_links is [{ po, transactionId, businessNumber,
-- createdAt }] for the 850s — jsonb rather than a child table because it is
-- written once, read whole, and never queried by PO.
CREATE TABLE IF NOT EXISTS routing_shipment_edi (
  shipment_id          INTEGER PRIMARY KEY REFERENCES routing_shipment(id) ON DELETE CASCADE,
  bol_number           TEXT,
  asn_transaction_id   TEXT,      -- the 856's Orderful transaction id
  asn_business_number  TEXT,      -- = the BOL number, as transmitted
  asn_created_at       TIMESTAMPTZ,
  asn_delivery_status  TEXT,
  asn_ack_status       TEXT,
  po_links             JSONB DEFAULT '[]'::jsonb,
  captured_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edi_tx_business ON edi_transactions(business_number);

-- What UPS actually BILLED, per shipment, harvested from ShipStation.
--
-- This exists because the wholesale UPS account (C6J610 "Big Box") cannot be
-- rate-quoted through ShipStation right now — its carrier connection is broken and
-- only Nima can reconnect it. But thousands of labels WERE bought on that account
-- through ShipStation (2023 → 2026-06-29), and each recorded the real billed cost
-- next to the weight, dimensions and destination. That is the only true wholesale
-- pricing reachable today, and an actual invoice beats an estimate in every way
-- except age. See src/model/upsRates.js.
--
-- ups_account is DERIVED from the 1Z tracking number, which embeds the six-char UPS
-- shipper number. The shipment record itself only says carrierCode "ups", so
-- tracking is the sole signal for which of the two accounts paid.
--
-- Keyed on the tracking number so re-pulling an overlapping date window upserts,
-- and a label voided after the fact corrects itself instead of inflating a median.
CREATE TABLE IF NOT EXISTS ups_shipment_cost (
  tracking_number  TEXT PRIMARY KEY,
  ups_account      TEXT,            -- 'C6J610' (wholesale) | '18GE01' (ecom) | NULL if unparseable
  shipstation_id   BIGINT,
  order_number     TEXT,
  carrier_code     TEXT,
  service_code     TEXT,            -- 'ups_ground', 'ups_2nd_day_air', …
  ship_date        DATE,
  create_date      TIMESTAMPTZ,
  weight_lb        NUMERIC,         -- normalized to POUNDS at ingest (the API mixes oz and lb)
  length_in        NUMERIC,
  width_in         NUMERIC,
  height_in        NUMERIC,
  dest_postal      TEXT,
  dest_state       TEXT,
  dest_city        TEXT,
  dest_residential BOOLEAN,
  shipment_cost    NUMERIC,         -- what UPS billed
  insurance_cost   NUMERIC,
  voided           BOOLEAN DEFAULT false,
  store_id         INTEGER,
  synced_at        TIMESTAMPTZ DEFAULT now()
);

-- The rate lookup always filters account + service, then matches on geography and
-- weight, so index that path.
CREATE INDEX IF NOT EXISTS idx_ups_cost_acct_svc ON ups_shipment_cost(ups_account, service_code);
CREATE INDEX IF NOT EXISTS idx_ups_cost_state ON ups_shipment_cost(dest_state);
CREATE INDEX IF NOT EXISTS idx_ups_cost_weight ON ups_shipment_cost(weight_lb);

-- ── Carton-level ASN reconciliation (Nima, 2026-07-31) ───────────────────────
-- Did every carton that actually LEFT get announced on an 856 the partner
-- received? See src/model/asnCartonCheck.js for the comparison and
-- src/ingest/asnCartonSync.js for the runner.
--
-- Why this is persisted at all, when the check itself is pure: a full run costs
-- one Orderful message-body GET per delivered ASN (212 of them live) plus two
-- SuiteQL queries, so it can never answer an HTTP request. The run writes here
-- and the UI reads Neon.

-- The declared side, harvested from the 856 bodies. DURABLE — never replaced.
-- A delivered ASN's message body is immutable, so it is fetched exactly once
-- ever and every later run compares against these rows for free. That is what
-- makes the check affordable on a schedule.
CREATE TABLE IF NOT EXISTS edi_asn_cartons (
  transaction_id  TEXT NOT NULL,      -- Orderful txn id; joins edi_transactions.id
  sscc            TEXT NOT NULL,      -- as transmitted (zero-padded); normalize before comparing
  harvested_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (transaction_id, sscc)
);

-- Which 856 bodies have been read. Separate from the table above because a
-- manifest can legitimately yield ZERO SSCCs (pack segments with no license
-- plate) — without this marker those documents would be re-fetched forever, and
-- "no cartons declared" would be indistinguishable from "never looked".
-- Failures are deliberately NOT recorded, so an unreadable message is retried
-- next run instead of being silently written off.
CREATE TABLE IF NOT EXISTS edi_asn_harvest (
  transaction_id     TEXT PRIMARY KEY,
  ssccs              INTEGER,         -- distinct license plates found
  packs_without_sscc INTEGER,         -- cartons declared with no SSCC at all
  harvested_at       TIMESTAMPTZ DEFAULT now()
);

-- The findings of the latest run, one row per carton. REPLACED wholesale each
-- run, exactly like edi_fulfillment_pack — a carton whose ASN has since been
-- re-sent must not linger as unannounced.
--
-- Matched rows are kept, not just the failures: the headline is "710/710
-- announced", and that denominator is the evidence the two sides are actually
-- comparable. A findings-only table could only ever say "no problems found",
-- which is what "nobody looked" also looks like.
CREATE TABLE IF NOT EXISTS asn_carton_check (
  sscc         TEXT,                  -- NULL only for the blank_sscc finding
  finding      TEXT NOT NULL,         -- matched | undeclared | phantom | blank_sscc | duplicated
  if_number    TEXT,                  -- NULL for phantom (NetSuite has no carton)
  po_dc        TEXT,
  declared_on  TEXT[],                -- ASN business numbers; >1 means re-declared
  checked_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asn_carton_check_finding ON asn_carton_check(finding);

-- One row per run, kept as history. Answers "is it getting worse?", which a
-- replaced findings table alone cannot, and carries the run-level context the
-- findings have no column for (how many POs were in scope, how many ASNs were
-- undelivered and therefore announced nothing).
CREATE TABLE IF NOT EXISTS asn_carton_run (
  id                 SERIAL PRIMARY KEY,
  ran_at             TIMESTAMPTZ DEFAULT now(),
  status             TEXT,            -- ok | undeclared | phantom | no_asn | empty | error
  pos                INTEGER,         -- POs in scope AFTER closure over the ASNs
  pos_requested      INTEGER,         -- before closure; the gap is the co-listed POs
  docs_delivered     INTEGER,
  docs_undelivered   INTEGER,         -- announced nothing, by definition
  fulfillments       INTEGER,
  shipped            INTEGER,
  message_errors     INTEGER,
  counts             JSONB,           -- checkAsnCartons().counts verbatim
  error              TEXT             -- set when the run could not complete
);
-- Which claim a run is making. A 60-day window finding nothing does NOT mean the
-- whole history is clean, so the UI has to be able to say which it is showing.
-- Added after the table existed, so it has to be an ALTER: CREATE TABLE IF NOT
-- EXISTS is a no-op once the table is in Neon (see the note at the top of this
-- file) and silently ignores a changed column list.
ALTER TABLE asn_carton_run ADD COLUMN IF NOT EXISTS scope TEXT;
