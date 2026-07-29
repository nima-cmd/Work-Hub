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
   Authentication**, uncheck the user-credential/authorization-flow options.
   Save → copy **Consumer Key** + **Consumer Secret** (shown only once) →
   `NS_CONSUMER_KEY`, `NS_CONSUMER_SECRET`.
3. **Read-only role:** Setup → Users/Roles → Manage Roles → **New** (or reuse the
   existing bot role if it's already view-only). Permissions — **View only**:
   Transactions → Find Transaction, Sales Order, Item Fulfillment, Invoice;
   Lists → Customers; Reports → SuiteAnalytics Workbook; Setup → **Log in using
   Access Tokens** + **REST Web Services**. **No** create/edit/full permissions.
4. **Assign the role** to a user (a dedicated integration user is ideal).
5. **Create the Access Token:** Setup → Users/Roles → Access Tokens → **New** →
   pick Application = `Work-Hub Read-Only`, the User, the Role → Save → copy
   **Token ID** + **Token Secret** (shown only once) → `NS_TOKEN_ID`,
   `NS_TOKEN_SECRET`.
6. **Account id:** Setup → Company → Company Information → **Account ID**
   (e.g. `1234567` or `1234567_SB1`) → `NS_ACCOUNT_ID`.
7. Hand me the 5 values — they go in git-ignored `.env.local`; I never commit
   them.
