// src/model/fieldAssumptions.js — the register of fields that did not mean what we
// thought they meant.
//
// ── WHY THIS IS NOT A BUG TRACKER ───────────────────────────────────────────
//
// Nima asked for a bug tracker seeded with the 2026-08-13 findings. A general bug
// tracker would be the wrong container, and the memory written that day says why:
//
//   "That is the class the bug tracker should be designed to hold — not 'bugs'
//    generally, but 'we assumed this field means X.'"
//
// Every serious defect this app has shipped has been one of those. Not a crash, not
// a typo — a field that was present, populated, plausible, and meant something other
// than what the code read it as. `transaction.shipdate` had a value on 1,254 sales
// orders and was a default lead time. `is_ats` was false on all 282 orders. Both
// looked healthy on every screen.
//
// The register exists because these recur BY FIELD, not by feature: the same
// `packed_status` produced two unrelated bugs six weeks apart, in two different
// surfaces, and the second was found from scratch because nobody had written down
// what the first taught. So this is keyed on the FIELD, and it is history that does
// not get re-derived.
//
// ── WHY A CODE MODULE AND NOT A TABLE ───────────────────────────────────────
//
// ⚠️ Deliberately not a table, for the reason the Macy's routing ingest deliberately
// had no table: a second copy is a thing that can disagree. Every entry here cites a
// file, a shape and a PR, and several are ASSERTED mechanically (see `check`
// below) — so the record lives next to the code it describes and moves with it.
// A row in Postgres describing `pipeline.js` would go stale the first time
// pipeline.js was refactored and nothing would notice.
//
// What a table WOULD be right for is Nima's own "these two orders look wrong",
// which is how both 2026-08-13 bugs were found. That is an inbox, not a register,
// and it is a separate thing from this.

// The shapes. The first four are CLAUDE.md's original list; 5–7 were added on
// 2026-08-13 when three more turned up in one day.
export const SHAPES = {
  UNREACHABLE: {
    key: 'unreachable',
    label: 'Structurally unreachable',
    blurb: 'A branch that cannot ever be true, so the number is a constant pretending to be a measurement.',
    mechanical: true,
  },
  MISLABELLED: {
    key: 'mislabelled',
    label: 'Counts something other than its label',
    blurb: 'The number is real and answers a different question from the one on the screen.',
    mechanical: true,
  },
  HAND_SET: {
    key: 'hand_set',
    label: 'Keyed on a hand-set or display field',
    blurb: 'An objective field existed; the code read one a human maintains, or one built for display.',
    mechanical: false,
  },
  PHANTOM_MECHANISM: {
    key: 'phantom_mechanism',
    label: 'A comment describing a mechanism no code implements',
    blurb: 'The guarantee is in prose. Nothing runs it. Includes correct code nothing calls.',
    mechanical: false,
  },
  ARITHMETIC: {
    key: 'arithmetic',
    label: 'A field that is arithmetic on another field',
    blurb: 'Always another column plus a constant — derived, not observed, so it is not independent evidence.',
    mechanical: true,   // npm run check:fields
  },
  EXISTENCE: {
    key: 'existence',
    label: 'Gated on "does X exist" where existence is not what matters',
    blurb: 'A thing that EXISTS is not necessarily a thing that will be USED, or that is still true.',
    mechanical: false,
  },
  DEFAULT_AS_ANSWER: {
    key: 'default_as_answer',
    label: 'A column default read as an answer',
    blurb: 'NOT NULL with a default means every untouched row asserts something nobody ever said.',
    mechanical: false,
  },
}

const S = SHAPES

/**
 * The register. Ordered newest first, because the recent ones are the ones whose
 * lessons have not been absorbed yet.
 *
 * Every entry answers the same four questions:
 *   assumed  — what the code believed the field meant
 *   actually — what it is
 *   cost     — MEASURED consequence, never "could have been bad"
 *   caught   — how it surfaced, which is the part that generalises
 */
export const ASSUMPTIONS = [
  {
    field: 'routing_shipment.ship_direct / merge_center', shape: S.DEFAULT_AS_ANSWER.key,
    pr: 101, date: '2026-08-13', status: 'fixed',
    assumed: 'a card that does not say otherwise routes through the CA merge center',
    actually: 'both columns had a DEFAULT, so every untouched card asserted a routing nobody had entered',
    cost: 'all 5 shipments authorized for the 2026-08-18 pickup; their BOLs printed Santa Fe Springs CA '
      + 'for freight consigned to Secaucus NJ, City of Industry CA, Stone Mountain GA, China Grove NC and Joppa MD',
    caught: 'asking why a label worksheet was empty — the silence had a cause nobody had asked about',
  },
  {
    field: 'src/model/bolAddresses.js routingShipTo()', shape: S.PHANTOM_MECHANISM.key,
    pr: 101, date: '2026-08-13', status: 'fixed',
    assumed: 'the BOL consigns direct-to-DC shipments to the DC — there was a tested function for it',
    actually: 'nothing in the app ever called it; the BOL called shipToFor(), which had no direct parameter at all',
    cost: 'the same 5 shipments; correct, fully-tested code wired to nothing',
    caught: 'grepping for callers before trusting a function that already existed',
  },
  {
    field: 'fetchRoutingShipmentById (ship_direct not selected)', shape: S.PHANTOM_MECHANISM.key,
    pr: 101, date: '2026-08-13', status: 'fixed',
    assumed: 'fixing the address resolver fixed the BOL',
    actually: 'the by-id query feeding the PDF never selected the column, while the LIST query always had — '
      + 'so the board could show a shipment as direct while its BOL consigned it to the merge center',
    cost: 'the fix changed nothing until this was found; verified only by extracting text from the generated PDF',
    caught: 'reading the produced artifact instead of trusting the layer that was changed',
  },
  {
    field: 'fulfillments.actual_ship_date', shape: S.ARITHMETIC.key,
    pr: 102, date: '2026-08-13', status: 'accepted',
    assumed: 'it records when the goods actually left',
    actually: 'byte-identical to if_date on all 190 rows carrying both, and no row has it without if_date — '
      + 'one keystroke, which on this lane fires ahead of the pickup to generate the ASN',
    cost: 'none found; recorded so nothing starts reading its VALUE as departure evidence',
    caught: 'npm run check:fields, on its first run',
  },
  {
    field: 'shipstationEligibility ALREADY_LABELLED (labelCount > 0)', shape: S.EXISTENCE.key,
    pr: 100, date: '2026-08-13', status: 'fixed',
    assumed: 'a fulfilment that already has a label does not need another one',
    actually: 'a label that EXISTS is not a label that will be USED — NetSuite has no void button, '
      + 'so a wrong unreplaceable label sat there forever with no way to say so',
    cost: 'IF7486 could not be pushed at all; the break-glass button appeared to do nothing',
    caught: 'Nima pressing the button and reporting that nothing happened',
  },
  {
    field: 'macysRouting outOfScope (from applies.length)', shape: S.MISLABELLED.key,
    pr: 96, date: '2026-08-13', status: 'fixed',
    assumed: 'a notification that applied no changes is historical',
    actually: 'it counted CHANGES, not MATCHES — so a notification matching 7 cards that all held a '
      + 'conflicting auth called itself historical and printed none of the 7 conflicts',
    cost: '7 live conflicts silently skipped, on the run that was meant to surface them',
    caught: 'reading the live run output rather than the test output',
  },
  {
    field: 'routing_shipment.ship_date', shape: S.HAND_SET.key,
    pr: 97, date: '2026-08-13', status: 'fixed',
    assumed: 'the date we think the shipment will leave',
    actually: 'the date the BOL was GENERATED — Routing.jsx seeds it with today() in two places',
    cost: '12 cards whose dates I had protected as "considered", treating an artifact as evidence',
    caught: 'asking Nima what he does when he types it, after a disagreement between two dates',
  },
  {
    field: 'transaction.shipdate', shape: S.ARITHMETIC.key,
    pr: 94, date: '2026-08-13', status: 'fixed',
    assumed: 'the ship window on the sales order',
    actually: 'trandate + 28 on 1,234 of 1,254 SOs (+30 on 18, +29 on 2) — a default lead time nobody enters',
    cost: '51 flags; PACK_NOW 38→0, SO_PAST_CANCEL 10→0, attention 55→31. 60 of 62 boutique invoices carry a wrong one',
    caught: 'Nima: "the only date i see is the date that the order was created"',
  },
  {
    field: 'orders.is_ats', shape: S.UNREACHABLE.key,
    pr: 93, date: '2026-08-13', status: 'fixed',
    assumed: 'ATS vs non-ATS, the split the whole stock-shortage rule rests on',
    actually: 'false on all 282 rows since the CSV retired — nothing selected the field, and buildPipeline '
      + 'defaulted it to false one layer ABOVE the COALESCE meant to protect it',
    cost: 'STOCK_SHORT had never fired once; 30 short orders with no way to tell a real exception from a presold one',
    caught: 'Nima reporting two orders that "looked wrong"',
  },
  // ⚠️ TWO ENTRIES, ONE FIELD, DELIBERATELY NOT MERGED. `packed_status` produced two
  // unrelated bugs in two different surfaces, found on the same day, six weeks after
  // the rework that killed it. Collapsing them into one row would hide the single
  // strongest signal this register can carry: a field that bites twice means the
  // first fix did not generalise. `repeatFields` exists to surface exactly this.
  {
    field: 'fulfillments.packed_status', shape: S.HAND_SET.key,
    pr: 53, date: '2026-08-04', status: 'fixed',
    assumed: 'whether a fulfilment is packed — read by the header credits counter',
    actually: 'a hand-keyed field getLaunchBay was reworked off on 2026-07-17; the rework reached neither copy',
    cost: 'the header read "0 CR WAITING" forever while $7,593.60 sat parked on payment',
    caught: 'a systematic audit of every counter, after two had been wrong the same week',
  },
  {
    field: 'fulfillments.packed_status (via getShipDepartures)', shape: S.HAND_SET.key,
    pr: 54, date: '2026-08-04', status: 'fixed',
    assumed: 'the same field, in a second copy nobody knew was a copy',
    actually: 'the same dead hand-keyed field — an entire nav page was INVERTED',
    cost: 'listed 8 shipments that had already left 6-29 days prior under "can depart today", and hid all 70 still at the dock',
    caught: 'a page and the database disagreeing — when they do, suspect the surface',
  },
  {
    field: 'orders.stage (set only by the retired CSV mappers)', shape: S.UNREACHABLE.key,
    pr: 48, date: '2026-08-04', status: 'fixed',
    assumed: 'orders are promoted past PACKED as they invoice',
    actually: 'on the live sync no order could ever leave PACKED — two Kanban stages were unreachable, 0 of 238 ever',
    cost: 'the strip asked for an invoice that existed and told him not to ship it, about the same 4 shipments',
    caught: 'two chips giving opposite advice about the same orders',
  },
  {
    field: 'channelKey() — a display classifier', shape: S.HAND_SET.key,
    pr: 50, date: '2026-08-04', status: 'fixed',
    assumed: 'safe to decide which orders the day plan considers',
    actually: 'a DISPLAY classifier deciding what work exists; SO12344 was invisible while carrying two sev-3 flags',
    cost: 'the order was absent from the plan entirely',
    caught: 'reconciling a rendered count against a hand measurement — and the page was right the first time',
  },
  {
    field: 'orders line quantities (freight and tax lines)', shape: S.MISLABELLED.key,
    pr: 31, date: '2026-08-02', status: 'fixed',
    assumed: 'every order line is goods',
    actually: 'freight and tax lines were counted as units, so "short N units" was 87% phantom',
    cost: '168 flags collapsed to 11',
    caught: 'the count being implausibly large',
  },
  {
    field: 'edi_transactions.business_number', shape: S.HAND_SET.key,
    pr: 32, date: '2026-08-02', status: 'fixed',
    assumed: 'the PO number',
    actually: 'not always a PO — the join key silently did not join',
    cost: '1,975 ledger events filed under unjoinable keys',
    caught: 'a timeline that was empty for POs that plainly had documents',
  },
]

/** Entries whose shape a script can catch mechanically, and the script that does. */
export const MECHANICAL = {
  unreachable: 'npm run check:counters',
  mislabelled: 'npm run check:counters',
  arithmetic: 'npm run check:fields',
}

export function byShape(entries = ASSUMPTIONS) {
  const out = []
  for (const shape of Object.values(SHAPES)) {
    const items = entries.filter((e) => e.shape === shape.key)
    out.push({ ...shape, count: items.length, items, guard: MECHANICAL[shape.key] || null })
  }
  return out
}

/**
 * The summary the app shows. `unguarded` is the number that matters: shapes no
 * script can catch are the ones that still need a human to ask what a field is
 * keyed on before believing a number that reads it.
 */
export function summarize(entries = ASSUMPTIONS) {
  const shapes = byShape(entries)
  const unguarded = shapes.filter((s) => !s.guard).reduce((n, s) => n + s.count, 0)
  return {
    total: entries.length,
    shapes: shapes.filter((s) => s.count > 0),
    unguarded,
    guarded: entries.length - unguarded,
    open: entries.filter((e) => e.status === 'open').length,
    accepted: entries.filter((e) => e.status === 'accepted').length,
    // The repeat offenders — a field that has produced more than one bug is the
    // strongest signal in here, because it means the first fix did not generalise.
    repeats: repeatFields(entries),
  }
}

export function repeatFields(entries = ASSUMPTIONS) {
  const counts = new Map()
  for (const e of entries) {
    const key = e.field.split(/[ (]/)[0]
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([field, n]) => ({ field, n }))
}
