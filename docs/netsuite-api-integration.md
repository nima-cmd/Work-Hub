# NetSuite live ingest (SuiteQL / TBA) — design + setup

Goal: replace the manual CSV-export workflow with a **read-only** live pull from
NetSuite, so the app is never blind to work that closes between uploads. The CSV
import stays as an always-available **fallback** — both paths feed the same
`loadToDb`, so nothing downstream changes.

> **Why this is safe.** We only run **SuiteQL `SELECT`** queries from an
> *external* client (no SuiteScript deployed inside NetSuite). SuiteQL has no
> INSERT/UPDATE/DELETE — it physically cannot modify a transaction, fulfillment,
> invoice, or workflow. On top of that, the token is bound to a **read-only
> role**, so even a bug can't write. The only real considerations are API
> governance (a few scheduled queries/day is trivial) and least-privilege auth.

## Build status (2026-07-29)

- ✅ **`src/ingest/netsuiteApi.js`** — the read-only SuiteQL client is built and
  unit-tested (`test/netsuiteApi.test.js`, 8 tests): OAuth 1.0a TBA HMAC-SHA256
  signing (signature-base construction verified against a hand-computed vector),
  account→host/realm normalisation, RFC-3986 encoding, limit/offset pagination,
  401→`needsAuth`, and **soft-disable** when the `NS_*` env vars are absent. No
  live call happens until the creds land — safe to merge now.
- ⏳ **Next (needs the creds, or MCP column-proofing first):** the SuiteQL query
  strings + row→record mappers for SOs / IFs / invoices (matching the CSV
  mappers' output shape so `buildPipeline`/`loadToDb` are untouched), the
  `syncFromNetsuite()` orchestration + cron, and the freshness banner. The SO
  *header* fields are proven; the extra joins (line-level location/qty, the DC /
  store / ATS custom fields, the linked-invoice sub-fields) should each be proven
  via a SuiteQL query before mapping — I didn't want to guess column names blind.
- ⏳ **`closed / Fully-Billed = done + credit`** pipeline rule — pairs with the SO
  pull; deferred so the shipped-$ credit logic is verified against real data
  rather than built blind.

## Architecture

```
NetSuite ──SuiteQL REST (TBA, read-only)──▶ src/ingest/netsuiteApi.js
   (live)                                        │  maps rows → SAME record shape
                                                 │  the CSV mappers produce
                                                 ▼
                                     buildPipeline → loadToDb (unchanged)
                                                 ▲
   manual CSV upload ──importer.js──────────────┘  (fallback, unchanged)
```

- **Primary:** a scheduled job (cron, like the Orderful one) calls
  `syncFromNetsuite()` → pulls open + recently-closed transactions → maps → runs
  the existing transactional load. On failure it **logs and keeps the last data**
  (never wipes), and records the failure so the UI can warn.
- **Fallback:** the existing Import button stays exactly as-is. Manual CSV upload
  and the live pull write to the same tables; last-write-wins per natural key.
- **Freshness:** every sync (api or csv) records `source` + success time
  (reuse `import_snapshots`). A banner shows "Last NetSuite sync: N ago (live |
  manual)" and warns past a threshold — so a silent failure is visible.

## Auth (Token-Based Authentication, OAuth 1.0a HMAC-SHA256)

Endpoint: `POST https://<ACCOUNT>.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`
(the `<ACCOUNT>` in the host + the OAuth `realm` use the account id **uppercased,
hyphen→underscore**, e.g. `1234567_SB1` for a sandbox).

Env vars (git-ignored `.env.local`; if ANY are missing → live pull disabled,
CSV-only, soft, exactly like the Google integrations):

```
NS_ACCOUNT_ID=
NS_CONSUMER_KEY=
NS_CONSUMER_SECRET=
NS_TOKEN_ID=
NS_TOKEN_SECRET=
```

## Queries (proven live 2026-07-29 via the MCP)

Each returns rows mapped into the **same shape** as the matching CSV mapper, so
`buildPipeline`/`loadToDb` are untouched.

- **Sales orders** — open + recently closed in one query (the whole point):
  `WHERE type='SalesOrd' AND lastmodifieddate >= (today - N days)`.
  Fields confirmed available: `tranid`, `BUILTIN.DF(entity)` (customer),
  `BUILTIN.DF(status)` + raw `status` code (B=Pending Fulfillment,
  F=Pending Billing, …), `trandate`, `shipdate`, `foreigntotal`,
  `lastmodifieddate`. (Location lives on `transactionLine`, joined separately.)
- **Item fulfillments** — `type='ItemShip'`, carrying `shipstatus`
  (A picked / B packed / C shipped) + ship date; linked to the SO via
  `PreviousTransactionLineLink` (`createdfrom` is not directly queryable).
- **Invoices** — `type='CustInvc'`, status (Open / Paid In Full), amount.
- Later phases: PO receiving, OC pipeline, EDI packages, ShipCentral queue,
  catalogue — each a SuiteQL analogue of its saved search.

## The fix this unlocks (the reason we're doing it)

Because the SO query includes **recently-closed** orders, the app finally sees an
order reach its terminal state instead of it silently dropping off the open
export. That means:
- `pruneOrders` stops hard-deleting orders that merely closed — they're captured,
  marked done, and their shipped-$ credited (the `SHIPPED_VALUE` ledger stamp).
- Boutique orders whose Item Fulfillment never flips to "Shipped" in NetSuite
  (stays `Packed`) are recognised as done via their **invoice / Fully-Billed**
  state, so they leave the "Waiting to Ship / Packed" queue and get credited.

## SuiteQL gotchas (all measured live 2026-07-30 — don't relearn these)

- **`totalResults` is NOT a row count.** It came back as exactly `pageSize × 1000`
  (3000 at pageSize 3, 5000 at pageSize 5) while `SELECT COUNT(*)` said **5,926**.
  The client never surfaces it; pagination terminates on `hasMore`, and it returns
  `truncated:true` if it stopped at `maxPages` while more remained (so a partial
  pull can't masquerade as a complete one). Use `COUNT(*)` for real totals.
- **`transaction.shipstatus` 500s** ("unexpected error"). Use `transaction.status`
  instead — for `ItemShip` the codes are **A = Picked, B = Packed, C = Shipped**
  (live counts: 112 / 9 / 5,808).
- **`item` needs Lists → Items**, otherwise the error is the misleading
  `Record 'item' was not found` (it exists; the role just can't see it).
- **Missing transaction permissions return an EMPTY SET, not an error** — see the
  role note above. Never treat "no error" as "no data".
- `createdfrom` isn't directly queryable — join `PreviousTransactionLineLink`
  (`previousdoc` → `nextdoc`).
- SO header fields confirmed: `tranid`, `BUILTIN.DF(entity)` = customer,
  `status` + code (B Pending Fulfillment, F Pending Billing, G Billed),
  `trandate`, `shipdate`, `foreigntotal`, `lastmodifieddate`, **`otherrefnum` =
  the PO/Check Number**. Line-level `location`/`quantity` come from
  `transactionline` (filter `mainline='F'`).

## Inventory (proven live 2026-07-30)

Nima wants stock in the app too. The table is **`inventoryitemlocations`** joined
to `item` — NOT `inventorybalance` (that name doesn't exist and 404s):

```sql
SELECT i.itemid, i.itemtype,
       iil.quantityonhand, iil.quantityavailable,
       iil.quantitycommitted, iil.quantitybackordered,
       BUILTIN.DF(iil.location) AS location
FROM item i JOIN inventoryitemlocations iil ON iil.item = i.id
WHERE iil.quantityonhand > 0
```

1,946 item/location rows with stock across **12 locations** (~31.3k units):
Virtual Warehouse (955 SKUs / 16,693), Warehouse (462 / 7,569, 5,465 avail),
China (217 / 2,401), Bloomingdale's (23 / 2,307, only 1,025 avail), Offsite
Storage, Nordstrom (17 / 728, only **5** avail — heavily committed), Damages
(0 avail), Consignment, Office, Shopbop, Sample Sale, WIP. These map onto the
channel split in the locations memory, so per-location availability is the
interesting cut (committed vs available per channel), not just a flat total.

`quantitycommitted`/`quantitybackordered` are sometimes null — coalesce to 0.

## Phasing

1. **Order lifecycle** — SOs + IFs + invoices (incl. recently-closed) + the
   closed/invoiced = done + credit rule + the freshness banner. Fixes the actual
   pain (SO12288 / SO12293 class).
2. **Everything else** — PO receiving, OC pipeline, EDI packages, ShipCentral,
   catalogue via SuiteQL.
- CSV remains the fallback throughout.

---

## Admin checklist — create the read-only integration (gets me the 5 env values)

An admin does this once in NetSuite. **Give the token a read-only role.**

1. **Enable features:** Setup → Company → Enable Features → **SuiteCloud** tab →
   check **REST Web Services** and **Token-Based Authentication** (and
   **SuiteAnalytics Workbook** if not already on). Save.
2. **Create the Integration record:** Setup → Integration → Manage Integrations →
   **New**. Name `Work-Hub Read-Only`, State **Enabled**, check **Token-Based
   Authentication**.
   **⚠️ Uncheck `AUTHORIZATION CODE GRANT`** (under the OAuth 2.0 section — it's
   checked by DEFAULT). It's an OAuth 2.0 flow that requires a Redirect URI, so
   leaving it on fails the save with **"Invalid Redirect URI"** (hit 2026-07-30).
   We use OAuth 1.0a TBA, not OAuth 2.0. Also leave **TBA: Authorization Flow**,
   **TBA: IssueToken Endpoint** (we mint the token in the UI), **User
   Credentials**, and every OAuth-2.0 **SCOPE** box unchecked — with TBA, access
   comes from the ROLE's permissions (step 3), not from scopes.
   Save → copy **Consumer Key** + **Consumer Secret** (shown only once) →
   `NS_CONSUMER_KEY`, `NS_CONSUMER_SECRET`.
3. **Read-only role:** Setup → Users/Roles → Manage Roles → **New** (or reuse the
   existing bot role if it's already view-only). Permissions — **View only, no
   create/edit/full anywhere**:
   - **Transactions:** Find Transaction *(critical — SuiteQL transaction access
     hinges on it)*, Sales Order, Item Fulfillment, Invoice, Purchase Order
   - **Lists:** Customers, **Items** *(inventory)*, **Locations** *(location
     names)*, Vendors
   - **Reports:** SuiteAnalytics Workbook
   - **Setup:** Log in using Access Tokens, REST Web Services

   ⚠️ **A missing permission is SILENT.** A role without transaction access gets
   an **empty result set**, not an error (hit live 2026-07-30: customers returned
   715 rows while every transaction query returned 0). Missing item access shows
   as `Record 'item' was not found`. `npm run check:netsuite` now treats an empty
   transaction read as a failure for exactly this reason. Also confirm the role
   isn't subsidiary-restricted.
4. **Assign the role** to a user (a dedicated integration user is ideal).
5. **Create the Access Token:** Setup → Users/Roles → Access Tokens → **New** →
   pick Application = `Work-Hub Read-Only`, the User, the Role → Save → copy
   **Token ID** + **Token Secret** (shown only once) → `NS_TOKEN_ID`,
   `NS_TOKEN_SECRET`.
6. **Account id:** Setup → Company → Company Information → **Account ID**
   (e.g. `1234567` or `1234567_SB1`) → `NS_ACCOUNT_ID`.
7. Hand me the 5 values — they go in git-ignored `.env.local`; I never commit
   them.
