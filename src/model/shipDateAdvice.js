// src/model/shipDateAdvice.js — which date to type when you mark an IF shipped.
//
// Nima's step 6, and the one that costs real money: accounting closes the month,
// and a shipment marked days late books its revenue in the wrong period. He has
// had to go back and re-date shipments he marked late. Measured 2026-07-31 across
// the six shipped IFs that carry a custody scan: five were marked AFTER the goods
// were already in his hands — IF7287 by 10 days — and one (IF7190) was marked two
// days BEFORE, which is not late but impossible.
//
// ── What counts as evidence, and what only looks like it ─────────────────────
//
// The app does NOT hold a true "it left the building" timestamp. Two things that
// appear to be one are not:
//
//   • DEPARTED is derived FROM fulfillments.actual_ship_date
//     (src/model/orderEvents.js). It is a mirror of the very field we are trying
//     to check, so it can never disagree with it. Zero information.
//   • Label creation is unavailable for these shipments. ups_shipment_cost holds
//     33,253 harvested labels but ZERO of their tracking numbers appear on any
//     fulfilment — those are ecom labels on the 18GE01 account, and NetSuite IFs
//     live in no ShipStation store at all.
//
// What is left is the custody scan, which is a physical act someone performed:
//
//   • CUSTODY_IN  — back from the warehouse, packed, in your hands. The goods
//     cannot have shipped before this, so it is the tightest honest FLOOR.
//   • CUSTODY_OUT — handed TO the warehouse to be packed. A weaker floor: it
//     precedes packing, so the true departure is later by however long packing
//     took. Using it overstates drift, which is why IF7404 reads +6 days against
//     CUSTODY_OUT but only +2 against CUSTODY_IN. Only used when there is no IN.
//   • the IF date — weakest of all, and not a custody fact. Last resort.
//
// So this module deliberately does NOT claim to know the departure date. It
// returns a FLOOR plus what that floor is evidence of, which is enough to answer
// the question that actually costs money — "does this belong in last month?" —
// without inventing a day. Same discipline as the ledger's honest-timestamp rule:
// no honest date, no confident answer.

const DAY = 86_400_000

// Whole calendar days between two dates, insensitive to the time of day and to
// DST (comparing UTC-normalised calendar components, not elapsed milliseconds).
export function calendarDays(from, to) {
  const a = asDate(from)
  const b = asDate(to)
  if (!a || !b) return null
  return Math.round((utcMidnight(b) - utcMidnight(a)) / DAY)
}

function asDate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// Postgres hands a `date` column back as LOCAL midnight, so the calendar date is
// the local one. Re-project it onto UTC midnight for arithmetic.
function utcMidnight(d) {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

// 'YYYY-MM-DD' from the LOCAL calendar date — never toISOString(), which shifts
// the day for any server whose local midnight falls on the other side of UTC.
export function ymd(v) {
  const d = asDate(v)
  if (!d) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const sameMonth = (a, b) => {
  const x = asDate(a)
  const y = asDate(b)
  return !!x && !!y && x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
}

// The floors we accept, strongest first. `label` is what the UI says out loud —
// it must describe the EVIDENCE, not assert a departure, so a reader is never
// misled into thinking we watched the truck leave.
export const FLOORS = [
  { key: 'CUSTODY_IN', field: 'custodyIn', strength: 'scan', label: 'back in your hands, packed' },
  { key: 'CUSTODY_OUT', field: 'custodyOut', strength: 'scan', label: 'handed to the warehouse' },
  { key: 'IF_DATE', field: 'ifDate', strength: 'weak', label: 'fulfilment created' },
]

// ── The EDI lane is a different animal, and measuring it like boutique lies ───
//
// An EDI shipment is never scanned per fulfilment. The cargo tag is per PO-DC
// (`DC:<po>:<abbrev>`), and one tag covers several IFs — measured 2026-08-03:
// median 3, max 10, only 16 of 39 scanned keys are 1:1. So a fulfilment's
// custody evidence is its DC's, not its own, and `custodyIn` is null for all 50
// shipped EDI IFs.
//
// The trap is what happens next. CUSTODY_IN means different things in the two
// lanes:
//   • boutique — back in your hands, about to go out the door. A TIGHT floor.
//   • EDI      — packed, now waiting days for the retailer's authorized truck.
//
// Measured on those 50: the cartons were scanned in 2026-07-22, the routing
// authorization (auth 55753138, 8 BOLs) set pickup for 07-29, and the IFs were
// marked shipped 07-30. Treating the scan as a tight floor reports every one of
// them as "7 days adrift" — 47 flags against ZERO real problems (0 month
// crossings, 0 impossible dates, and all 15 cargo tags shipped on ONE date,
// which is a truck, not sloppy dating). That gap is DWELL, not drift.
//
// So for EDI the physical floor is still the DC scan (goods cannot ship before
// they are packed — that is what catches an impossible date), but the date you
// should actually type is the routing authorization's pickup date. It is a PLAN
// rather than proof of departure, so it is labelled as such and never presented
// as a fact we observed — same discipline as the rest of this module.
export const EDI_FLOORS = [
  { key: 'DC_CUSTODY_IN', field: 'dcCustodyIn', strength: 'scan', label: 'cargo tag scanned back in' },
  { key: 'DC_CUSTODY_OUT', field: 'dcCustodyOut', strength: 'scan', label: 'cargo tag handed to the warehouse' },
  { key: 'IF_DATE', field: 'ifDate', strength: 'weak', label: 'fulfilment created' },
]

// The authorized pickup date, which is the EDI lane's answer to "what date do I
// type". Strength 'plan' because the retailer scheduled it; we did not watch it.
export const ROUTING_BASIS = {
  key: 'ROUTING_AUTH', field: 'routingShipDate', strength: 'plan',
  label: 'the routing authorization\'s pickup date',
}

// The tightest honest lower bound on departure for one fulfilment.
// Returns null when we hold nothing at all — the caller must then say "no
// evidence", not fall back to today.
//
// `row.edi` switches to the per-DC chain. Boutique rows are untouched, so a
// caller that never sets it behaves exactly as before.
export function honestFloor(row = {}) {
  for (const f of row.edi ? EDI_FLOORS : FLOORS) {
    const date = asDate(row[f.field])
    if (date) return { key: f.key, date, strength: f.strength, label: f.label }
  }
  return null
}

// Severity, in the order Nima cares about:
//   3 — the floor is in an earlier month than the date you are about to type.
//       Marking it today books it in the wrong accounting period. THE expensive
//       one, and the reason this list is ranked at all.
//   2 — same month, but ≥2 days of drift. Wrong day, right month: cheap to fix
//       now, annoying later.
//   1 — a day or less. Normal.
//   0 — nothing to say.
export const SEVERITY = { MONTH: 3, DRIFT: 2, MINOR: 1, NONE: 0 }

// Advice for ONE fulfilment.
//
// `markedDate` is optional: pass it for an IF that is already marked shipped and
// this audits the date that was used (drift measured against the mark, and
// `impossible` when the mark predates the floor). Omit it for an IF still waiting
// to be marked and drift is measured against today — what you would type if you
// typed the default.
export function shipDateAdvice(row = {}, { today = new Date() } = {}) {
  const floor = honestFloor(row)
  const marked = asDate(row.markedDate ?? null)
  // The date the books would get if nobody intervened.
  const wouldUse = marked || asDate(today)

  if (!floor) {
    return {
      ifNumber: row.ifNumber || null,
      suggestedDate: null,
      basis: null,
      basisLabel: 'no custody scan — nothing here can date this shipment',
      strength: 'none',
      driftDays: null,
      crossesMonthClose: false,
      impossible: false,
      severity: SEVERITY.NONE,
      advice: 'No scan on record, so the app cannot tell you a date. Use what you know.',
    }
  }

  // On the EDI lane the date to type is the authorized pickup, not the packing
  // scan. Falls back to the physical floor when no authorization is on file.
  const auth = row.edi ? asDate(row[ROUTING_BASIS.field]) : null
  const basis = auth ? { ...ROUTING_BASIS, date: auth } : floor

  // `impossible` ALWAYS measures against the physical floor: the goods cannot
  // have left before they were packed, whatever the paperwork scheduled. Marking
  // a shipment earlier than its authorized pickup is merely early, not a lie.
  const impossible = calendarDays(floor.date, wouldUse) < 0

  // Drift is measured against the basis — the date we are telling you to use.
  const driftDays = calendarDays(basis.date, wouldUse)
  const crossesMonthClose = !impossible && !sameMonth(basis.date, wouldUse)

  // An EDI shipment with no authorization on file: the gap between packing and
  // the retailer's truck is expected DWELL, and reporting it as drift produced
  // 47 phantom flags against 0 real problems (see the EDI_FLOORS note above).
  // A month crossing or an impossible date still counts — those are real
  // whatever the lane.
  const dwellOnly = !!row.edi && !auth

  const severity = impossible || crossesMonthClose
    ? SEVERITY.MONTH
    : dwellOnly
      ? SEVERITY.NONE
      : driftDays >= 2
        ? SEVERITY.DRIFT
        : driftDays >= 1
          ? SEVERITY.MINOR
          : SEVERITY.NONE

  return {
    ifNumber: row.ifNumber || null,
    suggestedDate: ymd(basis.date),
    basis: basis.key,
    basisLabel: basis.label,
    strength: basis.strength,
    driftDays,
    crossesMonthClose,
    impossible,
    severity,
    dwellOnly,
    advice: adviceLine({ floor: basis, driftDays, crossesMonthClose, impossible, marked, dwellOnly }),
  }
}

function adviceLine({ floor, driftDays, crossesMonthClose, impossible, marked, dwellOnly }) {
  const on = ymd(floor.date)
  const was = `${on} (${floor.label})`
  if (impossible) {
    return `Marked ${ymd(marked)} — but it was still ${floor.label} on ${on}. That date cannot be right.`
  }
  // Say why we are NOT giving a date rather than going quiet: an EDI carton sits
  // between packing and the retailer's truck, so the packing scan is a floor, not
  // a suggestion. Volunteering it would name a date days before the truck came.
  if (dwellOnly && !crossesMonthClose) {
    return `Packed ${on} (${floor.label}); it then waits for the retailer's truck, so this cannot date the departure. Use the routing authorization.`
  }
  if (crossesMonthClose) {
    const verb = marked ? 'It was marked' : 'Marking it today puts it'
    return `Use ${was}. ${verb} in a later month — this is the drift that lands in the wrong close.`
  }
  if (driftDays >= 2) {
    return `Use ${was} — ${driftDays} days before ${marked ? 'the date used' : 'today'}, same month.`
  }
  if (driftDays >= 1) return `Use ${was} — a day out.`
  return `Today matches the scan (${was}).`
}

// Rank a list so the month-close cases are unmissable: severity first, then the
// largest drift, then the oldest floor. Pure — returns a new array.
export function rankShipDateAdvice(items = []) {
  return [...items].sort((a, b) => {
    const sa = a.advice?.severity ?? a.severity ?? 0
    const sb = b.advice?.severity ?? b.severity ?? 0
    if (sa !== sb) return sb - sa
    const da = a.advice?.driftDays ?? a.driftDays ?? 0
    const db = b.advice?.driftDays ?? b.driftDays ?? 0
    if (da !== db) return db - da
    return String(a.advice?.suggestedDate ?? a.suggestedDate ?? '')
      .localeCompare(String(b.advice?.suggestedDate ?? b.suggestedDate ?? ''))
  })
}

// How many of a ranked list are the expensive kind — the number worth putting on
// a chip.
export function monthCloseCount(items = []) {
  return items.filter((i) => (i.advice?.crossesMonthClose ?? i.crossesMonthClose) ||
                             (i.advice?.impossible ?? i.impossible)).length
}

// ── The retro half of step 6: shipments ALREADY marked ───────────────────────
//
// Everything above answers "what date should I type". This answers the other
// half: "were the dates I already typed right?" Nima's ask (2026-08-03) was
// precise — something he can IGNORE so it never nags, but go back and fix little
// by little. That is exactly filing's due/backlog split (src/model/filing.js),
// but the axis is different and the difference is load-bearing.
//
// Filing splits on an EPOCH: before the app recorded it, nothing is knowable.
// The equivalent epoch here would be the first custody scan (2026-07-17) — but
// measured live, every auditable row falls AFTER it, so an epoch split would put
// all of them in `due` and nag, which is the opposite of what was asked.
//
// The honest axis is THE ACTION, which is the never-lump rule's own criterion
// ([[work-hub-court-strip]]):
//   • forward — the IF is still Packed. Typing the right date is a keystroke.
//   • retro   — the IF is on the books. Changing it is an accounting correction.
// Same evidence, same arithmetic, different court and different cost. So these
// are returned as their OWN list and their count never joins `monthClose` nor
// reaches a court-strip chip.
//
// ── What can honestly be audited, and what only looks auditable ──────────────
//
// Measured live 2026-08-03 over all 91 shipped fulfilments:
//   • 36 hold nothing but the IF date. IF_DATE is not a custody fact — it is the
//     weakest last resort — and NetSuite's ship date is routinely copied FROM the
//     IF date, so auditing one against the other is close to auditing a value
//     against itself. Excluded, and split by the custody epoch (2026-07-17): 26
//     shipped before scanning existed and can never be checked by anyone, the
//     other 10 shipped after and were simply never scanned.
//   • 55 carry real evidence (49 ROUTING_AUTH, 6 CUSTODY_IN). Of those: ZERO
//     crossed a month close, 1 is impossible (IF7190, marked 2 days before the
//     goods came back), 4 drifted ≥2 days inside one month.
//
// That 0 is the point of the surface. It is a SCOREBOARD for step 6 before it is
// a to-do list — the good news made visible — and it gets more informative every
// day the custody feed runs, since today it can only see back to 07-17.
export const AUDITABLE_BASES = ['CUSTODY_IN', 'CUSTODY_OUT', 'DC_CUSTODY_IN', 'DC_CUSTODY_OUT', 'ROUTING_AUTH']

// Rows are the shape shipDateAdvice takes, plus `markedDate` (required — an
// unmarked shipment belongs to the forward list, not here).
//
// `custodyEpoch` is the date of the earliest custody scan on record. It splits
// the UNCHECKABLE rows into two very different things, which is worth the extra
// argument: a shipment that left before scanning existed can never be checked by
// anyone, while one that left after and still has no scan is a gap in scanning
// today. Collapsing them into a single "no evidence" number would let the second
// hide inside the first. Omit it and everything uncheckable is reported as
// `unscanned`, which overstates the live gap rather than understating it.
//
// Returns the rows worth a second look, the reasons rows were excluded, and
// nothing that resembles an obligation. `minSeverity` defaults to DRIFT: a mark
// a day off its scan is normal handling, not an error to chase.
export function auditMarkedShipments(
  rows = [],
  { today = new Date(), minSeverity = SEVERITY.DRIFT, custodyEpoch = null } = {},
) {
  const epoch = asDate(custodyEpoch)
  let preCustody = 0
  let unscanned = 0
  const items = []

  for (const row of rows) {
    const marked = asDate(row.markedDate)
    if (!marked) continue
    const advice = shipDateAdvice(row, { today })
    // No basis at all, or nothing better than the fulfilment date — either way
    // there is no independent evidence to audit the mark against.
    if (!advice.basis || !AUDITABLE_BASES.includes(advice.basis)) {
      if (epoch && marked.getTime() < epoch.getTime()) preCustody += 1
      else unscanned += 1
      continue
    }
    if (advice.severity < minSeverity) continue
    items.push({ ...row, advice })
  }

  const ranked = rankShipDateAdvice(items)
  return {
    items: ranked,
    counts: {
      // The expensive kind: booked into the wrong accounting period.
      monthClose: ranked.filter((i) => i.advice.crossesMonthClose).length,
      // Marked before the goods physically existed to ship. Not "negative
      // drift" — a date that cannot be true (see IF7190).
      impossible: ranked.filter((i) => i.advice.impossible).length,
      // Wrong day, right month. Cheap, and the whole reason this list is
      // collapsed rather than loud.
      drift: ranked.filter((i) => !i.advice.crossesMonthClose && !i.advice.impossible).length,
      total: ranked.length,
      // The surface's OWN blind spots, stated rather than implied — a clean list
      // must not be allowed to read as "the whole history is clean".
      preCustody, // shipped before scanning existed: uncheckable by anyone, ever
      unscanned,  // shipped since, and still never scanned: a gap in scanning now
    },
  }
}
