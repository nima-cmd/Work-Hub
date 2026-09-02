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

1. **The AP billing address was copied from ONE record to 326.**
   `Accounts Payable / Nordstrom / P.O. Box 870 / Seattle WA 98111` was read off store
   220's address sublist and written to every Rack customer as default billing. Each
   Nordstrom store holds its **own** copy of that address (the internal ids are all
   distinct), so in principle they could differ store to store. Uniformity is the
   reasonable reading for a corporate AP address, **but it is a reading, not a
   verification.** If it is wrong, 326 records have the wrong billing address.

2. **30 of the 68 four-digit Rack stores were silently mis-routing before today.** The
   fix prevents it; it repairs nothing. See section 8 of the main notice.

3. **A production sales order was deleted** — SO12563, created against
   `Nordstrom - 760 - Perimeter Mall` for freight belonging to 7760 Pompano Citi Centere
   Rack. Deleted by Nima. It was Pending Fulfillment and nothing had shipped.

4. **Store 167 exists because of an experiment.** It was created by the 3-row probe used
   to determine the parent-reference format. It is a store that was wanted anyway and its
   fields are now identical to the other 325, but it was created as a test rather than as
   part of the intended import.

5. **The 26 Rack stores opening Fall 2026 / Fall 2027 were created ACTIVE** (Nima's
   call, made explicitly). They cannot receive anything yet but appear in every customer
   lookup and report. `2281 Hunter's Square Rack` is the Fall 2027 one Nordstrom queried.

6. **Store 675 Metro Center Rack** — Nordstrom writes its city as `Washington D.C.` with
   no two-letter state. Handled as a named exception (`Washington` / `DC`) rather than by
   loosening the parsing rule, so any other malformed row would still have been rejected.
   Worth an eyeball.

7. **Address 1's `Attention` / `Addressee`** were written by the first import as the
   composed name (`Nordstrom - 003 - Southcenter Square Rack`) and corrected in the final
   pass to `Store # 003` / `Southcenter Square Rack`, matching store 220's pattern. These
   two lines print on a freight label, so worth confirming on a couple of records.

8. **Rack records have TWO addresses; full-line stores have THREE.** The missing one is
   labelled `Distribution Center` and carries no default flag. Nothing in this flow tests
   it and the same DC address already lives in the `DC Address` custom fields on every
   Rack record — but the records are not yet identical in shape to the 102 that work.

9. **Two NetSuite `Request Limit Exceeded` errors** appeared during the run and
   auto-resolved. Not caused by the change; noted in case the retry volume is relevant.

10. **Two stale `09/01` error records** still carry pre-fix retry data (`742`, `768`) and
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
