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
    field: 'Calendar deadline dots (orders.ship_date + orders.cancel_date)', shape: S.ARITHMETIC.key,
    pr: 148, date: '2026-08-21', status: 'fixed',
    assumed: 'the calendar could plot deadlines from the order: a "Ship due" dot on '
      + 'ship_date and a "Cancel by" dot on cancel_date',
    actually: 'BOTH ARE UNUSABLE. Measured: cancel_date is NULL on all 121 unshipped '
      + 'orders, so that dot could never appear; and ALL 121 ship_dates are the NetSuite '
      + 'trandate+28 default (isDefaultedShipDate true on 121, false on 0), so 81 orders '
      + 'showed a future deadline that was just their creation date plus four weeks. The '
      + 'real dates are orders.window_end/window_start and the partner\'s own '
      + 'edi_transactions.cancel_after',
    cost: 'the whole Calendar view. Nima: "the dots mean nothing to me really and not '
      + 'working" — he was right, and it was not a design problem. PR #94 stopped the '
      + 'pipeline flags trusting ship_date; nothing propagated that to the calendar',
    caught: 'him saying the view was useless, then measuring the columns it plotted '
      + 'rather than redesigning it. ⚠️ A view can be keyed on a field that another '
      + 'surface already stopped trusting — a fix has to be chased across every reader',
  },
  {
    field: 'pipeline.js NEEDS_HANDOFF_SCAN (fulfillments.custody_out only)', shape: S.HAND_SET.key,
    pr: 147, date: '2026-08-21', status: 'fixed',
    assumed: 'a fulfilment with no CUSTODY_OUT scan on its own IF was never handed over',
    actually: 'AN EDI SHIPMENT IS SCANNED ON ITS PER-DC CARGO TAG, NOT ITS IF SLIP — by '
      + 'design. /api/orders read doc_type=IF events only, so none of that evidence ever '
      + 'reached the pipeline. Measured: 54 live flags, 53 of them EDI, and all 5 distinct '
      + 'EDI POs already had their DC tags scanned. Across all fulfilments, 163 of the 211 '
      + 'with no IF scan have a DC scan',
    cost: '54 false flags at severity 1 on the board — the second-largest flag there — each '
      + 'telling him to go print a label and scan out freight that had already gone out on '
      + 'its tag. Now 0, and the zero is honest: 38 fulfilments have no scan of any kind '
      + 'but 35 are already SHIPPED and the branch is gated on stage PICKED',
    caught: 'Nima asked what to build next; measuring the flag before recommending it '
      + 'showed 53 of 54 in one lane. ⚠️ THE FIX ALREADY EXISTED — scanGap.js learned this '
      + 'in PR #74 (28 of 28 false, identical cause) and its header says so in full; '
      + 'pipeline.js simply never got it. Look for the rule before writing one',
  },
  {
    field: 'pipeline.js daysBetween() applied to fulfillments.if_date (a DATE)', shape: S.MISLABELLED.key,
    pr: 147, date: '2026-08-21', status: 'fixed',
    assumed: 'daysBetween(if_date, today) counts whole days, so ">= 1" excludes today',
    actually: 'node-pg returns a Postgres DATE as UTC MIDNIGHT, and daysBetween compares '
      + 'LOCAL midnights (setHours(0,0,0,0)). West of UTC that shifts the date back a day: '
      + 'proved in America/Los_Angeles that a DATE of TODAY measures as 1 day old',
    cost: 'NEEDS_HANDOFF_SCAN fired on SAME-DAY fulfilments despite its ">= 1 day" guard — '
      + 'chasing a slip that was printed an hour ago. Now compared as ISO day strings, '
      + 'which is what scanGap.js already did for exactly this reason',
    caught: 'the second reported symptom of the flag above. ⚠️ The test suite is only green '
      + 'in America/* zones — main fails 1 in UTC and 16 in Asia/Tokyo, unrelated to this '
      + 'and unfixed. The new tests here pass in all six zones checked',
  },
  {
    field: 'baseMap Almanac count (orders.cancel_date)', shape: S.UNREACHABLE.key,
    pr: 145, date: '2026-08-21', status: 'fixed',
    assumed: 'orders carry a cancel date, so "cancel dates inside a week" could be the '
      + 'Almanac building\'s number',
    actually: 'cancel_date is NULL on ALL 121 unshipped orders. The counter could never '
      + 'fire — it read 0 and would have read 0 forever, which is indistinguishable from '
      + 'a genuinely clear week. The real ship window is `window_end` (NetSuite\'s '
      + '`enddate`, ingested in PR #118), populated on 43 of them',
    cost: 'none — caught before merge by asking whether a zero was real, which is the '
      + 'only question that separates this shape from good news. The EDI lane does rank '
      + 'on a partner cancel-after, but that lives in shipWindow/ediWindow, not in this '
      + 'column',
    caught: 'refusing to accept a 0. A counter reading zero on live data is either the '
      + 'happy path or structurally dead, and the two look identical on screen',
  },
  {
    field: 'baseMap pack-house AND launch-pad counts (work-in-progress including shipped freight)', shape: S.MISLABELLED.key,
    pr: 143, date: '2026-08-21', status: 'fixed',
    assumed: 'an open custody tag means the goods are still out of our hands — so it '
      + 'could headline the pack house as "out on the floor, not back"',
    actually: 'the tag is paperwork and it outlives the shipment. Measured on live data '
      + 'before this shipped: 14 fulfilments had custodyOut with no custodyIn and ALL 14 '
      + 'had already SHIPPED (IF7447 scanned out 31 Jul, shipped 5 Aug). Genuinely still '
      + 'on the floor: zero. The counter was describing departed freight',
    cost: 'none — caught before merge, by reading the work list the count opened into and '
      + 'noticing every row said "Shipped". The count is now out-and-not-back-AND-NOT-'
      + 'SHIPPED, and the 14 are surfaced separately as "custody tags never closed", '
      + 'which is what they are',
    caught: 'building the view against live data instead of fixtures. 14 of 14 being one '
      + 'thing is the tell — a finding that is 100% one lane is a rule bug, not a data '
      + 'finding (same lesson as PR #74 and PR #127). ⚠️ THEN THE SAME MISTAKE APPEARED '
      + 'AGAIN sixty lines down: the launch pad counted 44 "cleared, waiting on the truck" '
      + 'of which only 8 had not shipped — the other 36 left weeks ago (oldest 71 days) '
      + 'and merely predate the confirm button, which has only existed since 2026-08-13. '
      + 'Twice in one file, so there is now a test asserting NO building headlines a count '
      + 'that includes shipped freight',
  },
  {
    field: "health.js INTEGRATIONS 'Database (Neon)' label", shape: S.MISLABELLED.key,
    pr: 141, date: '2026-08-20', status: 'fixed',
    assumed: 'the name of the database could be written into the string that names it',
    actually: 'it is a LITERAL, so it cannot follow a migration. The app moved to '
      + 'DigitalOcean on 2026-08-18 and this row went on saying "Database (Neon)" — while '
      + 'the transfer panel three inches below it correctly read "DigitalOcean — not '
      + 'metered", because THAT title is derived from hostKind(). Now filled in from the '
      + 'same derived DB_TARGET',
    cost: 'none measured — but it is the FOURTH site of a bug the cutover already produced '
      + 'three of (check:neon said "UP NEON" against DO, check:transfer headlined a cap '
      + 'that does not exist, migrate announced it was altering NEON). Three were found by '
      + 'deriving the target; this one survived because nobody re-read the connections list',
    caught: 'reading a screenshot taken for something else entirely, and noticing the two '
      + 'halves of one page disagreed about which database they were describing',
  },
  {
    field: "order_events IF_CREATED (\"Fulfilment created\", derived from fulfillments.if_date)",
    shape: S.MISLABELLED.key,
    pr: 138, date: '2026-08-20', status: 'open',
    assumed: 'if_date is when the fulfilment was created, so it can date the IF_CREATED event — the '
      + 'first thing on every order\'s timeline',
    // ⚠️ NOT a defect in the COLUMN. Nima already ruled on that (see the
    // fulfillments.actual_ship_date entry, 2026-08-14): the IF transaction date IS
    // the ship date, authoritative, and check:fields has recorded the two being
    // identical since PR #102. The column is doing exactly what it should.
    // What nobody had drawn is the CONSEQUENCE for the event named off it: a column
    // that becomes the ship date on shipping cannot also carry a creation date, so
    // the label "Fulfilment created" is describing a different fact from the date
    // beside it. The detector found the equality; it cannot find a LABEL that stops
    // being true — that is shape 2, and shape 2 needs a reader.
    actually: 'NetSuite rewrites the IF transaction date to the ship date when the IF ships — measured '
      + 'if_date = actual_ship_date on 204 of 204 shipped fulfilments and 0 of 76 unshipped. So it is a '
      + 'creation date only while the IF has not shipped, which is the opposite of durable',
    cost: '83 of 280 IF_CREATED events are dated with the SHIP day — those fulfilments read on the '
      + 'Ledger and in the trace as though they were created the day they went out. The other 121 are '
      + 'genuinely earlier only because eventKey dedupe froze the date captured before the rewrite, so '
      + 'the timeline is right by accident of sync ORDER, not because the column means anything. Fixing '
      + 'it needs a real creation date from NetSuite (createddate), which is a sync change, not a relabel',
    caught: 'building the trace header: IF7486\'s header said created 2026-08-17 while its own '
      + 'IF_CREATED event said 2026-08-06. Two dates for one fact on one screen is the whole tell',
  },
  {
    field: 'explainDbError UNREACHABLE pattern', shape: S.PHANTOM_MECHANISM.key,
    pr: 125, date: '2026-08-18', status: 'fixed',
    assumed: 'matching the CLASS of connection failure would cover a Neon suspension',
    actually: 'Neon says "Your project has exceeded the data transfer quota" — which matched NONE of '
      + 'ECONNREFUSED / ENOTFOUND / timeout / connection-terminated. The explainer I wrote the day '
      + 'before specifically for this event did not fire on it',
    cost: 'none, because Neon\'s own wording happened to be clear. But the advice half — run '
      + 'dev:offline — never appeared on the one morning it was written for',
    caught: 'the suspension actually happening, 14 hours after the code shipped',
  },
  {
    field: 'orders.start_date (holds trandate) / transaction.startdate', shape: S.HAND_SET.key,
    pr: 118, date: '2026-08-14', status: 'fixed',
    assumed: 'the boutique ship window was somewhere we had not found — three fields were tested and ruled out',
    actually: 'it is NetSuite\'s `startdate` (plus `enddate` for the far end), and it had never been '
      + 'ingested. Worse, the column named `start_date` holds the TRANSACTION date — the sync mapped '
      + '`row.trandate` into it — which is why the register already showed ship_date = start_date + 28: '
      + 'both are trandate. A field named for the thing we were hunting held something else entirely',
    cost: 'the answer sat unread for 8 days across four sessions while three other fields were tested and '
      + 'rejected. Live effect: PR #94 correctly stopped trusting the +28 date but left '
      + 'AWAITING_SHIP_WINDOW with nothing to key on, so every order waiting for its window read '
      + '"needs a label" — Saint Bernard and Gee Beauty Canada both, until Nima said so',
    caught: 'asking Nima the field ID outright instead of inferring a fourth time',
  },
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
    // ⚠️ CORRECTED 2026-08-14 by Nima: "to get the shipdate we need to simply get the
    // date on the IF transaction when it was shipped as this should always be the
    // ship date." So the two agreeing is the DEFINITION, not a defect — the IF
    // transaction date IS the ship date, and it is authoritative for invoicing and
    // for the calendar. My first framing ("carries no departure evidence") read as a
    // caution against using it, which would have been exactly wrong.
    actually: 'identical to if_date on all 201 shipped fulfilments — because the IF transaction date IS '
      + 'the ship date. Authoritative, not redundant. The only nuance: on the EDI lane marking shipped '
      + 'deliberately fires ahead of the physical pickup to generate the ASN, so it dates the TRANSACTION, '
      + 'not the truck leaving',
    cost: 'none — and the entry as first written was misleading, which is its own lesson: '
      + 'two fields agreeing is not evidence that either is empty',
    caught: 'npm run check:fields on its first run; the MEANING came from asking Nima',
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
