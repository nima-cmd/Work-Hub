// src/model/manhattanTender.js — Nordstrom's TMS tells us when the truck actually comes.
//
// `cpadmin@support.manh.com` is Manhattan Associates' Active TMS, which Nordstrom runs.
// When we submit a routing request it comes back as "Tender Accepted for Shipment
// S000190212", and that email is the ONLY place three facts exist:
//
//   • the accepted pickup datetime  — we guess a ship_date when we submit; this is the answer
//   • the carrier                   — routing_shipment.carrier is null on every Nordstrom row
//   • one SRR per DC                — the routing-request number Nima types into the portal
//
// It is self-validating: the email states a total carton count, and our own per-DC
// cartons must sum to it. Live 2026-08-06, S000190212: 42 in the email, 42 in our data.
//
// ── ⚠️ THE GRAIN OF AN SRR IS THE **DC**, NOT THE SPO ───────────────────────────
//
// The obvious reading of the email is that SRR[i] pairs with SPO[i] — and on four of the
// six tenders in the mailbox that is true, because each DC happened to carry one PO.
// It is WRONG. Tender S000137008 carries **9 SRRs against 24 SPOs** (three POs fanned
// across six DCs, plus two POs across three more). Pairing by position there would have
// handed six DCs a routing number belonging to another DC's freight.
//
// Checked across all six live tenders, distinct-DC count equals SRR count every time:
//
//   S000190212  9 SRR / 9 SPO  / 9 DCs      S000137008  9 SRR / 24 SPO / 9 DCs  ← the proof
//   S000147117  9 SRR / 9 SPO  / 9 DCs      S000145602  3 SRR / 3 SPO  / 3 DCs
//   S000122409  9 SRR / 9 SPO  / 9 DCs      (S000137008 arrives TWICE — see below)
//
// So: collapse SPOs to distinct DCs in first-appearance order, then zip with the SRRs.
//
// ⚠️ That ORDER is still an inference — the email never says which SRR belongs to which
// DC. It is not a guess, though: Nima had already hand-keyed all nine SRRs of
// S000190212 into `routing_shipment.routing_request_number` before this file existed,
// and this rule reproduces his pairing **9 for 9** (569→…053 … 089→…061). That hand
// entry is the ground truth this parser was validated against, not the other way round.
//
// ⚠️ And when the counts DISAGREE we pair NOTHING. An SRR on the wrong DC is worse than
// no SRR: it is a number Nima would confidently type into a portal. `srrPairing` records
// which happened so a surface can say so out loud instead of rendering a silent null.
//
// ── ⚠️ THE LEADING-ZERO JOIN TRAP ───────────────────────────────────────────────
//
// The email writes `50073677-89`; our `orders.dc` for that same DC is `089`. A literal
// join drops exactly one of the nine stops — and drops it SILENTLY, which is the shape
// where a reconciliation quietly reports 8 of 9 and reads like a real finding. Both
// sides go through `normalizeDc`.
//
// ── ORIGIN / DESTINATION ARE TEMPLATE FIELDS, NOT SHIPMENT DATA ─────────────────
//
// The origin reads `EXT2082, Glendale, CA` and the destination `CTE, South Gate, CA` —
// both California, for a New York company, which looks alarming. It is boilerplate:
// **all six tenders back to 5 May 2026 carry the identical origin, destination and
// carrier string.** A field that is 100% constant across every instance is a template,
// not an observation. Corroborated on the outcome too — S000147117 planned pickup for
// 5 June and PO 50125577 shipped 2026-06-05, so the tender's date predicts the real
// departure. They are parsed and stored (cheaply) but nothing keys off them.
//
// ── ⚠️ TENDERS ARRIVE MORE THAN ONCE ────────────────────────────────────────────
//
// S000137008 was sent twice, 2h27m apart, byte-identical in every parsed field. The
// shipment id is the identity; a re-send must upsert, never duplicate. Same shape as
// the 62 re-sent 856s in [[asn-resend-vs-exposure]]: a document arriving again is not
// a second shipment.

/** Fields we lift out of the tender body. Kept as one list so the parser and the
 *  persistence layer cannot drift about what a tender is. */
import { scacFor } from './bolAddresses.js'

export const TENDER_FIELDS = [
  'shipmentId', 'pickupAt', 'pickupRaw', 'carrier',
  'originFacility', 'originCity', 'originState',
  'destFacility', 'destCity', 'destState',
  'totalCartons', 'totalWeightLb', 'totalVolumeCuft',
]

/** How the SRR→DC pairing was arrived at, so a surface never has to guess. */
export const SRR_PAIRING = {
  BY_DC_ORDER: 'by_dc_order', // distinct-DC count matched the SRR count; zipped in order
  COUNT_MISMATCH: 'count_mismatch', // counts disagreed — deliberately paired nothing
  NO_SRR: 'no_srr', // the tender carried no SRR list at all
}

// Nordstrom DC codes are numeric and the two systems disagree about leading zeros
// (`89` in the email, `089` in ours). Anything non-numeric (a Bloomingdale's `SC`) is
// left alone but case-folded, so this stays safe if it is ever pointed at another lane.
export function normalizeDc(dc) {
  if (dc == null) return null
  const s = String(dc).trim()
  if (!s) return null
  return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase()
}

// `50073677-89` → { po: '50073677', dc: '89' }. Split on the LAST hyphen: PO numbers
// have never contained one, but reading right-to-left costs nothing and cannot be
// wrong-footed by one that does.
export function parseSpo(spo) {
  const s = String(spo || '').trim()
  if (!s) return null
  const i = s.lastIndexOf('-')
  if (i <= 0 || i === s.length - 1) return null
  return { po: s.slice(0, i).trim(), dc: s.slice(i + 1).trim() }
}

// The body is HTML with the values inside <div><b>Label :</b> value</div>. Tags are
// stripped to one flat space-separated string first — the labels are stable, the markup
// is not, and every value we want is plain text sitting after its own label.
function flatten(html) {
  return String(html || '')
    // The tender is a marketing-style template with ~200 lines of CSS above the content.
    // Callers that hand us a pre-stripped body have already lost it; callers that hand
    // us raw HTML have not, and a stray `Carrier` in a class name would be read as data.
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// A list field can overflow into numbered continuations (`SRR cont1`, `SPO cont3`).
// They are empty `[]` on most tenders and populated on the big ones — S000137008 puts
// six of its 24 SPOs in cont1. Reading only the base field silently truncates.
function bracketList(text, label) {
  const re = new RegExp(`${label}(?:\\s+cont\\d+)?\\s*:\\s*\\[([^\\]]*)\\]`, 'g')
  const out = []
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const v = part.trim()
      if (v) out.push(v)
    }
  }
  return out
}

function after(text, label, stopLabels = []) {
  const stop = stopLabels.length ? `(?=\\s*(?:${stopLabels.join('|')})\\s*:)` : '$'
  const m = text.match(new RegExp(`${label}\\s*:\\s*(.*?)\\s*${stop}`))
  return m ? m[1].trim() || null : null
}

// 'FacilityId : EXT2082, City : Glendale, State : CA' → the three parts.
function parsePlace(s) {
  if (!s) return { facility: null, city: null, state: null }
  const g = (k) => {
    const m = s.match(new RegExp(`${k}\\s*:\\s*([^,]+)`))
    return m ? m[1].trim() || null : null
  }
  return { facility: g('FacilityId'), city: g('City'), state: g('State') }
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

// '10 August 2026 08:00:00 PDT' → a real instant.
//
// ⚠️ The zone abbreviation is part of the value and must NOT be dropped: PDT is the
// carrier's local time at a California facility, and this repo has already been bitten
// once by a date that was a keystroke rather than an observation
// ([[marked-shipped-is-not-departed]]). Only the two Pacific abbreviations Nordstrom's
// TMS has ever sent are mapped; anything else returns null rather than silently
// booking a pickup in the wrong zone. The raw string is always kept alongside.
const ZONE_OFFSETS = { PDT: '-07:00', PST: '-08:00' }

export function parsePickup(raw) {
  if (!raw) return null
  const m = String(raw).trim().match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{3,4})$/,
  )
  if (!m) return null
  const [, d, monName, y, hh, mm, ss, zone] = m
  const mon = MONTHS[monName.toLowerCase()]
  const off = ZONE_OFFSETS[zone]
  if (mon == null || !off) return null
  const iso = `${y}-${String(mon + 1).padStart(2, '0')}-${d.padStart(2, '0')}` +
    `T${hh.padStart(2, '0')}:${mm}:${ss}${off}`
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

const NUM = (s) => {
  if (s == null) return null
  const n = Number(String(s).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Parse one tender email into a tender + its per-DC stops.
 * Returns null when the body is not a tender (no shipment id) — the caller filters on
 * sender and subject, but a mailbox is not a schema and this must not throw on junk.
 */
export function parseTenderEmail({ subject, body, receivedAt, messageId } = {}) {
  const text = flatten(body)
  const shipmentId =
    (text.match(/ShipmentId\s*:\s*(\S+)/) || [])[1] ||
    (String(subject || '').match(/Shipment\s+(\S+)/) || [])[1] ||
    null
  if (!shipmentId) return null

  const pickupRaw = after(text, 'Planned Time of 1st Stop', ['SRR', 'SPO', 'Origin Details'])
  const origin = parsePlace(after(text, 'Origin Details', ['Destination Details', 'Carrier']))
  const dest = parsePlace(after(text, 'Destination Details', ['Carrier', 'Total Dimensions']))
  const dims = after(text, 'Total Dimensions', []) || ''
  const dim = (k) => NUM((dims.match(new RegExp(`${k}\\s*:\\s*([\\d.]+)`)) || [])[1])

  const srrs = bracketList(text, 'SRR')
  const spos = bracketList(text, 'SPO').map(parseSpo).filter(Boolean)

  // Collapse to distinct DCs in first-appearance order — the SRR grain. See the header.
  const byDc = new Map()
  for (const { po, dc } of spos) {
    const key = normalizeDc(dc)
    if (!key) continue
    if (!byDc.has(key)) byDc.set(key, { dc: key, dcRaw: dc, poNumbers: [] })
    const e = byDc.get(key)
    if (!e.poNumbers.includes(po)) e.poNumbers.push(po)
  }
  const dcs = [...byDc.values()]

  const srrPairing = !srrs.length
    ? SRR_PAIRING.NO_SRR
    : srrs.length === dcs.length
      ? SRR_PAIRING.BY_DC_ORDER
      : SRR_PAIRING.COUNT_MISMATCH

  const stops = dcs.map((e, i) => ({
    ...e,
    seq: i + 1,
    srr: srrPairing === SRR_PAIRING.BY_DC_ORDER ? srrs[i] : null,
  }))

  return {
    shipmentId,
    messageId: messageId || null,
    tenderedAt: receivedAt ? new Date(receivedAt) : null,
    pickupRaw,
    pickupAt: parsePickup(pickupRaw),
    carrier: after(text, 'Carrier', ['Total Dimensions']),
    originFacility: origin.facility, originCity: origin.city, originState: origin.state,
    destFacility: dest.facility, destCity: dest.city, destState: dest.state,
    totalCartons: dim('Total Carton'),
    totalWeightLb: dim('Total Weight'),
    totalVolumeCuft: dim('Total Volume'),
    srrCount: srrs.length,
    spoCount: spos.length,
    srrPairing,
    srrs,
    stops,
  }
}

/** What a tender disagrees with us about. One entry per fact, never lumped. */
export const TENDER_DIFF = {
  PICKUP_DATE: 'pickup_date',
  CARRIER: 'carrier',
  SRR: 'srr',
  NO_SHIPMENT: 'no_shipment',
  CARTONS: 'cartons',
}

const ymd = (d) => {
  if (!d) return null
  const x = d instanceof Date ? d : new Date(d)
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10)
}

// The pickup instant is stored with its zone, but `routing_shipment.ship_date` is a
// DATE. Comparing them needs the pickup's date **in the carrier's local zone**, not
// UTC — an 08:00 PDT pickup is 15:00Z the same day, but a 17:00 PDT one would be the
// NEXT day in UTC and would read as a one-day disagreement that does not exist.
export function pickupLocalYmd(tender) {
  if (!tender?.pickupAt) return null
  const off = ZONE_OFFSETS[(tender.pickupRaw || '').trim().split(/\s+/).pop()] || '+00:00'
  const sign = off.startsWith('-') ? -1 : 1
  const [oh, om] = off.slice(1).split(':').map(Number)
  const shifted = new Date(tender.pickupAt.getTime() + sign * (oh * 60 + om) * 60_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * Find the routing shipment a tender stop belongs to.
 *
 * ⚠️ THE DC ALONE IS NOT A KEY. Nordstrom ships through the same handful of DCs every
 * cycle — 569, 584, 599, 299… appear on all six tenders in the mailbox — while
 * routing_shipment holds ONE row per (partner, DC) for the shipment currently in play.
 * Matching on DC alone makes every historical tender "match" today's rows and report a
 * pickup-date disagreement for a truck that came and went in May. The PO set is what
 * distinguishes one cycle from the next, so a match needs the DC *and* an overlapping PO.
 *
 * Falls back to the DC alone only when one side has no PO list at all — a row that
 * cannot be distinguished is better matched than silently dropped, and the caller sees
 * it as matched rather than as a phantom gap.
 */
export function matchStop(stop, shipments = []) {
  const dc = normalizeDc(stop.dc)
  const sameDc = shipments.filter((s) => normalizeDc(s.dc) === dc)
  if (!sameDc.length) return null
  const pos = stop.poNumbers || []
  if (!pos.length) return sameDc[0]
  const overlap = sameDc.find((s) => (s.memberPos || []).some((p) => pos.includes(String(p))))
  if (overlap) return overlap
  // No PO overlap anywhere, but the other side never told us its POs — can't rule it out.
  const poless = sameDc.find((s) => !(s.memberPos || []).length)
  return poless || null
}

/**
 * Compare a tender against the routing_shipment rows we hold.
 *
 * ⚠️ Deliberately returns DIFFERENCES and never a corrected row. `ship_date`, `carrier`
 * and `routing_request_number` are all hand-entered by Nima in the Routing view, and
 * silently overwriting a hand-entered field is how a surface stops being trustworthy.
 * The register learned this the hard way ([[dc-cargo-tag-never-closed]]): a stale value
 * is a signal, not clutter. A caller may choose to apply these; this does not.
 *
 * `shipments` are the rows for the tender's partner, each { id, dc, cartons, shipDate,
 * carrier, routingRequestNumber, bolNumber }.
 */
export function reconcileTender(tender, shipments = []) {
  const diffs = []
  const matched = []
  const unmatchedStops = []
  const pickupYmd = pickupLocalYmd(tender)

  for (const stop of tender.stops) {
    const s = matchStop(stop, shipments)
    if (!s) {
      unmatchedStops.push(stop)
      continue
    }
    matched.push({ stop, shipment: s })

    const ours = ymd(s.shipDate)
    if (pickupYmd && ours !== pickupYmd) {
      diffs.push({
        kind: TENDER_DIFF.PICKUP_DATE, dc: stop.dc, shipmentId: s.id, bolNumber: s.bolNumber,
        ours, theirs: pickupYmd,
        detail: `DC ${stop.dc}: we say ${ours || 'no date'}, the accepted tender says ${pickupYmd}`,
      })
    }
    if (tender.carrier && (s.carrier || null) !== tender.carrier) {
      diffs.push({
        kind: TENDER_DIFF.CARRIER, dc: stop.dc, shipmentId: s.id, bolNumber: s.bolNumber,
        ours: s.carrier || null, theirs: tender.carrier,
        detail: `DC ${stop.dc}: carrier ${s.carrier ? `"${s.carrier}"` : 'not set'}, tender says "${tender.carrier}"`,
      })
    }
    if (stop.srr && (s.routingRequestNumber || null) !== stop.srr) {
      diffs.push({
        kind: TENDER_DIFF.SRR, dc: stop.dc, shipmentId: s.id, bolNumber: s.bolNumber,
        ours: s.routingRequestNumber || null, theirs: stop.srr,
        detail: `DC ${stop.dc}: SRR ${s.routingRequestNumber || 'not set'} vs tender ${stop.srr}`,
      })
    }
  }

  // ⚠️ A tender that matched NOTHING is out of scope, not broken. Nordstrom reuses the
  // same DC numbers every cycle — DC 569 is on all six tenders in the mailbox — so the
  // May and June tenders are simply older than any routing_shipment row we still hold.
  // Emitting nine NO_SHIPMENT rows for each of them would bury the one tender that is
  // live under historical noise that no one can act on. Only a PARTIAL match is a real
  // gap: some of this shipment's DCs are known and some are not.
  if (matched.length) {
    for (const stop of unmatchedStops) {
      diffs.push({
        kind: TENDER_DIFF.NO_SHIPMENT, dc: stop.dc, srr: stop.srr,
        detail: `tender stop ${stop.dc} (PO ${stop.poNumbers.join(', ')}) matches no routing shipment`,
      })
    }
  }

  // The carton total is the tender's own checksum, and the reason to trust the rest of
  // it. Only meaningful once every stop found a shipment — a partial match undercounts
  // by construction and would report a phantom discrepancy.
  const ourCartons = matched.reduce((n, m) => n + (Number(m.shipment.cartons) || 0), 0)
  const allMatched = matched.length === tender.stops.length && tender.stops.length > 0
  const cartonsAgree = allMatched && tender.totalCartons != null
    ? ourCartons === tender.totalCartons
    : null
  if (cartonsAgree === false) {
    diffs.push({
      kind: TENDER_DIFF.CARTONS, ours: ourCartons, theirs: tender.totalCartons,
      detail: `cartons: we hold ${ourCartons} across ${matched.length} DCs, tender says ${tender.totalCartons}`,
    })
  }

  return {
    shipmentId: tender.shipmentId,
    stops: tender.stops.length,
    matched: matched.length,
    // No stop found a shipment — a past cycle we no longer hold routing rows for, not a
    // defect. Surfaces should say "historical", never "9 shipments missing".
    outOfScope: matched.length === 0 && tender.stops.length > 0,
    ourCartons,
    theirCartons: tender.totalCartons,
    cartonsAgree,
    srrPairing: tender.srrPairing,
    pickupYmd,
    diffs,
  }
}

/**
 * Plan what "accept this tender" would change. Returns the edits ONLY — the caller
 * writes them.
 *
 * This is the click, not the cron. `reconcileTender` deliberately never proposes a
 * value because a sync must not overwrite a hand-entered field; an explicit press of a
 * button that says "the tender says Monday" is a different act, and the ONE place the
 * overwrite is legitimate.
 *
 * Three fields, three different rules, and the differences matter:
 *
 *   ship_date              OVERWRITTEN. It is the whole point — we wrote the date we
 *                          asked for, the tender is the date we were given.
 *   carrier                SET when it differs. Ours is null on every Nordstrom row.
 *   routing_request_number FILLED ONLY WHEN EMPTY. ⚠️ Never overwritten, even though
 *                          the pairing reproduced Nima's hand entry 9 for 9 — that
 *                          pairing is an inference from the SRR/DC order, and if it
 *                          ever disagrees with what he typed, the honest outcome is a
 *                          visible disagreement he resolves, not a silent correction
 *                          by a rule that could be wrong.
 *
 * An out-of-scope (historical) tender plans nothing.
 */
export function planTenderApply(tender, shipments = []) {
  const report = reconcileTender(tender, shipments)
  if (report.outOfScope) return { shipmentId: tender.shipmentId, outOfScope: true, edits: [] }

  const pickupYmd = report.pickupYmd
  const edits = []
  for (const stop of tender.stops) {
    const s = matchStop(stop, shipments)
    if (!s) continue
    const set = {}
    const kept = []
    if (pickupYmd && ymd(s.shipDate) !== pickupYmd) set.shipDate = pickupYmd
    if (tender.carrier && (s.carrier || null) !== tender.carrier) set.carrier = tender.carrier
    // ⚠️ THE SCAC RIDES WITH THE CARRIER, or applying a tender leaves a card holding a
    // carrier name with no code — and the BOL prints the SCAC, not the name. The tender
    // itself carries NO SCAC field (verified against the real Nordstrom message), so it
    // is resolved from the CARRIERS table, which returns null for anything unknown
    // rather than guessing. An existing scac is never overwritten: it is hand-entered,
    // and a stale one is a signal (see this function's own header).
    if (!s.scac) {
      const code = scacFor(tender.carrier)
      if (code) set.scac = code
    } else if (scacFor(tender.carrier) && s.scac !== scacFor(tender.carrier)) {
      kept.push({ field: 'scac', ours: s.scac, theirs: scacFor(tender.carrier) })
    }
    if (stop.srr) {
      if (!s.routingRequestNumber) set.routingRequestNumber = stop.srr
      else if (s.routingRequestNumber !== stop.srr) {
        kept.push({ field: 'routingRequestNumber', ours: s.routingRequestNumber, theirs: stop.srr })
      }
    }
    if (Object.keys(set).length || kept.length) {
      edits.push({ shipmentId: s.id, dc: stop.dc, bolNumber: s.bolNumber || null, set, kept })
    }
  }
  return {
    shipmentId: tender.shipmentId,
    outOfScope: false,
    pickupDate: pickupYmd,
    carrier: tender.carrier,
    edits,
    // Named so a caller can say "9 BOLs" out loud before writing anything.
    shipments: edits.length,
    changes: edits.reduce((n, e) => n + Object.keys(e.set).length, 0),
    conflicts: edits.reduce((n, e) => n + e.kept.length, 0),
  }
}

export function summarizeTenderDiffs(reports = []) {
  const by = (k) => reports.flatMap((r) => r.diffs).filter((d) => d.kind === k)
  return {
    tenders: reports.length,
    outOfScope: reports.filter((r) => r.outOfScope).length,
    reconciled: reports.filter((r) => r.cartonsAgree === true).length,
    pickupDate: by(TENDER_DIFF.PICKUP_DATE).length,
    carrier: by(TENDER_DIFF.CARRIER).length,
    srr: by(TENDER_DIFF.SRR).length,
    noShipment: by(TENDER_DIFF.NO_SHIPMENT).length,
    cartons: by(TENDER_DIFF.CARTONS).length,
  }
}
