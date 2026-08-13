// src/model/arithmeticFields.js — is this column just arithmetic on another one?
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// `check:counters` was GREEN throughout both of the 2026-08-13 field bugs
// ([[netsuite-fields-that-lie]]). A distinctness sweep — "does this column have more
// than one value?" — finds the first (`is_ats` was false on all 282 orders) and is
// structurally incapable of finding the second:
//
//   transaction.shipdate had MANY distinct values and looked completely alive. It
//   was `trandate + 28` on 1,234 of 1,254 sales orders (+30 on 18, +29 on 2) — a
//   NetSuite default lead time nobody types. The app read it as a ship window and
//   raised 51 flags off it.
//
// The question that finds it is different: **is this column always another column
// plus a constant?** A column whose value is fully determined by another column is
// DERIVED, not observed — and a derived field cannot be evidence of anything the
// field it derives from does not already say.
//
// ── WHAT COUNTS AS A FINDING ────────────────────────────────────────────────
//
// Not "some rows are N apart" — that happens by coincidence constantly. The claim
// is that a SMALL SET of offsets covers almost every row, which is the fingerprint
// of a formula rather than of observation. Real observed dates scatter; `shipdate`
// took exactly three values across fourteen months.
//
// ⚠️ Two deliberate limits, because a checker that cries wolf gets ignored:
//
//   · A pair needs enough rows to say anything. Three rows 28 days apart is not a
//     pattern, and asserting on it would make the check fail on a quiet table.
//   · An EXACT COPY (offset 0 on every row) is reported as its own kind. It is a
//     real finding — a column that is a duplicate of another can drift and be
//     believed — but it is also the shape of every legitimate `created_at` /
//     `updated_at` pair on a row nobody has touched, so it is never a failure on
//     its own.
//
// This module is pure: the caller supplies the offsets, so the rule can be tested
// without a database and the same rule can be pointed at any pair of columns.

/** Rows below this and a pair is not evidence of anything. */
export const MIN_ROWS = 40
/** A formula's fingerprint: this share of rows on `MAX_OFFSETS` or fewer values. */
export const DOMINANCE = 0.95
export const MAX_OFFSETS = 3

/**
 * @param offsets  numbers — one per row where BOTH columns are non-null (`a - b`,
 *                 in days for dates). Rows where either side is null are the
 *                 caller's to drop: a null is not an offset of zero.
 */
export function analyzeOffsets(offsets = [], opts = {}) {
  const {
    minRows = MIN_ROWS, dominance = DOMINANCE, maxOffsets = MAX_OFFSETS,
    distinctA = null, distinctB = null,
  } = opts
  const rows = offsets.length
  if (rows < minRows) {
    return { verdict: 'too_few', rows, top: [], covered: 0, share: 0 }
  }
  // ⚠️ Subtracting two CONSTANT columns yields a constant, which this rule would
  // otherwise report as a formula. Live example: `ups_shipment_cost.store_id` reads
  // as `insurance_cost + 123781` across all 33,253 rows — and the truth is that
  // insurance_cost is 0 on every row and store_id is one value. That is the SHAPE-1
  // bug (a column with one distinct value, the shape `is_ats` had on all 282 orders),
  // and calling it arithmetic would both mislabel it and bury it. Reported as its
  // own kind so the right question gets asked.
  const deadA = distinctA != null && distinctA <= 1
  const deadB = distinctB != null && distinctB <= 1
  if (deadA || deadB) {
    return { verdict: 'constant', rows, top: [], covered: 0, share: 0, deadA, deadB }
  }
  const counts = new Map()
  for (const o of offsets) counts.set(o, (counts.get(o) || 0) + 1)
  const top = [...counts.entries()]
    .map(([offset, count]) => ({ offset, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, maxOffsets)
  const covered = top.reduce((n, t) => n + t.count, 0)
  const share = covered / rows
  const base = { rows, top, covered, share, distinct: counts.size }

  if (share < dominance) return { ...base, verdict: 'observed' }
  // Every row identical AND the offset is zero: one column is a copy of the other.
  if (counts.size === 1 && top[0].offset === 0) return { ...base, verdict: 'copy' }
  return { ...base, verdict: 'derived' }
}

/** A human sentence for a verdict — the whole value of this check is the wording. */
export function describeFinding({ table, column, basis, unit = 'days', result }) {
  const pct = (result.share * 100).toFixed(1)
  const list = result.top
    .map((t) => `${t.offset >= 0 ? '+' : ''}${t.offset} (${t.count})`)
    .join(' · ')
  if (result.verdict === 'copy') {
    return `${table}.${column} is an exact copy of ${table}.${basis} on all ${result.rows} rows ` +
      `where both are set — one of the two is not independent evidence.`
  }
  return `${table}.${column} is ${table}.${basis} plus a constant on ${pct}% of ${result.rows} rows ` +
    `(${unit}: ${list}). A column determined by another column is DERIVED, not observed — ` +
    `anything reading it as evidence is really reading ${basis}.`
}

/**
 * Pairs worth sweeping, given a table's columns. Ordered pairs (a, b) meaning
 * "is a derived from b" — both directions, since `a = b + 28` and `b = a - 28` are
 * the same fact but only one of them names the field a human would go and fix.
 * Deduped to one direction per pair; the caller reports the offset's sign.
 */
export function columnPairs(columns = []) {
  const out = []
  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) out.push([columns[i], columns[j]])
  }
  return out
}

/**
 * Pairs this sweep deliberately does not report, with the reason.
 *
 * ⚠️ An allowlist is where a checker goes to die, so the bar is: the pair is
 * derived BY DESIGN, that design is written down, and nothing reads the derived
 * column as independent evidence. Anything else stays noisy on purpose.
 */
// ⚠️ HONESTY ABOUT WHAT THIS CHECK CAN CLAIM.
//
// The hope was "a finding here is a bug, not noise". That holds for DATES and does
// not hold for numbers. Swept live on 2026-08-13 the rule produced nine findings, of
// which one was the known bug, one was a genuine new observation, and the rest were
// ordinary business facts — `purchase_orders.qty_ordered = qty_remaining` on 96% of
// lines simply means most open POs have received nothing yet. A check that fails on
// those would be red forever and would therefore be ignored, which is how a green
// check earns the right to be believed.
//
// So the assertion is not "no findings". It is **no CHANGE to this list**: every
// finding on live data today is recorded here with a verdict, and a new one means a
// column started being determined by another column, which is exactly the event that
// preceded `transaction.shipdate` driving 51 flags.
export const EXPECTED_DERIVED = [
  {
    table: 'orders', column: 'ship_date', basis: 'start_date', kind: 'derived',
    // The reason this whole module exists. Already gated at the one place the SO date
    // enters shipWindow (PR #94), so it is a recorded fact rather than a discovery —
    // but it must keep being REPORTED, because the day it stops being derived is the
    // day someone started typing real ship windows, which is news of the good kind.
    why: 'NetSuite default lead time (+28) — gated in pipeline.js since PR #94; the settling experiment is still open',
  },
  {
    table: 'fulfillments', column: 'if_date', basis: 'actual_ship_date', kind: 'copy',
    // Found by this sweep, 2026-08-13. On all 190 fulfilments carrying both, the two
    // are IDENTICAL, and there is no row with an actual_ship_date and no if_date.
    // Consistent with what Nima has already said about this lane: marking shipped is
    // a keystroke that generates the ASN ahead of the pickup, not an observation of
    // departure. So the PRESENCE of actual_ship_date is a signal; its VALUE is just
    // the IF date and is not independent evidence of when anything moved.
    why: 'marking shipped is one keystroke — the value carries no departure evidence beyond if_date',
  },
  {
    table: 'ups_shipment_cost', column: 'ship_date', basis: 'create_date', kind: 'derived',
    why: 'ShipStation billing records: a label ships the day it is bought or the next (0/+1 on 33,253 rows)',
  },
  {
    table: 'purchase_orders', column: 'qty_ordered', basis: 'qty_remaining', kind: 'derived',
    why: 'not a formula — 1,355 of 1,415 open PO lines have received nothing, so remaining equals ordered',
  },
  {
    table: 'asn_carton_run', column: 'pos', basis: 'pos_requested', kind: 'derived',
    why: 'run log: the check scopes a couple of extra POs over the ones requested',
  },
  {
    table: 'asn_carton_run', column: 'fulfillments', basis: 'shipped', kind: 'derived',
    why: 'run log: nearly every fulfilment in scope is a shipped one',
  },
]

// Columns holding exactly ONE distinct value — the `is_ats` shape (false on all 282
// orders, so the whole ATS/non-ATS split had never fired once). All three below are
// benign today and each says so; a NEW one is the thing to look at.
export const EXPECTED_CONSTANT = [
  { table: 'ups_shipment_cost', column: 'insurance_cost', why: 'we never declare value on these labels — always 0' },
  { table: 'asn_carton_run', column: 'message_errors', why: 'no ASN run has errored yet — a counter that has never fired' },
  { table: 'edi_asn_harvest', column: 'packs_without_sscc', why: 'every harvested pack has had an SSCC — never fired' },
]

export function isExpected(table, column, basis) {
  return EXPECTED_DERIVED.find(
    (e) => e.table === table && ((e.column === column && e.basis === basis) || (e.column === basis && e.basis === column)),
  ) || null
}

export function isExpectedConstant(table, column) {
  return EXPECTED_CONSTANT.find((e) => e.table === table && e.column === column) || null
}

/** Findings not on the recorded baseline — the only thing worth failing on. */
export function unrecorded({ findings = [], constantFindings = [] } = {}) {
  return {
    derived: findings.filter((f) => !isExpected(f.table, f.column, f.basis)),
    constant: constantFindings.filter((c) => !isExpectedConstant(c.table, c.column)),
  }
}

/** Baseline entries the sweep NO LONGER finds — a field that stopped being derived. */
export function vanished({ findings = [], constantFindings = [] } = {}) {
  const seen = new Set(findings.map((f) => `${f.table}.${f.column}|${f.basis}`)
    .concat(findings.map((f) => `${f.table}.${f.basis}|${f.column}`)))
  const seenConst = new Set(constantFindings.map((c) => `${c.table}.${c.column}`))
  return {
    derived: EXPECTED_DERIVED.filter((e) => !seen.has(`${e.table}.${e.column}|${e.basis}`)),
    constant: EXPECTED_CONSTANT.filter((e) => !seenConst.has(`${e.table}.${e.column}`)),
  }
}
