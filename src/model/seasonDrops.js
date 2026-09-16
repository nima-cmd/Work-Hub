// src/model/seasonDrops.js — when each season's drops actually go live.
//
// Nima, 2026-09-16: *"every season has two drops and we have a shared calendar letting us
// know the date for those drops"* and *"the season and the calendar will let us know when
// a PO is late since we know when we need it."*
//
// That second sentence is the point of this file. Until now nothing in the app knew when
// a container was NEEDED — only when it was expected. A date you need and a date you
// expect are different facts, and lateness is the gap between them.
//
// ── ⚠️ "TWO DROPS A SEASON" IS TRUE FOR THREE SEASONS AND NOT THE OTHER TWO ───────
//
// Read from the marketing calendar, 2026 (136 events):
//
//     Spring Drop 1 Launch    2026-02-04      Hoilday Launch    2026-10-13   ← [sic]
//     Spring Drop 2 Launch    2026-03-03      Gift Guide Launch 2026-11-05
//     Summer Drop 1 Launch    2026-05-05      Resort Launch     2026-11-10
//     Summer Drop 2 Launch    2026-06-02
//     Fall Drop 1 Launch      2026-08-18
//     Fall Drop 2 Launch      2026-09-08
//
// Spring, Summer and Fall have two. Holiday and Resort have ONE launch each. So the
// drop number is READ FROM THE CALENDAR, never assumed from the season — a model that
// hard-coded two would invent a "Holiday Drop 2" that has no date and no merchandise.
//
// ⚠️ AND THE CALENDAR HAS A TYPO IN A LOAD-BEARING TITLE: "Hoilday Launch". A parser
// keyed on exact spelling drops Holiday entirely, which is the season with 366 items and
// the nearest launch. It is matched leniently and the raw title is kept, because the fix
// belongs in the calendar and this must not wait for it.
//
// ⚠️ PRODUCT LAUNCHES ARE NOT DROPS. "Como Med Launch", "Atlas & Small Caravan Launch",
// "Cartolina Launch", "Charm Launch", "Net Bag Preorder Launch", "Curated Shop Launch"
// are single-style events on their own dates. They matter, and they are NOT one of the
// five seasonal drops — folding them in would give Summer four drops in 2026.

import { SEASONS } from './poSeason.js'

/** A drop event we recognise, or null. Titles come from a human-maintained calendar. */
const DROP_RE = new RegExp(
  // "Spring Drop 1 Launch" / "Summer Drop 2" — the season, "drop", a number.
  `^\\s*(${SEASONS.join('|')})\\s+Drop\\s*(\\d+)`, 'i',
)

// ⚠️ LENIENT ON PURPOSE, and only for the two seasons that have a single launch. It must
// not swallow "Gift Guide Launch" or "Charm Launch", so the season name is required.
// "Hoilday" is the live typo; the transposition is matched rather than corrected.
const SINGLE_RE = /^\s*(Holiday|Hoilday|Resort)\s+Launch/i

const normalizeSeason = (s) => {
  const t = String(s || '').trim().toLowerCase()
  if (t === 'hoilday') return 'Holiday'
  const hit = SEASONS.find((x) => x.toLowerCase() === t)
  return hit || null
}

/**
 * Parse one calendar event into a drop, or null when it is not one.
 *
 * ⚠️ RETURNS null FOR PRODUCT LAUNCHES. They are real events and not seasonal drops;
 * `productLaunch` below is how they are kept rather than discarded.
 */
export function parseDrop(event = {}) {
  const title = String(event.title ?? event.summary ?? '').trim()
  const on = String(event.start ?? '').slice(0, 10) || null
  if (!title || !on) return null

  const d = title.match(DROP_RE)
  if (d) {
    const season = normalizeSeason(d[1])
    return season ? { season, drop: Number(d[2]), on, title, kind: 'drop' } : null
  }
  const s = title.match(SINGLE_RE)
  if (s) {
    const season = normalizeSeason(s[1])
    // ⚠️ drop: 1, because there IS only one — not null, which would make "which drop?"
    // unanswerable for Holiday, the season with the nearest launch and the most items.
    return season ? { season, drop: 1, on, title, kind: 'drop', single: true } : null
  }
  return null
}

/** A launch that is one product rather than a season. Kept, never counted as a drop. */
export function productLaunch(event = {}) {
  const title = String(event.title ?? event.summary ?? '').trim()
  const on = String(event.start ?? '').slice(0, 10) || null
  if (!title || !on || !/launch/i.test(title)) return null
  if (parseDrop(event)) return null
  return { on, title, kind: 'product', name: title.replace(/\s*launch\s*$/i, '').trim() }
}

/**
 * Every drop the calendar declares, newest last.
 *
 * ⚠️ A DUPLICATE TITLE ON THE SAME DAY IS ONE DROP. The live calendar carries both
 * "Summer Drop 1 Launch" and "Summer Drop 1" on 2026-05-05 — two entries, one event.
 * Counting both would report four Summer drops.
 */
export function dropsFrom(events = []) {
  const byKey = new Map()
  for (const e of events) {
    const d = parseDrop(e)
    if (!d) continue
    const key = `${d.season}|${d.drop}|${new Date(d.on).getFullYear()}`
    const prior = byKey.get(key)
    // ⚠️ EARLIEST DATE WINS on a duplicate. A drop goes live once; a later duplicate
    // entry is a reminder, and taking the later date would move the deadline outward.
    if (!prior || new Date(d.on) < new Date(prior.on)) byKey.set(key, d)
  }
  return [...byKey.values()].sort((a, b) => a.on.localeCompare(b.on))
}

/**
 * The drop a season-and-year belongs to.
 *
 * @param label  "Holiday 2026" as `custitem_season_year` spells it
 * @param drop   1 or 2, or null when nobody has said which
 *
 * ⚠️ WITH NO DROP NUMBER IT RETURNS THE FIRST, AND SAYS SO. Drop 1 is the earlier
 * deadline, so it is the safe assumption for a lateness check — but the caller is told
 * it was assumed, because reporting a PO late against a date nobody chose is worse than
 * reporting nothing.
 */
export function dropFor(label, drop, drops = []) {
  const m = String(label || '').match(/^(.+?)\s+(\d{4})$/)
  if (!m) return null
  const season = normalizeSeason(m[1])
  const year = Number(m[2])
  if (!season) return null
  const forSeason = drops.filter((d) => d.season === season && new Date(d.on).getFullYear() === year)
  if (!forSeason.length) return null
  if (drop != null) {
    const hit = forSeason.find((d) => d.drop === Number(drop))
    return hit ? { ...hit, assumed: false } : null
  }
  return { ...forSeason[0], assumed: forSeason.length > 1 }
}

/**
 * Is this PO's freight going to make the drop it is for?
 *
 * ⚠️ IT REFUSES TO JUDGE WITHOUT BOTH DATES. No confirmed season, no drop on the
 * calendar, or no expected arrival means there is no verdict — and "we cannot tell" is
 * reported as its own state. A lateness flag built on a guessed season would be the
 * [[default-is-not-an-answer]] bug with a deadline attached.
 *
 * ⚠️ AND IT NEVER USES A PORT DATE AS AN ARRIVAL. The drayage is invisible
 * (containerDelivery.js); `expectedOn` is whatever the caller can honestly defend — a
 * delivery somebody recorded, or the forwarder's ETA.
 */
export function dropRisk({ seasonLabel, drop, reason, expectedOn, deliveredOn, drops = [], today = new Date() } = {}) {
  // ⚠️ ONLY A LAUNCH HAS A DEADLINE, and this gate was missing until live data showed
  // why. PO1820 is 70 units of Summer 2026 arriving 2026-09-20, and the first version
  // reported it "138 days AFTER Summer Drop 1 Launch" — technically arithmetic, and
  // nonsense as a finding. Summer product coming in September is a RESTOCK; the drop it
  // originally belonged to is not a date anybody is working toward any more.
  //
  // So a restock has no verdict, and a re-order's deadline is the ORDER's date, which
  // lives on the SO/OC and not on this calendar. Judging either against a drop would
  // manufacture late flags for freight that is perfectly on time — the counter-bug shape
  // this repo keeps finding, aimed at a deadline.
  if (reason === 'restock') {
    return { state: 'no-deadline', why: 'a restock is not tied to a drop — the season it came from is history' }
  }
  if (reason === 'reorder') {
    return { state: 'no-deadline', why: 'a re-order answers to its own order date, not to a drop — check the linked SO or OC' }
  }
  const target = dropFor(seasonLabel, drop, drops)
  if (!target) {
    return { state: 'unknown', why: seasonLabel ? `no ${seasonLabel} drop on the calendar` : 'no confirmed season' }
  }
  // A delivery we actually have beats any estimate of one.
  const arrival = deliveredOn || expectedOn || null
  if (!arrival) {
    return { state: 'unknown', target, why: `needed by ${target.on} and nothing says when it arrives` }
  }
  const days = Math.round((new Date(target.on) - new Date(arrival)) / 86400000)
  const landed = !!deliveredOn
  if (days < 0) {
    return {
      state: 'late', target, arrival, days: -days, landed,
      why: `${landed ? 'landed' : 'expected'} ${arrival} — ${-days} days AFTER ${target.title} on ${target.on}`,
    }
  }
  return {
    state: days <= 7 ? 'tight' : 'ok',
    target, arrival, days, landed,
    why: `${landed ? 'landed' : 'expected'} ${arrival}, ${days} days before ${target.title} on ${target.on}`,
  }
}

/**
 * Why is this stock coming — restock, launch or re-order?
 *
 * ── ⚠️ THE SEASON DOES NOT SAY. THE CALENDAR DOES. ──────────────────────────────
 *
 * Nima, 2026-09-16: *"we also need to have the ability to show a restock of a season. so
 * in the case of the 11 air we're restocking a launch item that sold well."*
 *
 * That is the case a season alone cannot express. A PO full of Fall 2026 stock is the
 * Fall launch if it lands BEFORE the drop, and a restock of goods that sold through if
 * it lands AFTER — same season, opposite reasons. poSeason.js used to answer `launch`
 * for any PO whose top season parsed, which was a default wearing an inference's clothes.
 *
 * What settles it is whether the drop has already happened:
 *
 *     Fall Drop 2   2026-09-08   already gone  →  Fall 2026 arriving now is a RESTOCK
 *     Holiday       2026-10-13   still ahead   →  Holiday 2026 arriving now is a LAUNCH
 *
 * Which is exactly the 11-carton air shipment: Fall 2026 goods, eight days after Fall
 * Drop 2, restocking something that sold well.
 *
 * ⚠️ AN ORDER LINK OUTRANKS BOTH, because it is a fact rather than a reading of dates:
 * a PO tied to a real SO or OC exists for that order whatever the calendar says.
 *
 * ⚠️ AND IT STILL RETURNS null RATHER THAN GUESSING when there is no drop to compare
 * against. A reason nobody can defend is worse than an empty dropdown.
 */
export function suggestReason({ seasonLabel, drop, evergreen = false, hasOrderLink = false, drops = [], today = new Date() } = {}) {
  if (hasOrderLink) {
    return { reason: 'reorder', confident: true, why: 'this PO is linked to an order' }
  }
  // ⚠️ Evergreen cannot be a launch — Core belongs to no drop by definition.
  if (evergreen) {
    return { reason: 'restock', confident: true, why: 'Core stock belongs to no drop' }
  }
  const target = dropFor(seasonLabel, drop, drops)
  if (!target) {
    // ⚠️ "NO DROP ON THE CALENDAR" IS NOT "NO ANSWER" — the YEAR still tells you.
    // Nima, 2026-09-16, on PO1777: "its not core color but its a restock of previous
    // seasons." It is Fall 2025 stock arriving in 2026; that launch is long gone, and
    // returning null there made the app silent about the most obvious restock on the
    // board. The calendar only carries the current year, so a season outside it was
    // falling through a gap rather than being reasoned about.
    const m = String(seasonLabel || '').match(/(\d{4})$/)
    const year = m ? Number(m[1]) : null
    const thisYear = new Date(today).getFullYear()
    if (year && year < thisYear) {
      return { reason: 'restock', confident: true, why: `${seasonLabel} is a past season — its launch was in ${year}, so this is replenishment` }
    }
    if (year && year > thisYear) {
      // ⚠️ NOT confident: a future season IS a launch, but nobody has set its drop
      // date yet, so there is no deadline to hold it to and the plan could change.
      return { reason: 'launch', confident: false, why: `${seasonLabel} is a future season — no drop date set on the calendar yet` }
    }
    return { reason: null, confident: false, why: seasonLabel ? `no ${seasonLabel} drop on the calendar to compare against` : 'no season to compare against' }
  }
  const days = Math.round((new Date(target.on) - new Date(today)) / 86400000)
  if (days < 0) {
    return {
      reason: 'restock',
      // ⚠️ NOT confident. Stock arriving after its drop is USUALLY replenishment and can
      // equally be a launch that slipped — which is the difference between "we sold out"
      // and "we missed the date", and only a person knows which.
      confident: false,
      why: `${target.title} was ${-days} days ago (${target.on}), so this reads as a restock of goods already launched — unless the shipment is simply late`,
    }
  }
  return {
    reason: 'launch',
    confident: true,
    why: `${target.title} is ${days} days away (${target.on})`,
  }
}
