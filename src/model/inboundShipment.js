// src/model/inboundShipment.js — a container or air shipment as ONE thing.
//
// Nima, 2026-09-09: "we need a place for this to live in our base. we want to track
// thsi as one entitty the 11 airshipment. we know when t left we with tracking or
// through an email should know when it will arive. we can use the data as it comes in
// to generate how quickly a air shipment or container takes to get to us to auto
// generate a date that can be changed with better information. We want to keep track
// so we know where theses vessels are and when to expect them"
//
// The container already exists in four other places — a packing slip, some POs, some
// Item Receipts, some Transfer Orders — and in none of them is it a VESSEL with a
// position between two dates. That is what this is.
//
// ⚠️ THE WHOLE POINT IS THAT AN ARRIVAL IS OBSERVED, NOT INFERRED. Before this
// existed, the only available "arrival" was an Item Receipt's `createddate` — the day
// someone typed it into NetSuite. Measured across all 64 generated container records
// that reads: air 2 days, sea 6 to 31. The 31 (container `321`, shipped 7/10, entered
// 8/10) is almost certainly a month of paperwork lag, not a slow ship, and one PO of
// container `264` was entered 28 days after its siblings on the same vessel. An ETA
// model trained on that predicts our own admin habits and calls it shipping time —
// [[netsuite-fields-that-lie]] aimed at a date.
//
// So: `arrivedOn` is the day it arrived. `recordedAt` is when we found out. They are
// different columns on purpose, and only the first one feeds the estimate.

export const MODES = ['air', 'sea']

/**
 * ⚠️ EVERY DATE HERE CARRIES ITS SOURCE, and that is not bookkeeping decoration.
 * An estimate that looks like an entered date is the [[default-is-not-an-answer]] bug
 * with a calendar attached: someone plans a week around a number nobody promised.
 * `entered` beats `estimate`, and an estimate must never overwrite an entered value.
 */
export const DATE_SOURCES = ['entered', 'estimate', 'email', 'tracking', 'marked']
export const SOURCE_RANK = { estimate: 0, tracking: 1, email: 2, entered: 3, marked: 3 }

/** Is `incoming` allowed to replace `current`? Better information wins; ties go to the newer. */
export function sourceWins(incoming, current) {
  if (!current) return true
  return (SOURCE_RANK[incoming] ?? 0) >= (SOURCE_RANK[current] ?? 0)
}

/**
 * Guess air vs sea from the container label.
 *
 * ⚠️ A SUGGESTION, AND FLAGGED AS ONE. The account's labels really do read `1 air`,
 * `11 Air`, `2 Air DHL`, `35 Air` for flights and bare counts — `321`, `264`, `39`,
 * `16`, `55` — for sea, so the guess is good. It is still a guess made from a name
 * someone typed, and mode selects which transit average applies, so a wrong one
 * quietly moves an ETA by weeks.
 */
export function inferMode(containerLabel) {
  const s = String(containerLabel || '')
  // ⚠️ AIR IS TESTED FIRST BECAUSE THE AIR LABELS ALSO SAY "carton". The live ones read
  // `1 air carton 2026.8.8` and `11 Air 1820 1777 air list carton 2026.9.7` — order is
  // the whole rule, and reversing these two lines calls both of them sea.
  if (/\bair\b/i.test(s)) return { mode: 'air', inferred: true }
  // ⚠️ THIS USED TO BE `^\s*\d+\s+carton\b` AND MISSED BOTH LIVE SEA CONTAINERS. The
  // docblock above claimed the labels read "321, 264, 39, 16, 55" — they do not:
  //
  //     55 LCL carton 2026.9.7                        words between number and "carton"
  //     59 cartons LCL to LA INVOICE&PL (1) carton …  PLURAL, and `carton\b` fails on it
  //
  // Both suggested nothing, which is safe but useless — the anchored pattern only ever
  // matched the older, simpler labels. The shape that actually holds is the one
  // containerTransfer.containerKey already relies on: "<count> …words… carton <date>".
  if (/\bcartons?\b/i.test(s)) return { mode: 'sea', inferred: true }
  return { mode: null, inferred: true }
}

const DAY = 86400000
const asDate = (v) => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
export const daysBetween = (a, b) => {
  const x = asDate(a), y = asDate(b)
  return x && y ? Math.round((y - x) / DAY) : null
}

/**
 * Which date a shipment's clock starts from, and WHAT THAT DATE ACTUALLY IS.
 *
 * ── ⚠️ `departed_on` IS NOT A DEPARTURE, AND THE WHOLE ESTIMATE HUNG OFF IT ───────
 *
 * Nima, 2026-09-15, on the packing slip's date: *"that is the date on the packing slip
 * which is the date she is letting us know its completed."* The column is named
 * `departed_on` and the schema note has always said what it holds — the factory's pack
 * date — but every figure built on it was called TRANSIT, which it is not. Measured on
 * the 59-carton container:
 *
 *     packing slip     2026-08-17   Chelly: it is finished
 *     GLC vessel ETD   2026-08-25   the ship left — EIGHT DAYS LATER
 *
 * So "median of 4 sea arrivals (16-31 days)" silently included however long the freight
 * sat between her email and the vessel sailing. The prediction was never wrong — both
 * ends of the median use the same anchor, so it is self-consistent — but the LABEL
 * invited somebody to reason about shipping time using a number that is not shipping
 * time. Same family as `shipdate` being `trandate + 28`
 * (src/model/fieldAssumptions.js).
 *
 * ⚠️ AND WHEN GLC GIVES US THE REAL SAIL DATE, USE IT. `etd_on` is the vessel actually
 * leaving — a strictly better anchor, and we have it for two of three live containers.
 * The slip date stays the fallback rather than the default, and either way the basis
 * string SAYS WHICH, because two shipments measured from different anchors must not be
 * presented as the same quantity.
 */
export const ANCHORS = {
  etd: { key: 'etd', field: 'etdOn', label: 'vessel departure', measures: 'sailed → landed', rank: 2 },
  packed: { key: 'packed', field: 'departedOn', label: 'factory complete', measures: 'finished in China → landed', rank: 1 },
}

export function anchorFor(s) {
  // ⚠️ Ranked, not first-non-null-wins, so adding a third anchor later cannot silently
  // outrank the vessel's own date by being listed above it.
  const found = Object.values(ANCHORS)
    .sort((a, b) => b.rank - a.rank)
    .find((a) => asDate(s?.[a.field]))
  return found || null
}

/**
 * Days from the shipment's best anchor to its observed arrival, or null.
 *
 * ⚠️ NULL UNLESS THE ARRIVAL WAS ACTUALLY OBSERVED. A shipment with an estimated ETA
 * and no arrival has no transit time, and substituting the estimate would feed the
 * model its own output — it would converge on whatever it first guessed and look
 * increasingly confident doing it.
 *
 * ⚠️ IT RETURNS THE ANCHOR ALONGSIDE THE NUMBER. A caller that averages days measured
 * from two different starting points produces a figure describing neither, so the anchor
 * has to travel with the value rather than be recoverable only by re-deriving it.
 */
export function transitDays(s) {
  const anchor = anchorFor(s)
  if (!s?.arrivedOn || !anchor) return null
  const d = daysBetween(s[anchor.field], s.arrivedOn)
  // A negative transit means one of the two dates is wrong. Reported by the caller
  // rather than silently clamped to 0, which would look like a same-day arrival.
  return d == null ? null : d
}

/** The same measurement, with the anchor it was taken from. */
export function transitFrom(s) {
  const anchor = anchorFor(s)
  const days = transitDays(s)
  return days == null ? null : { days, anchor }
}

export const MIN_SAMPLES = 3

/**
 * Per-mode transit statistics from observed arrivals only.
 *
 * ⚠️ MEDIAN, NOT MEAN. One container held at customs for a month drags a mean into
 * uselessness; the median says what normally happens, which is what an expectation
 * is for. `spread` is reported alongside so a wide one can be shown rather than
 * hidden behind a single confident number.
 */
export function transitStats(shipments = []) {
  const byMode = new Map()
  const anomalies = []
  for (const s of shipments) {
    const t = transitFrom(s)
    if (t == null) continue
    const d = t.days
    if (d < 0) { anomalies.push({ containerLabel: s.containerLabel, days: d, reason: `arrived before its ${t.anchor.label} date` }); continue }
    if (!s.mode) { anomalies.push({ containerLabel: s.containerLabel, days: d, reason: 'no mode — cannot be attributed to air or sea' }); continue }
    // ⚠️ KEYED ON MODE **AND** ANCHOR. A median mixing days-since-sailing with
    // days-since-the-factory-finished describes neither: the 59 shows those two anchors
    // eight days apart, so one such sample shifts a small median by most of a week. Two
    // quantities that are not the same quantity do not go in one bucket, however much
    // it costs in sample size — and it does cost, which is why `enough` is per bucket.
    const key = `${s.mode}|${t.anchor.key}`
    const arr = byMode.get(key) ?? []
    arr.push(d)
    byMode.set(key, arr)
  }
  const stats = {}
  for (const [key, days] of byMode) {
    const [mode, anchorKey] = key.split('|')
    const sorted = [...days].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    stats[key] = {
      mode,
      // ⚠️ The anchor rides ALONG with the statistic. estimateEta reads it to build the
      // basis string, so a date can never be presented without saying what it counted
      // from — an estimate whose derivation is invisible gets treated as a promise.
      anchor: ANCHORS[anchorKey],
      n: sorted.length,
      median: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      spread: sorted[sorted.length - 1] - sorted[0],
      // ⚠️ Below MIN_SAMPLES this is a data point, not an average, and estimateEta
      // refuses to use it. Two containers agreeing is a coincidence.
      enough: sorted.length >= MIN_SAMPLES,
    }
  }
  return { stats, anomalies }
}

/**
 * Suggest an arrival date.
 *
 * ⚠️ RETURNS NULL RATHER THAN A NUMBER IT CANNOT JUSTIFY. No mode, no departure date,
 * or fewer than MIN_SAMPLES observed arrivals for that mode means there is no honest
 * estimate — and a screen saying "unknown" is worth more than one saying a date it
 * made up. The whole reason this module exists is that a plausible date is the most
 * dangerous kind.
 *
 * ⚠️ AND IT ALWAYS CARRIES ITS BASIS, so the UI can show "median of 4 sea arrivals,
 * 6-31 days" beside the date. An estimate whose derivation is invisible gets treated
 * as a promise.
 */
export function estimateEta(shipment, stats = {}) {
  const mode = shipment?.mode
  if (!mode) return null
  // ⚠️ THE ANCHOR IS CHOSEN FIRST, AND THE STATISTICS ARE LOOKED UP TO MATCH IT. The
  // other way round — pick the best-populated bucket, then find a date to add it to —
  // is how you end up adding days-since-sailing to a factory-complete date and calling
  // the result an arrival. The 59 shows those anchors eight days apart.
  const anchor = anchorFor(shipment)
  if (!anchor) return null
  const st = stats[`${mode}|${anchor.key}`]
  // ⚠️ NO FALLBACK TO THE OTHER ANCHOR'S BUCKET. A vessel-departure estimate is better
  // than a factory-complete one, but borrowing the factory-complete MEDIAN and applying
  // it to a sail date is not an estimate of anything — it is two quantities added
  // together. Better no date than that one.
  if (!st?.enough) return null
  const from = asDate(shipment[anchor.field])
  if (!from) return null
  const eta = new Date(from.getTime() + st.median * DAY)
  return {
    etaOn: eta.toISOString().slice(0, 10),
    source: 'estimate',
    anchor,
    // ⚠️ THE BASIS NAMES WHAT WAS COUNTED FROM. "median of 4 sea arrivals (16-31 days)"
    // reads as time at sea; it was never that, and saying so is the entire fix.
    basis: `median of ${st.n} ${mode} arrivals measured ${anchor.measures} (${st.min}-${st.max} days from ${anchor.label})`,
    confidence: st.spread <= 3 ? 'tight' : st.spread <= 10 ? 'loose' : 'very wide',
  }
}

/**
 * Where is this vessel, and does it need attention?
 *
 * ⚠️ "NO ETA" IS ITS OWN STATE, not a quiet member of "in transit". A shipment nobody
 * can put a date on is exactly the one that gets forgotten, and lumping it in with
 * the ones that are tracking fine is how it stays forgotten. Same never-lump rule as
 * the court strip.
 */
export function shipmentState(s, today = new Date()) {
  const now = asDate(today.toISOString ? today.toISOString().slice(0, 10) : today)
  if (s?.arrivedOn) {
    return { state: 'arrived', arrivedOn: s.arrivedOn, transitDays: transitDays(s), attention: false }
  }
  if (!s?.departedOn) {
    return { state: 'not departed', attention: false, note: 'no departure date on the slip' }
  }
  if (!s?.etaOn) {
    return {
      state: 'no eta',
      attention: true,
      note: s.mode
        ? 'not enough observed arrivals for this mode to estimate one yet — enter it'
        : 'no mode set, so no estimate is possible — is this air or sea?',
      daysOut: daysBetween(s.departedOn, now),
    }
  }
  const slack = daysBetween(now, s.etaOn)
  if (slack < 0) {
    return {
      state: 'overdue', daysLate: -slack, attention: true,
      // ⚠️ AND IT MIGHT ONLY BE OVERDUE ON PAPER. Nothing here observes a vessel; an
      // arrival that happened and was never marked reads identically to one that has
      // not happened. The wording has to admit that or the first stale card teaches
      // everyone to ignore the whole list.
      note: s.etaSource === 'estimate'
        ? 'past an ESTIMATED date — either late, or it landed and was never marked'
        : 'past its expected arrival — either late, or it landed and was never marked',
    }
  }
  if (slack === 0) return { state: 'due today', attention: true }
  return { state: 'in transit', daysToEta: slack, attention: false }
}

/** One shipment, fully resolved: state, estimate if it needs one, and its NetSuite legs. */
export function describeShipment(s, stats = {}, today = new Date()) {
  const mode = s.mode ?? inferMode(s.containerLabel).mode
  const withMode = { ...s, mode }
  // An estimate fills a GAP; it never replaces a date with a stronger source.
  let etaOn = s.etaOn
  let etaSource = s.etaSource ?? null
  let etaBasis = s.etaNote ?? null
  if (!etaOn || sourceWins('estimate', etaSource)) {
    const est = estimateEta(withMode, stats)
    if (est && (!etaOn || etaSource === 'estimate')) {
      etaOn = est.etaOn; etaSource = est.source; etaBasis = est.basis
    }
  }
  const resolved = { ...withMode, etaOn, etaSource, etaBasis }
  return {
    ...resolved,
    modeInferred: !s.mode && !!mode,
    ...shipmentState(resolved, today),
  }
}

/** The whole board, ordered so what needs attention is first. */
export function shipmentBoard(shipments = [], today = new Date()) {
  const { stats, anomalies } = transitStats(shipments)
  const rows = shipments.map((s) => describeShipment(s, stats, today))
  const rank = { overdue: 0, 'due today': 1, 'no eta': 2, 'in transit': 3, 'not departed': 4, arrived: 5 }
  rows.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9)
    || String(a.etaOn || '9999').localeCompare(String(b.etaOn || '9999')))
  return {
    rows,
    stats,
    anomalies,
    counts: {
      // ⚠️ Counted from the resolved STATE, never re-derived here — two places
      // computing the same status is how a counter comes to disagree with its list.
      overdue: rows.filter((r) => r.state === 'overdue').length,
      dueToday: rows.filter((r) => r.state === 'due today').length,
      noEta: rows.filter((r) => r.state === 'no eta').length,
      inTransit: rows.filter((r) => r.state === 'in transit').length,
      arrived: rows.filter((r) => r.state === 'arrived').length,
    },
    attention: rows.filter((r) => r.attention).length,
  }
}
