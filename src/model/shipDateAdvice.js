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

// The tightest honest lower bound on departure for one fulfilment.
// Returns null when we hold nothing at all — the caller must then say "no
// evidence", not fall back to today.
export function honestFloor(row = {}) {
  for (const f of FLOORS) {
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

  const driftDays = calendarDays(floor.date, wouldUse)
  const impossible = driftDays < 0
  const crossesMonthClose = !impossible && !sameMonth(floor.date, wouldUse)

  const severity = impossible
    ? SEVERITY.MONTH
    : crossesMonthClose
      ? SEVERITY.MONTH
      : driftDays >= 2
        ? SEVERITY.DRIFT
        : driftDays >= 1
          ? SEVERITY.MINOR
          : SEVERITY.NONE

  return {
    ifNumber: row.ifNumber || null,
    suggestedDate: ymd(floor.date),
    basis: floor.key,
    basisLabel: floor.label,
    strength: floor.strength,
    driftDays,
    crossesMonthClose,
    impossible,
    severity,
    advice: adviceLine({ floor, driftDays, crossesMonthClose, impossible, marked }),
  }
}

function adviceLine({ floor, driftDays, crossesMonthClose, impossible, marked }) {
  const on = ymd(floor.date)
  const was = `${on} (${floor.label})`
  if (impossible) {
    return `Marked ${ymd(marked)} — but it was still ${floor.label} on ${on}. That date cannot be right.`
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
