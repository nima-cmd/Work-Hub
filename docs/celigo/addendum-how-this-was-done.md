# Addendum — how this work was done, and where to look for our mistakes

## Who did what

The analysis, the diagnosis and the drafted change were produced by **Claude (Anthropic's
AI assistant)**, working from the raw 850, the Orderful API, read-only NetSuite queries,
and screenshots of the Celigo UI. **Nima Erfani reviewed every step and applied every
change.** No AI had write access to Celigo or to NetSuite:

- **Celigo** — the AI cannot reach it at all. Every mapping, every import and the script
  edit were done by hand in the UI. The AI supplied the two-line diff and the reasoning;
  Nima typed it.
- **NetSuite** — the AI's connection is read-only in practice and by policy (the internal
  standard is that it is for design and verification only). Across this work it issued
  **only** `SELECT` queries and record reads. **No record was created, updated or deleted
  through it.** Every import was run by Nima from the CSV import UI.
- **The patched script was not retyped.** It was generated from the original by scripted
  text substitution, each edit asserted to match exactly once, then both versions were
  run against the real Orderful payload for PO 50220600 and compared before anything was
  applied. `diff` between them is two lines.

## Where we got things wrong

Listed because knowing the failure pattern is more useful than knowing the fix. Four of
these were the AI's, and each cost an import cycle.

1. **Store number written 4-digit instead of 3.** The 850 transmits `0378`; the AI stored
   that verbatim in `custentity_store_number`. Celigo searches the *stripped* form. The
   question was never "what does the partner send" but "what must NetSuite hold so the
   middleware finds it", and the 102 pre-existing Nordstrom records had that answer the
   whole time. Caught by Celigo's own error. **Corrected by a second import.**

2. **Addresses omitted entirely.** The AI ran a join through `customerAddressbook`, got
   zero rows, and concluded a Nordstrom store carries no address of its own — so the
   store import created none. Wrong: `customer.defaultshippingaddress` was populated, and
   it was visible in a record dump the AI had already read and not followed up. Celigo
   requires `isdefaultshipping`. **Cost two further imports.**

3. **The parent reference format was guessed twice** — first an internal id, then
   `fullname` — before being settled by a deliberate 3-row probe import carrying one
   candidate format each. Both wrong guesses rejected **every** row, so there was no
   partial state to unpick, but two import cycles were spent.

4. **Default billing initially set to F.** The reasoning was right about the content
   (Nordstrom AP, not the store) but the flow requires a default billing address to exist
   at all, so another pass was needed.

The common thread in 1 and 2: trusting a derived answer over a field that was already in
view. That is worth knowing because it is the shape to look for if anything else here
turns out wrong.

## Things to keep an eye on

Ordered by how much they would matter if wrong.

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

2. **The AP billing address copied from one record to 326 — now VERIFIED.**
   `Accounts Payable / Nordstrom / P.O. Box 870 / Seattle WA 98111` was read off store
   220 and written to every Rack customer as default billing. Each Nordstrom store holds
   its own copy (the internal ids are all distinct), so it could in principle have
   differed store to store. Checked against **425 Valley Fair** (DC 499) and **730
   Houston Galleria** (DC 799) — both byte-identical to 220, across three different DCs.
   Treated as confirmed rather than assumed.

3. **30 of the 68 four-digit Rack stores were silently mis-routing before today.** The
   fix prevents it; it repairs nothing. See section 8 of the main notice.

4. **A production sales order was deleted** — SO12563, created against
   `Nordstrom - 760 - Perimeter Mall` for freight belonging to 7760 Pompano Citi Centere
   Rack. Deleted by Nima. It was Pending Fulfillment and nothing had shipped.

5. **Store 167 exists because of an experiment.** It was created by the 3-row probe used
   to determine the parent-reference format. It is a store that was wanted anyway and its
   fields are now identical to the other 325, but it was created as a test rather than as
   part of the intended import.

6. **The 26 Rack stores opening Fall 2026 / Fall 2027 were created ACTIVE** (Nima's
   call, made explicitly). They cannot receive anything yet but appear in every customer
   lookup and report. `2281 Hunter's Square Rack` is the Fall 2027 one Nordstrom queried.

7. **Store 675 Metro Center Rack** — Nordstrom writes its city as `Washington D.C.` with
   no two-letter state. Handled as a named exception (`Washington` / `DC`) rather than by
   loosening the parsing rule, so any other malformed row would still have been rejected.
   Worth an eyeball.

8. **Address 1's `Attention` / `Addressee`** were written by the first import as the
   composed name (`Nordstrom - 003 - Southcenter Square Rack`) and corrected in the final
   pass to `Store # 003` / `Southcenter Square Rack`, matching store 220's pattern. These
   two lines print on a freight label, so worth confirming on a couple of records.

9. **Rack records have TWO addresses; full-line stores have THREE.** Confirmed on 425:
   `Billing` (default billing) / `Store` (default shipping) / `Distribution Center` (no
   default flag). The Rack records lack the third. Nothing in this flow tests it and the
   same DC address already lives in the `DC Address` custom fields on every Rack record —
   but the records are not yet identical in shape to the ones that work.

10. **Two NetSuite `Request Limit Exceeded` errors** appeared during the run and
   auto-resolved. Not caused by the change; noted in case the retry volume is relevant.

11. **Two stale `09/01` error records** still carry pre-fix retry data (`742`, `768`) and
    are duplicates of SO12571 and SO12573. They should be resolved as superseded rather
    than retried — a retry replays the saved post-script payload, so the fix does not
    apply to them.

## What was deliberately not done

- **Nothing was written to `custbody_po_cd_identifier`**, the field the ASN is generated
  from. A separate change in the Work-Hub app reads a fallback for its own display only,
  never writes NetSuite, and flags rather than hides a missing value.
- **`EDI Store Number` was left blank** on all 326 Rack records rather than populated by
  copying the pattern from the full-line records, because on those it holds a *different
  store's* number and nobody could explain why. See section 8 item 3 of the main notice.
- **The Celigo change was kept to two lines** rather than rewritten, so the behaviour
  delta is enumerable by inspection instead of requiring trust.

## Reproducing the analysis

The pre-change and post-change scripts, the raw 850, the real Orderful payload, every
import CSV, and a script that runs both script versions against that payload are
committed together with the full reasoning. Ask Nima for the `docs/celigo/` folder if you
want to re-derive any of it rather than take this notice on faith.
