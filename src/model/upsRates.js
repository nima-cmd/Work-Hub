// src/model/upsRates.js — what a big box actually costs on the WHOLESALE UPS account.
//
// The problem this solves (Nima, 2026-08-01): "if we can get the rate for the big
// boxes in ShipStation or anywhere it would be great." The obvious route — ask
// ShipStation to rate a shipment on the wholesale account — is blocked:
//
//   • The C6J610 "Big Box" carrier connection in ShipStation is BROKEN. Verified
//     live 2026-08-02: /v2/carriers/se-698098 returns a healthy-looking record with
//     23 services and 10 package types, but an actual /v2/rates against it answers
//     "The connection appears to be invalid, attempting to reconnect this
//     integration may resolve the issue." /v2/rates/estimate fails the same way
//     (it returns one all-null row). **Cached carrier metadata is not a working
//     connection — always rate-test.**
//   • V1 /shipments/getrates CANNOT target an account. It takes only a
//     `carrierCode`, and both UPS accounts are `"ups"`. Proven, not assumed:
//     asked for a 32 lb box Glendale→Nantucket, V1 returned $57.64/$134.02/
//     $152.08/$181.38 — byte-identical to the 18GE01 V2 quote. **V1 silently
//     quotes the PRIMARY account, which is NOT wholesale.**
//
// So a LIVE wholesale quote genuinely requires Nima to reconnect the carrier.
// But a real wholesale NUMBER does not — because the wholesale account's labels
// were bought through ShipStation for years, and every one of them recorded what
// UPS actually charged:
//
//   2023 · C6J610 ~27% of UPS volume      2024 · C6J610 100%
//   2025 · C6J610 100%                    2026 · Mar 1 · Apr 118 · May 15 · Jun 8 · Jul 0
//
// The last C6J610 label was 2026-06-29 (1ZC6J6104219896430, 12 lb, 22×16×7,
// ups_ground to Fort Lauderdale, **$30.99** billed). Ecom moved to 18GE01 across
// Apr–Jun 2026 and the wholesale connection went dark at the same time — which is
// why nobody noticed it break. That history is thousands of real invoiced
// wholesale shipments with weight, dimensions, destination and billed cost.
//
// An actual billed cost is in one way BETTER than a quote: it is what UPS charged,
// surcharges included, not what UPS estimated. Its weakness is age — UPS raises
// rates annually (GRI, typically ~5–6%), so a 2024 actual understates today. This
// module therefore never returns a bare number. Every figure carries where it came
// from, which account, how many samples, how closely they matched, and how stale
// they are, so a historical actual can never be mistaken for a live quote.
//
// THE RULE THAT MATTERS: an 18GE01 figure is never the wholesale number. The
// tracking numbers prove the wholesale lane bills to C6J610 (1Z**C6J610**…), so
// quoting the primary account and calling it wholesale would understate or
// overstate a real invoice. `wholesaleFigure()` below will return null rather than
// substitute another account — it has no fallback on purpose.

// The two UPS accounts. Both are carrierCode "ups"; only the V2 carrier_id and the
// account number tell them apart. Verified live 2026-08-02.
export const UPS_ACCOUNTS = {
  C6J610: { account: 'C6J610', carrierId: 'se-698098', nickname: 'Big Box', role: 'wholesale', primary: false },
  '18GE01': { account: '18GE01', carrierId: 'se-697942', nickname: 'Small', role: 'ecom', primary: true },
}

// The account boutique/wholesale freight actually bills to.
export const WHOLESALE_ACCOUNT = 'C6J610'

// The default ship-from — ShipStation warehouse 248889, its only warehouse.
export const ORIGIN = { street1: '825 Western Avenue', city: 'Glendale', state: 'CA', postalCode: '91201', country: 'US' }

// A 1Z tracking number embeds the six-character UPS shipper number: 1Z<acct><…>.
// This is the ONLY reliable way to tell which account paid for a ShipStation
// shipment — the shipment record itself carries just carrierCode "ups".
export function accountFromTracking(tracking) {
  const m = /^1Z([A-Z0-9]{6})/i.exec(String(tracking || '').trim())
  return m ? m[1].toUpperCase() : null
}

export const isWholesaleAccount = (account) => String(account || '').toUpperCase() === WHOLESALE_ACCOUNT

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const zip3 = (p) => String(p || '').replace(/\D/g, '').slice(0, 3) || null
const zip1 = (p) => String(p || '').replace(/\D/g, '').slice(0, 1) || null

export function toPounds(value, units) {
  const n = num(value)
  if (n === null) return null
  const u = String(units || 'pounds').toLowerCase()
  if (u.startsWith('oz') || u.startsWith('ounce')) return n / 16
  if (u.startsWith('g') && !u.startsWith('gr')) return n / 453.59237
  if (u.startsWith('gram')) return n / 453.59237
  if (u.startsWith('kg') || u.startsWith('kilo')) return n * 2.20462262
  return n
}

// Percentile on a sorted array, linear interpolation. Median = p(0.5).
function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100)

// How close a historical shipment's weight has to be to count as comparable.
// ±25%, but never a window narrower than ±2 lb — otherwise a 3 lb target admits
// only 2.25–3.75 lb and small boxes find no comparables at all.
export function weightMatches(rowLb, targetLb, { pct = 0.25, floorLb = 2 } = {}) {
  if (rowLb === null || targetLb === null) return false
  const tol = Math.max(targetLb * pct, floorLb)
  return Math.abs(rowLb - targetLb) <= tol
}

// UPS ground price is driven by distance as much as weight, so comparing a
// Glendale→Nantucket box against a Glendale→Burbank box is meaningless. Match on
// the tightest geography that still yields enough samples, and always report which
// tier was used — a "nationwide" answer is a much weaker claim than a "same ZIP3"
// one, and the caller must be able to see the difference.
export const GEO_TIERS = [
  { tier: 'same ZIP3', match: (r, t) => zip3(t.destPostal) && zip3(r.destPostal) === zip3(t.destPostal) },
  { tier: 'same state', match: (r, t) => t.destState && String(r.destState || '').toUpperCase() === String(t.destState).toUpperCase() },
  { tier: 'same region', match: (r, t) => zip1(t.destPostal) && zip1(r.destPostal) === zip1(t.destPostal) },
  { tier: 'nationwide', match: () => true },
]

// Rows that are eligible at all: right account, right service, a real billed cost,
// not voided. A voided label was refunded — including it would pull the median
// toward money that was never spent.
export function eligibleActuals(rows, { account, serviceCode } = {}) {
  const acct = String(account || '').toUpperCase()
  const svc = serviceCode ? String(serviceCode).toLowerCase() : null
  return (rows || []).filter((r) => {
    if (r.voided) return false
    const cost = num(r.shipmentCost ?? r.shipment_cost)
    if (!cost || cost <= 0) return false
    const rowAcct = String(r.upsAccount ?? r.ups_account ?? accountFromTracking(r.trackingNumber ?? r.tracking_number) ?? '').toUpperCase()
    if (acct && rowAcct !== acct) return false
    if (svc && String(r.serviceCode ?? r.service_code ?? '').toLowerCase() !== svc) return false
    return true
  })
}

// Normalize a stored/API row into the shape the matcher works with.
export function normalizeActual(r) {
  const weightLb = r.weightLb ?? r.weight_lb ?? toPounds(r.weight?.value, r.weight?.units)
  return {
    trackingNumber: r.trackingNumber ?? r.tracking_number ?? null,
    upsAccount: (r.upsAccount ?? r.ups_account ?? accountFromTracking(r.trackingNumber ?? r.tracking_number)) || null,
    serviceCode: r.serviceCode ?? r.service_code ?? null,
    weightLb: num(weightLb),
    destPostal: r.destPostal ?? r.dest_postal ?? r.shipTo?.postalCode ?? null,
    destState: r.destState ?? r.dest_state ?? r.shipTo?.state ?? null,
    shipmentCost: num(r.shipmentCost ?? r.shipment_cost),
    shipDate: r.shipDate ?? r.ship_date ?? r.createDate ?? null,
    voided: Boolean(r.voided),
  }
}

// The core: what did boxes like this one actually cost on this account?
//
// Widens the geographic match until it has `minSamples`, and reports the tier it
// settled for. Returns null when there is no comparable history at all — the
// caller must handle that rather than receive a fabricated number.
export function quoteFromActuals(rows, target, { minSamples = 5, asOfDate = null } = {}) {
  const pool = eligibleActuals((rows || []).map(normalizeActual), target)
  if (!pool.length) return null

  let chosen = null
  for (const t of GEO_TIERS) {
    const hits = pool.filter((r) => t.match(r, target) && weightMatches(r.weightLb, target.weightLb))
    if (hits.length >= minSamples) { chosen = { tier: t.tier, hits }; break }
    // Remember the widest non-empty set so a thin history still answers, flagged.
    if (hits.length) chosen = { tier: t.tier, hits, thin: true }
  }
  if (!chosen || !chosen.hits.length) return null

  const costs = chosen.hits.map((r) => r.shipmentCost).sort((a, b) => a - b)
  const dates = chosen.hits.map((r) => r.shipDate).filter(Boolean).map((d) => String(d).slice(0, 10)).sort()
  const newest = dates.length ? dates[dates.length - 1] : null
  const ref = asOfDate ? new Date(asOfDate) : null
  const staleDays = newest && ref ? Math.round((ref - new Date(newest)) / 86400000) : null

  return {
    basis: 'historical-actual',
    account: String(target.account || '').toUpperCase(),
    isWholesale: isWholesaleAccount(target.account),
    serviceCode: target.serviceCode || null,
    tier: chosen.tier,
    thin: Boolean(chosen.thin) || chosen.hits.length < minSamples,
    n: chosen.hits.length,
    median: round2(percentile(costs, 0.5)),
    p25: round2(percentile(costs, 0.25)),
    p75: round2(percentile(costs, 0.75)),
    min: round2(costs[0]),
    max: round2(costs[costs.length - 1]),
    asOf: { from: dates[0] || null, to: newest },
    staleDays,
    // Said plainly, because this is the number someone will paste into an email.
    caveat: 'What UPS actually billed on this account for comparable boxes — not a live quote. UPS raises rates annually, so older actuals understate today.',
  }
}

// A live V2 quote, normalized to the same provenance shape.
export function liveFigure({ account, serviceCode, shippingAmount, otherAmount, asOf = null }) {
  const ship = num(shippingAmount) || 0
  const other = num(otherAmount) || 0
  return {
    basis: 'live-quote',
    account: String(account || '').toUpperCase(),
    isWholesale: isWholesaleAccount(account),
    serviceCode: serviceCode || null,
    shipping: round2(ship),
    other: round2(other),
    total: round2(ship + other),
    asOf,
  }
}

// THE GUARD. Given every figure we managed to obtain, return the one that may be
// called "the wholesale rate" — a live wholesale quote if we have one, else a
// wholesale historical actual. There is deliberately NO fallback to another
// account: if wholesale produced nothing, this returns null and the caller must
// say "unknown" rather than quietly show the primary account's price.
export function wholesaleFigure(figures = []) {
  const wholesale = figures.filter((f) => f && f.isWholesale)
  return wholesale.find((f) => f.basis === 'live-quote') || wholesale.find((f) => f.basis === 'historical-actual') || null
}

// Figures from any other account are cross-checks only, and are labelled as such
// so no UI can render one under a "wholesale" heading by accident.
export function crossChecks(figures = []) {
  return figures
    .filter((f) => f && !f.isWholesale)
    .map((f) => ({ ...f, notWholesale: true, warning: `${f.account} is not the wholesale account — boutique freight bills to ${WHOLESALE_ACCOUNT}. Estimate only.` }))
}

// Assemble the answer for one box: the wholesale figure (or an explicit null with
// a reason), plus cross-checks, plus what would unblock a live number.
export function rateAnswerForBox(box, figures, { liveWholesaleError = null } = {}) {
  const wf = wholesaleFigure(figures)
  return {
    box: {
      weightLb: num(box?.weightLb ?? box?.weight_lb),
      lengthIn: num(box?.lengthIn ?? box?.length_in),
      widthIn: num(box?.widthIn ?? box?.width_in),
      heightIn: num(box?.heightIn ?? box?.height_in),
    },
    wholesale: wf,
    wholesaleUnavailableReason: wf ? null : (liveWholesaleError || 'No comparable billed history on the wholesale account, and no live connection to quote it.'),
    liveWholesaleError,
    crossChecks: crossChecks(figures),
  }
}
