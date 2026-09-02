# Change record — Celigo 850 store-code truncation

**Raised:** 2026-09-01 · **Applies to:** flow *Orderful Purchase Orders to NetSuite (850) —
with closing revised "old" orders* (EDI / Nordstrom) · **Script:** `HB - EDI - Nordstrom's 850s`
(last updated 2025-10-14, i.e. unchanged for ~11 months before this)

---

## Symptom

Nordstrom Rack PO **50220600** (Orderful transaction `1026744798`) produced **9 lookup errors**
on the *Create Sales Order* step:

```
VALUE_LOOKUP_FAILED — A mapping error occurred. Could not find a match for
[["parent","anyof","1161"],"AND",["custentity_store_number","is","378"]]
for the record type "Customer".
```

The PO covers 10 stores. Nine errored. **The tenth did not succeed — it silently created a
sales order against the wrong customer** (SO12563, `Nordstrom - 760 - Perimeter Mall`, a
full-line store). That order has been deleted.

## Root cause

`HB - EDI - Nordstrom's 850s` truncates every 4-character store code to its **last 3
characters**, in two places:

```javascript
// getStores → addResult
if (code.length === 4) { code = code.slice(1, 4); }

// splitByStore
if (store.length === 4) { store = store.slice(1, 4); }
```

`slice(1, 4)` on a 4-character string drops the first character.

**Why it worked for 11 months:** every Nordstrom store in NetSuite was a 3-digit number, and
Nordstrom transmits store codes zero-padded to 4. Dropping the first character was therefore
always equivalent to stripping the pad. **363 of Nordstrom's stores are still 3-digit.**

**Why it broke:** Nordstrom Rack store numbers go to 4 real digits. **68 of them.** For those,
dropping the first character produces a different number entirely.

| 850 sends | script produces | consequence |
|---|---|---|
| `0378` | `378` | correct (first char happened to be the pad) |
| `7742` | `742` | no such store → lookup error |
| `7768` | `768` | no such store → lookup error |
| `7760` | `760` | **`Nordstrom - 760 - Perimeter Mall` exists → order created against the wrong store** |

## Chain of custody — the truncation is Celigo-side

| Hop | Store codes present | Evidence |
|---|---|---|
| Nordstrom's raw X12 | `0167` `0378` `7742` `7760` `7768` only. `378`/`742`/`768`/`760`: **0 occurrences** | the `.x12` file |
| Orderful's parsed JSON | 4-character only. Every truncated form: **0 occurrences** | fetched from the Orderful API for transaction `1026744798` |
| Celigo's NetSuite lookup | searched `378`, `742`, `768` | the flow's own error records |

A value absent from every input and present in the search was constructed in between.
Corroboration: the error's Retry-data pane names `orderfulID 1026744798` / PO `50220600` — the
same transaction that was inspected upstream. NetSuite is ruled out structurally: the filter
string appears inside Celigo's own error, so it was composed before NetSuite was called.

## The change

Add a guard to both conditions. **Nothing is removed.**

```javascript
// getStores → addResult
if (code.length === 4 && code.charAt(0) === '0') { code = code.slice(1, 4); }

// splitByStore
if (store.length === 4 && store.charAt(0) === '0') { store = store.slice(1, 4); }
```

⚠️ **Both must change together.** Patching only `getStores` leaves a 4-character code for
`splitByStore` to truncate — the second block is dormant today only because the first already
shortened the string.

### Behaviour delta — complete

| Input | Before | After | Changed |
|---|---|---|---|
| `0167`, `0004`, `0378` (any 4-char starting `0`) | strip pad | strip pad | **no** |
| 3-character codes | untouched | untouched | **no** |
| `SC`, `JP`, `CG` (2-char) | untouched | untouched | **no** |
| **`7742`, `7760`, `2281`, `1003`** | first char dropped | preserved | **YES** |
| `SDF4` (4-char, non-numeric) | `DF4` | `SDF4` | **YES** |

Only 4-character codes **not** beginning with `0` behave differently. Everything that resolves
correctly today produces a byte-identical result.

## Risk if not applied

**30 of the 68 four-digit Rack stores truncate onto a customer that already exists**, so they
raise no error — the order is created against the wrong store, as happened with 7760. Examples:

| Rack store | truncates to | lands on |
|---|---|---|
| 7760 Pompano Citi Centere Rack | `760` | Nordstrom - 760 - Perimeter Mall |
| 1003 Tri Cities Center Rack | `003` | Nordstrom - 003 - Southcenter Square Rack |
| 5524 Brunswick Square Rack | `524` | Nordstrom - 524 - Roosevelt Field |
| 6601 Settlers Market Rack | `601` | Wexner Companies: Joseph *(not Nordstrom)* |

The remaining 38 raise a visible lookup error, which is the safe failure.

## Rollback

The script is a **pure transform** — no state, no migration, no data written by the change
itself. Reverting is restoring the previous script text.

1. Before editing, copy the current script from Celigo into a dated file.
2. To revert, paste that text back and save.

Records created by the *patched* version are ordinary sales orders and are unaffected by a
later revert; a revert simply restores the old truncation for subsequent runs.

## Open questions for the technical team

1. **Is `HB - EDI - Nordstrom's 850s` used by any flow besides this one?**
2. **Does `HB - Orderful - 850` contain the same `slice(1, 4)`?** If it serves Bloomingdale's
   or ShopBop, it needs the same guard. (The guard is safe for their codes — `SC` is 2
   characters, `SDF4` does not start with `0` — but the flow list should be checked, not assumed.)
3. **`custentity_hb_edi_store_number` is fed from the same `store` field** (mapping: `store` →
   *EDI Store Number*). If the truncation has been in force for 11 months, that field has been
   recording truncated codes throughout — which would explain records such as
   `Nordstrom - 220 - Michigan Avenue` holding `0334`. Worth deciding whether it should record
   the raw transmitted code instead.
4. **A more durable alternative:** point the lookup at `custentity_hb_edi_store_number`,
   populated with the raw 4-character code on every Nordstrom customer. That makes the lookup an
   exact match with no string manipulation anywhere, so it cannot drift. More work; the guard
   above is sufficient and correct in the meantime.

## Verification after applying

1. In the *Create Sales Order* mapping, check the **Input** pane: `store` should read `7742`,
   not `742`, for the DC-0799 lines.
2. **Retry the 9 error records — do not press Run.** `7760` was never an error; a full re-run
   would recreate the wrong-store order.
3. Confirm each resulting sales order's customer against the 850's own SDQ:

| Mark-for store | Ship-to DC | Expected customer |
|---|---|---|
| 0167 | 0399 | Nordstrom - 167 - Cerritos Plaza Rack |
| 0351 | 0399 | Nordstrom - 351 - Beverly Connection Rack |
| 0363 | 0399 | Nordstrom - 363 - Plaza Bonita Rack |
| 0370 | 0399 | Nordstrom - 370 - South Bay Marketplace Rack |
| 0371 | 0399 | Nordstrom - 371 - The Shops at Summerlin Rack |
| 0372 | 0399 | Nordstrom - 372 - Esplanade Shopping Center Rack |
| 0378 | 0399 | Nordstrom - 378 - Mission Valley Rack |
| 7742 | 0799 | Nordstrom - 7742 - The Plaza at Citrus Park Rack |
| 7760 | 0799 | Nordstrom - 7760 - Pompano Citi Centere Rack |
| 7768 | 0799 | Nordstrom - 7768 - Lake Nona West Rack |

Total should reconcile to **95 units** across 10 stores and 4 SKUs (SN06012LD 26, SN04022LD 32,
SN03014LD 32, SN03012FH 5).

## Related, same day

All 325 Nordstrom Rack stores plus 297 (CS Rack Warehouse) were created in NetSuite —
previously **zero** existed, which is why Rack 850s had nothing to resolve against.
`custentity_store_number` on those records is the store number itself (3-character minimum),
matching all 363 pre-existing Nordstrom stores.

⚠️ Note that creating them **increased** the silent-mis-routing exposure from 25 to 30, because
codes like `1003` and `2224` now truncate onto newly-created Rack records. The store import was
necessary and correct; it does not address this, and makes the guard more urgent, not less.
