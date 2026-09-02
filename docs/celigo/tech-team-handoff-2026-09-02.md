# Celigo change notice — Nordstrom 850 store-code truncation

**Changed by:** Nima Erfani · **Date:** 2026-09-02 · **Environment:** production
**Flow:** *Orderful Purchase Orders to NetSuite (850) — with closing revised "old" orders* (EDI / Nordstrom)
**Script:** `HB - EDI - Nordstrom's 850s` (previously last modified 2025-10-14)
**Scope of code change:** 2 lines, 1 script. Nothing else in the flow was touched.

---

## 1. Summary

Nordstrom Rack purchase orders could not create sales orders. The script that flattens an
850's SDQ segments into one record per store was truncating every 4-character store code
to its last 3 characters. For Nordstrom full-line stores that was harmless; for Nordstrom
Rack it was not, and in one case it created a sales order **against the wrong customer**.

Two lines were changed to make the truncation conditional. The fix is verified on live
data: PO 50220600 now produces 10 sales orders totalling 95 units, reconciling
store-for-store and unit-for-unit against Nordstrom's own SDQ segments.

## 2. What was wrong

`getStores()` and `splitByStore()` each contained:

```javascript
if (code.length === 4) { code = code.slice(1, 4); }
```

`slice(1, 4)` on a 4-character string drops the first character.

**This was correct when written.** Nordstrom transmits store codes zero-padded to four,
and every Nordstrom store in NetSuite is a 3-digit number — 363 of them still are. So
dropping the first character was always equivalent to stripping the pad, for eleven
months.

**Nordstrom Rack broke that assumption.** 68 Rack store numbers are four real digits.

| 850 transmits | script produced | result |
|---|---|---|
| `0378` | `378` | correct — the first character happened to be the pad |
| `7742` | `742` | no such store → `VALUE_LOOKUP_FAILED` |
| `7768` | `768` | no such store → `VALUE_LOOKUP_FAILED` |
| `7760` | `760` | **`Nordstrom - 760 - Perimeter Mall` exists → sales order created against the wrong store** |

That last row is the important one. A 10-store PO produced 9 errors; the tenth did not
succeed, it silently created **SO12563** against a full-line store for freight belonging
to 7760 Pompano Citi Centere Rack. **An error was the safe outcome here; a match was the
dangerous one.** SO12563 has been deleted.

## 3. Evidence that the truncation was Celigo-side

Checked at each hop before changing anything:

| Hop | Store codes present | Source |
|---|---|---|
| Nordstrom's raw X12 | `0167` `0378` `7742` `7760` `7768` only. `378`/`742`/`768`/`760`: **0 occurrences** | the `.x12` file |
| Orderful's parsed JSON | 4-character only. Every truncated form: **0 occurrences** | pulled from the Orderful API, transaction `1026744798` |
| Celigo's NetSuite lookup | searched `378`, `742`, `768` | the flow's own error records |

A value absent from every input and present in the search was constructed in between.
The error's Retry-data pane names `orderfulID 1026744798` / PO `50220600` — the same
transaction inspected upstream, so this is not a comparison of two transmissions.

NetSuite is excluded structurally: the filter string appears inside Celigo's own error
message, i.e. composed before NetSuite was called. NetSuite never receives `0378`.

## 4. The change

```diff
  // getStores → addResult          (line 304)
- if (code.length === 4) {
+ if (code.length === 4 && code.charAt(0) === '0') {
      code = code.slice(1, 4);
  }

  // splitByStore                    (line 344)
- if (store.length === 4) {
+ if (store.length === 4 && store.charAt(0) === '0') {
      store = store.slice(1, 4);
  }
```

Nothing removed; the `length === 4` trigger is unchanged. It now also requires the first
character to be a zero.

**Both sites were required.** Patching only `getStores` leaves a 4-character code for
`splitByStore` to truncate; the second block was dormant only because the first had
already shortened the string.

### Behaviour delta — complete

| Input | Before | After | Changed |
|---|---|---|---|
| any 4-char starting `0` (`0004`, `0167`, `0378`) | pad stripped | pad stripped | **no** |
| 3-character codes | untouched | untouched | **no** |
| 2-character codes (`SC`, `JP`, `CG`) | untouched | untouched | **no** |
| **`7742`, `7760`, `2281`, `1003`** | first char dropped | preserved | **YES** |
| `SDF4` (4-char, non-numeric) | `DF4` | `SDF4` | **YES** |

**Only 4-character codes not beginning with `0` behave differently.** Every code that
resolved correctly before produces a byte-identical result.

## 5. Verification

Both script versions were run against the real Orderful payload for PO 50220600 before
the change was applied:

```
ORIGINAL getStores → 167, 351, 363, 370, 371, 372, 378, 742, 760, 768
PATCHED  getStores → 167, 351, 363, 370, 371, 372, 378, 7742, 7760, 7768
```

Both produce 10 orders and 95 units; only the three four-digit codes differ.

**Confirmed in production after the change** — 10 sales orders, each on the correct Rack
store, units matching the 850's SDQ:

| SO | Store | Units | 850 says |
|---|---|---|---|
| SO12566 | 167 Cerritos Plaza Rack | 10 | 10 |
| SO12569 | 351 Beverly Connection Rack | 9 | 9 |
| SO12570 | 363 Plaza Bonita Rack | 8 | 8 |
| SO12567 | 370 South Bay Marketplace Rack | 7 | 7 |
| SO12568 | 371 The Shops at Summerlin Rack | 8 | 8 |
| SO12565 | 372 Esplanade Shopping Center Rack | 12 | 12 |
| SO12574 | 378 Mission Valley Rack | 9 | 9 |
| SO12571 | **7742** The Plaza at Citrus Park Rack | 9 | 9 |
| SO12572 | **7760** Pompano Citi Centere Rack | 12 | 12 |
| SO12573 | **7768** Lake Nona West Rack | 11 | 11 |

**Total 95 units.** SO12572 is the case that previously landed on Perimeter Mall.

## 6. Rollback

The script is a **pure transform** — no state, no migration, and it writes nothing itself.
Reverting is restoring the previous script text.

The pre-change script is attached, and is also committed with the full analysis at
`docs/celigo/nordstrom-850-preSavePage.ORIGINAL-2026-09-01.js`.

Sales orders created under the patched version are ordinary sales orders and are
unaffected by a revert; a revert only restores the old truncation for later runs.

## 7. NetSuite data changes made the same day (not code)

These were prerequisites — the Rack stores did not exist in NetSuite at all:

- **326 customers created** — all 325 Nordstrom Rack stores plus **297 CS Rack Warehouse**
  (confirmed in writing by Nordstrom: *"297 is our warehouse"*, ships to 299 Central
  States DC). Previously **zero** Rack stores existed, which is why Rack 850s had nothing
  to resolve against.
- Parented to their DC, `custentity_store_number` = the store number (3-character
  minimum), matching all 363 pre-existing Nordstrom stores.
- **Two addresses each**: the store's own street address as **default shipping**, and
  Nordstrom AP (`Accounts Payable / Nordstrom / P.O. Box 870 / Seattle WA 98111`) as
  **default billing**. Celigo's *Create Sales Order* step requires both
  `isdefaultshipping` and `isdefaultbilling` to resolve. The AP address was read off store
  220 and **verified identical on 425 Valley Fair (DC 499) and 730 Houston Galleria
  (DC 799)** before being relied on.
- ⚠️ **No tax registrations were created** — see item 1 below.
- External ID convention (new; all 102 pre-existing Nordstrom records have it empty):
  `NORDRACK-<3-digit store>`.

## 8. Open items for the team

1. **⚠️ THE 326 RACK CUSTOMERS HAVE NO TAX EXEMPTION CERTIFICATE. 104 of the 105
   full-line stores do.** The exemption lives on a custom record,
   **`STE Tax Exemption Certificate`** (`customrecord_ste_exemption_certificate`) — not
   on the customer. Nordstrom's follow one uniform shape:

   | | |
   |---|---|
   | Certificate Number | `Nordstrom Exempt - <3-digit store>` |
   | State | the store's own state |
   | Valid from | `1/1/2023` |
   | Valid until | blank — no expiry |
   | Blanket Exemption | `T` |

   The `customerTaxRegistration` sublist is also empty on the Rack records (149 rows
   across the 105 full-line stores, 0 across the 326).

   ⚠️ **Sales tax may be computed on invoices to Rack stores that should be exempt.**
   Nothing in the EDI flow tests either record, so this cannot raise an error — it
   surfaces as money on an invoice.

   **This has happened before, and the fix is known.** Every taxed full-line order is
   dated **4/3/2026**; the certificates were created **4/7/2026**; no full-line order
   since has carried tax. So the certificate is demonstrably what suppresses it — a
   before/after in production, not an inference. In April nine of the ten taxed orders
   were left `Closed` and never invoiced, so the tax never reached Nordstrom — **except
   `SO11640` (store 584), which was `Billed` with `$1,505.46` of tax across 2 invoices
   and should be checked.**

   **A file for the 326 certificates is prepared.** It asserts no document: Nordstrom's
   certificates are an internal label (`Nordstrom Exempt - <store>`), unlike other
   customers on this record type who carry real state numbers (`85-0727470`,
   `STS-16225339-05`) with real expiry dates. `1/1/2023` with no expiry is used to match
   the existing 104 — and a wide window is the safer choice, since SuiteTax tests whether
   the window covers the transaction date. Still needs a tax owner to confirm that
   Nordstrom's blanket resale exemption extends to the Rack stores.

   ⚠️ **This will recur for every new store.** 26 of the 326 do not open until Fall
   2026/2027, and Nordstrom keeps opening them — this PO's own header reads
   `RACK NEW STORE`. Nothing prompts the creation of a certificate and nothing errors
   when one is missing, so the durable fix is a new-store checklist (customer → parent DC
   → 3-digit store number → two addresses → tax registration → exemption certificate),
   not this import. April was full-line; today was Rack. It is already the second time.

2. **Does `HB - Orderful - 850` contain the same `slice(1, 4)`?** If it serves
   Bloomingdale's or ShopBop it needs the same guard. The guard is safe for their codes
   (`SC` is 2 characters; `SDF4` does not start with `0`) — but the flow list should be
   checked rather than assumed. **This was not verified.**
3. **Is `HB - EDI - Nordstrom's 850s` used by any flow other than this one?** Also not
   verified.
4. **`custentity_hb_edi_store_number` is fed from the same `store` field** (mapping:
   `store` → *EDI Store Number*). If the truncation ran for eleven months, that field has
   been recording truncated codes throughout — which would explain records such as
   `Nordstrom - 220 - Michigan Avenue` holding `0334` (334 is Colonies Crossroads **Rack**,
   a different store). Worth deciding whether it should hold the raw transmitted code.
5. **Historical exposure.** 30 of the 68 four-digit Rack stores truncate onto a customer
   that exists, so they never errored — they would have created orders against the wrong
   store, as 7760 did. The fix **prevents** this going forward; it does not repair past
   occurrences. Recent Rack orders are worth a scan for orders sitting on full-line
   stores. Examples of the collision: `7760`→`760` Perimeter Mall · `1003`→`003`
   Southcenter Square Rack · `5524`→`524` Roosevelt Field · `6601`→`601` Wexner Companies.
6. **A more durable design:** point the customer lookup at `custentity_hb_edi_store_number`
   holding the raw 4-character code, making it an exact match with no string manipulation
   anywhere. More work; the guard is sufficient in the meantime.

## 9. Two stale error records

Two `09/01` errors still carry pre-fix retry data (`742`, `768`) and are duplicates of
SO12571 and SO12573. They should be marked resolved as superseded rather than retried —
a retry replays the saved post-script payload, so the fix would not apply to them.
