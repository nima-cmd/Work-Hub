# NetSuite print templates (mirrored here so a change is revertible)

NetSuite's Advanced PDF editor keeps its own version history — the **Template
Version** dropdown, e.g. `477 (Current)`. That is a real safety net and it stays
the fastest way to roll back. But it is an opaque list of numbers: it cannot tell
you *what* changed or *why*, and it cannot be diffed. So the code lives here too.

**One template in NetSuite, not two.** We deliberately did NOT "Save As" a second
template: that would mean repointing the transaction form and then maintaining
two templates that can silently drift apart. The old version is preserved as a
file here instead.

## Which template this is

| | |
|---|---|
| Template | `Naghedi \| Fulfillment/Packing Slip PDF/HTML Template` |
| Printed by | transaction form **`NAGHEDI \| Item Fulfillment`**, internal ID **200** |
| Scope | **every** item fulfilment — EDI *and* boutique. 5,931 of them, one form, no exceptions |
| Renderer | BFO (`report-1.1.dtd`), which is what supports `<barcode>` |

Because it is the one template for everything, a layout change has to be checked
against **both** an EDI fulfilment (the `DC:` code renders, header is crowded) and
a boutique one (that cell is empty). Everything on the slip is there for the
warehouse — the 26pt `DC:` code tells a picker where goods belong — so nothing
existing may be displaced.

## Files

- **`fulfillment-packing-slip.v477-BASELINE.xml`** — version 477, exactly as it
  was before any change. **This is the revert point.** Do not edit it.
- **`fulfillment-packing-slip.WITH-QR.xml`** — baseline + a scannable QR. Paste
  this into the template's Source Code view.

Verified mechanically: reversing the two edits below turns `WITH-QR` back into
`BASELINE` byte-for-byte. Nothing else was touched.

## What WITH-QR changes (only two things)

1. **Restores the missing `nlfooter` macro.** `<body>` has referenced
   `footer="nlfooter"` all along, but the macro was absent from `<macrolist>` —
   so every slip reserved 20pt of blank space and rendered nothing, and the
   `table.footer td` / `td.barcode` CSS rules sat there styling nothing. Those
   orphans are the fingerprint of the barcode that used to be on this slip.
2. **`footer-height="20pt"` → `"72pt"`.** 20pt could never hold a scannable code.

Two things the restored footer deliberately does differently from the original:

- **QR, not Code128.** The warehouse iMac's scanner reads `qr_code` only
  (`BarcodeDetector` + a jsQR fallback, `client/src/views/ScanBay.jsx`). The
  original linear barcode would print perfectly and never scan — the worst
  failure mode, because it looks like it works.
- **Value is `${record.tranid}` and nothing else.** Work-Hub matches the IF
  number exactly, so `IF #7440` or `7440` would silently resolve to nothing.

It also brings back `Page X of Y`, which a multi-page pick slip had no way to
show — useful for spotting a missing page.

### Why the value stays channel-agnostic

Tempting to emit `DC:<po>:<dc>` for EDI, since Work-Hub's cargo tags already use
that format. Don't. It would bake channel logic into a print template and depend
on `custbody_if_dc_code`'s text matching the DC abbreviations our parser expects.

The app can work it out itself: `fulfillment_dc` holds one row per IF with its PO
and DC, and contains **only** EDI fulfilments (2,246 rows, every one with a DC,
boutique absent). So presence in that table *is* the channel test. The template
states one plain fact — which fulfilment this is — and the app interprets it.

## Cost, stated honestly

A 72pt footer is ~0.7in less body space per page, so a slip that just fits on one
page today may spill to two. Multi-page already works (the header repeats). This
is the same trade the template's original author accepted when the barcode was
there.

## To revert

Either select an earlier **Template Version** in NetSuite, or paste
`fulfillment-packing-slip.v477-BASELINE.xml` back into Source Code and save.
Nothing else in NetSuite needs touching — form 200 keeps pointing at the same
template either way.

## Before trusting the QR

1. **Preview** (don't Save) after pasting. If `codetype="qrcode"` renders nothing
   or errors, try `codetype="qr"` — BFO and NetSuite's docs disagree on the
   spelling, and Preview settles it in seconds.
2. Preview an **EDI** fulfilment and a **boutique** one. If the EDI header
   crowds, raise `header-height` from `21%` to about `24%`.
3. Preview renders with **placeholder data** (`12345678901234567890`, "Lorem
   ipsum"), so the QR there encodes a placeholder. Preview proves it *draws*, not
   that it is *correct*.
4. Print a real fulfilment and confirm the QR decodes to exactly its IF number.

## What still needs app-side work before document filing works

Custody scanning at the desk works as soon as the template is saved — an `IF…`
payload is already handled (`recordCustodyScan`). Scan→Drive filing needs two
changes first:

1. `segmentPages` (`client/src/lib/scanPipeline.js`) starts a new document on
   **every** QR page. The footer repeats the QR on every page, so a 3-page slip
   would file as 3 documents. A repeated identical QR must read as a continuation.
2. `classify()` (`server/scanFiling.js`) knows `DC:<po>:<abbrev>` and bare POs; an
   `IF…` payload currently falls through to `boutique`. It should resolve through
   `fulfillment_dc` so EDI slips reach `BOLs/<partner>/<PO>/`.

⚠️ `fulfillment_dc` is filled incrementally by the scheduled sync, which really
fires roughly every 90 minutes — so a fulfilment printed and scanned immediately
may not be resolvable yet and would look boutique. Press **↻ Refresh NetSuite**
after creating fulfilments, or add a live lookup fallback.
