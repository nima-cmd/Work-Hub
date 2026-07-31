// src/model/departures.js — a departure is a SHIPMENT, not a fulfilment.
//
// The bug this fixes (Nima, 2026-08-02): 2026-07-30 showed 50 fulfilments with a
// ship date, which every surface rendered as 50 departures. It was **8** — seven
// Bloomingdale's BOLs plus one Rustan parcel. On an EDI purchase order every
// destination DC gets its own item fulfilment, so counting IFs inflates
// departures by roughly 6× and makes a normal end-of-month push look like an
// anomaly. (I had flagged that spike as a suspected data fault; it wasn't one.
// Nima: "each DC has multiple IF … that inflates the number.")
//
// The grouping rule, in his words: "we should be able to associate the IF with
// the BOL and consolidate them as one big massive shipment."
//
//   • EDI freight — the fulfilment carries a PO-DC identifier ("7590875-SC").
//     Its shipment is the BOL covering that (DC, PO). Many IFs → one BOL.
//   • Everything else — boutique and ecom parcels move one fulfilment at a time,
//     so each IF is its own shipment. NOT lumped into a partner bucket: they are
//     genuinely separate consignments with separate tracking.
//
// A fulfilment with a PO-DC but no BOL yet is still ONE shipment per PO-DC, not
// per IF — the freight is consolidated the moment it's packed to a DC, whether
// or not a BOL number has been minted. Otherwise "how many shipments left today"
// would change purely because paperwork caught up.
//
// Pure: no DB, no network, no clock.

// A BOL covers a (partner, DC) over a set of POs, so a fulfilment matches when
// its DC matches AND its PO is one of the members.
const bolKeyFor = (poDc, shipments = []) => {
  const dash = String(poDc || '').indexOf('-')
  if (dash < 1) return null
  const po = poDc.slice(0, dash).trim()
  const dc = poDc.slice(dash + 1).trim()
  if (!po || !dc) return null
  const hit = shipments.find((s) => String(s.dc) === dc && (s.memberPos || []).map(String).includes(po))
  return hit ? { key: `BOL:${hit.bolNumber || hit.id}`, bol: hit } : { key: `PODC:${poDc}`, bol: null }
}

// Roll fulfilments up into shipments.
//   fulfilments: [{ ifNumber, soNumber, customer, source, actualShipDate, poDc }]
//   shipments:   routing_shipment rows [{ id, bolNumber, dc, memberPos, partner }]
export function groupDepartures(fulfilments = [], shipments = []) {
  const out = new Map()

  for (const f of fulfilments) {
    const match = f.poDc ? bolKeyFor(f.poDc, shipments) : null
    // No PO-DC at all → a parcel. Keyed by its own IF so it stays one shipment.
    const key = match ? match.key : `IF:${f.ifNumber}`

    let g = out.get(key)
    if (!g) {
      g = {
        key,
        kind: match ? 'freight' : 'parcel',
        bolNumber: match?.bol?.bolNumber || null,
        dc: match?.bol?.dc || (f.poDc ? f.poDc.slice(f.poDc.indexOf('-') + 1) : null),
        partner: match?.bol?.partner || null,
        poNumbers: [],
        customer: f.customer || null,
        source: f.source || null,
        shipDate: f.actualShipDate || null,
        fulfilments: [],
      }
      out.set(key, g)
    }
    g.fulfilments.push(f)
    const po = f.poDc ? f.poDc.slice(0, f.poDc.indexOf('-')) : null
    if (po && !g.poNumbers.includes(po)) g.poNumbers.push(po)
    // Earliest ship date across the members — a BOL leaves once, even if its
    // fulfilments were stamped over two days.
    if (f.actualShipDate && (!g.shipDate || f.actualShipDate < g.shipDate)) g.shipDate = f.actualShipDate
  }

  return [...out.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)))
}

// "8 departures · 50 fulfilments" — and never just "50". Both numbers always
// appear together so neither can be mistaken for the other, the same discipline
// the court strip uses ([[work-hub-court-strip]]).
export function departureSummary(groups = []) {
  const ifs = groups.reduce((n, g) => n + g.fulfilments.length, 0)
  if (!groups.length) return ''
  const s = `${groups.length} departure${groups.length === 1 ? '' : 's'}`
  return ifs === groups.length ? s : `${s} · ${ifs} fulfilments`
}

// One shipment's label for a day list: the BOL if it has one, else the DC it was
// packed to, else the fulfilment itself.
export function departureLabel(g) {
  if (g.bolNumber) return g.bolNumber
  if (g.kind === 'freight' && g.dc) return `DC ${g.dc} (no BOL yet)`
  return g.fulfilments[0]?.ifNumber || '—'
}
