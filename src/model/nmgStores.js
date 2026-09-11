// src/model/nmgStores.js — the Neiman Marcus store list and store→DC map.
//
// Nima, 2026-09-11: "we need a vendro standards we need a store list as well as a
// store to dc list and then finally the EDI mapping routing guidelines to reference
// … were gonna be starting with neiman Marcus."
//
// ── WHERE THIS COMES FROM, AND WHY NOT THE ROUTING GUIDE ─────────────────────
//
// The store→DC assignment is READ FROM NETSUITE, not from the guide. Every Neiman
// customer record carries `custentity_dc_location`, and that is the field the rest
// of this app already routes on (src/model/dc.js, the PO-DC identifier, the cargo
// tags). A second hand-typed list would be a second source of truth for the one
// fact that decides where freight goes.
//
// Pulled 2026-09-11: 28 stores + 3 DC records, all active.
//
// ── ⚠️ TWO NUMBERING SYSTEMS, AND THE BOL NEEDS THE GUIDE'S ─────────────────
//
// NetSuite numbers the DCs 7010 / 7060 / 7077. The Routing Guide numbers the same
// buildings 510 / 560 / 577. Both appear in live documents, so this file holds the
// translation explicitly rather than letting anyone "fix" one to match the other.
//
// ⚠️ THE TRANSLATION IS MATCHED ON THE DC's NAME, NOT ITS DIGITS. The digits happen
// to line up (7077→577, 7060→560, 7010→510) and that is a coincidence I am not
// willing to build on: NetSuite's own record names say PINNACLE POINT / EAST COAST
// DISTRIBUTION CENTER / WEST COAST SERVICE CENTER, and those match the guide's PNDC
// / ECDC / WCSC entries at the same street addresses. The name is the evidence.
//
// ⚠️ AND "WCSC" IS TWO DIFFERENT DC CODES AT ONE ADDRESS. 2500 Workman Mill Road is
// guide DC 577 for NMG and DC 517 for Saks Fifth Avenue, with DIFFERENT receiving
// hours and — for 517 — delivery refused outright without a TMS routing. These are
// Neiman stores, so they take 577. A Saks banner shipment to the same dock does not.

import { DCS } from './saksRouting.js'

/** The DC records, as NetSuite holds them, keyed by NetSuite's code. */
export const NS_DCS = {
  7010: { nsCode: '7010', nsName: 'PINNACLE POINT DISTRIBUTION CENTER 7010 - PNDC', guideCode: '510' },
  7060: { nsCode: '7060', nsName: 'Neiman Marcus - EAST COAST DISTRIBUTION CENTER 7060 - ECDC', guideCode: '560' },
  7077: { nsCode: '7077', nsName: 'Neiman Marcus - WEST COAST SERVICE CENTER 7077 - WCSC', guideCode: '577' },
  // ⚠️ Exemplar's own PNDC customer carries '0510' — the GUIDE's code, zero-padded,
  // on a customer whose name is "EXEMPLAR LUXURY - GLOBAL PNDC - 0077". So both
  // numbering systems are already live in the same field. Mapped to the same
  // building rather than treated as a fourth DC.
  '0510': { nsCode: '0510', nsName: 'EXEMPLAR LUXURY - GLOBAL PNDC', guideCode: '510' },
}

/**
 * The stores. `store` is the 4-digit number, `abbrev` the 2-3 letter code NetSuite
 * puts at the end of the name — both appear on carton markings (§8 requires "Store
 * number and abbreviation"), which is why the abbreviation is carried, not dropped.
 */
export const STORES = [
  { store: '1001', name: 'Downtown',          abbrev: 'DT',  nsDc: '7010' },
  { store: '1002', name: 'NorthPark',         abbrev: 'NP',  nsDc: '7010' },
  { store: '1003', name: 'Ft. Worth',         abbrev: 'FW',  nsDc: '7010' },
  { store: '1004', name: 'Houston Galleria',  abbrev: 'HO',  nsDc: '7010' },
  { store: '1005', name: 'Bal Harbour',       abbrev: 'BH',  nsDc: '7010' },
  { store: '1006', name: 'Atlanta',           abbrev: 'AT',  nsDc: '7010' },
  { store: '1007', name: 'St. Louis',         abbrev: 'SL',  nsDc: '7010' },
  { store: '1009', name: 'Northbrook',        abbrev: 'NB',  nsDc: '7010' },
  { store: '1010', name: 'Beverly Hills',     abbrev: 'LA',  nsDc: '7077' },
  { store: '1011', name: 'Fashion Island',    abbrev: 'FI',  nsDc: '7077' },
  { store: '1012', name: 'San Francisco',     abbrev: 'SF',  nsDc: '7077' },
  { store: '1013', name: 'Plano Willow Bend', abbrev: 'PWB', nsDc: '7010' },
  { store: '1014', name: 'Westchester',       abbrev: 'WC',  nsDc: '7010' },
  { store: '1015', name: 'Las Vegas',         abbrev: 'LV',  nsDc: '7077' },
  { store: '1016', name: 'San Diego',         abbrev: 'SD',  nsDc: '7077' },
  { store: '1017', name: 'Oakbrook',          abbrev: 'OB',  nsDc: '7010' },
  { store: '1019', name: 'Michigan Ave',      abbrev: 'MA',  nsDc: '7010' },
  { store: '1020', name: 'Boston',            abbrev: 'BN',  nsDc: '7010' },
  { store: '1023', name: "Tyson's II",        abbrev: 'TY',  nsDc: '7010' },
  { store: '1024', name: 'Palo Alto',         abbrev: 'PA',  nsDc: '7077' },
  { store: '1025', name: 'Short Hills',       abbrev: 'SH',  nsDc: '7010' },
  { store: '1027', name: 'Denver',            abbrev: 'DN',  nsDc: '7077' },
  { store: '1028', name: 'Paramus',           abbrev: 'PR',  nsDc: '7010' },
  { store: '1029', name: 'Scottsdale',        abbrev: 'SC',  nsDc: '7077' },
  { store: '1030', name: 'King of Prussia',   abbrev: 'KP',  nsDc: '7010' },
  { store: '1031', name: 'Ala Moana',         abbrev: 'AM',  nsDc: '7077' },
  { store: '1033', name: 'Troy',              abbrev: 'TR',  nsDc: '7010' },
  { store: '1034', name: 'Coral Gables',      abbrev: 'CG',  nsDc: '7010' },
  { store: '1035', name: 'Tampa Bay',         abbrev: 'TB',  nsDc: '7010' },
  { store: '1036', name: 'Orlando',           abbrev: 'OR',  nsDc: '7010' },
  { store: '1037', name: 'San Antonio',       abbrev: 'SA',  nsDc: '7010' },
  { store: '1038', name: 'Boca Raton',        abbrev: 'BR',  nsDc: '7010' },
  { store: '1101', name: 'Austin',            abbrev: 'AN',  nsDc: '7010' },
  { store: '1102', name: 'Charlotte',         abbrev: 'CH',  nsDc: '7010' },
  { store: '1105', name: 'Topanga',           abbrev: 'TP',  nsDc: '7077' },
  { store: '1111', name: 'Roosevelt Field',   abbrev: 'RF',  nsDc: '7010' },
]

const BY_STORE = new Map(STORES.map((s) => [s.store, s]))

/**
 * ⚠️ A STORE NUMBER IS ZERO-PADDED IN EDI AND BARE EVERYWHERE ELSE. The same trap
 * saksRouting.js documents for DC codes: PO 8928906 carries ship-to `0510` where the
 * guide says `510`. Looked up both ways, because a lookup that silently misses
 * renders a carton label with no store name — fee code 41/301, $250 minimum.
 */
export function store(num) {
  if (num === null || num === undefined) return null
  const s = String(num).trim()
  return BY_STORE.get(s) ?? BY_STORE.get(s.padStart(4, '0')) ?? BY_STORE.get(s.replace(/^0+/, '')) ?? null
}

/**
 * The DC a store's freight goes to, in BOTH numbering systems, with the address and
 * receiving hours the BOL and the appointment request need.
 *
 * Returns null for an unknown store rather than defaulting to anything. [[default-is-not-an-answer]]
 * — a guessed DC is freight delivered to the wrong building, and the routing card
 * that asserted "via the Santa Fe Springs merge center" is the precedent.
 */
export function dcForStore(num) {
  const s = store(num)
  if (!s) return null
  const ns = NS_DCS[s.nsDc]
  const guide = ns ? DCS[ns.guideCode] : null
  if (!guide) return null
  return {
    store: s.store, storeName: s.name, storeAbbrev: s.abbrev,
    nsCode: ns.nsCode, code: guide.code, name: guide.name, abbrev: guide.abbrev,
    address: guide.address, receiving: guide.receiving, appointment: guide.appointment,
  }
}

/** Every store that ships to one DC — the grouping a consolidated BOL is built on. */
export function storesForDc(code) {
  const c = String(code ?? '').replace(/^0+/, '')
  return STORES.filter((s) => {
    const ns = NS_DCS[s.nsDc]
    return ns && (ns.guideCode.replace(/^0+/, '') === c || ns.nsCode.replace(/^0+/, '') === c)
  })
}

/**
 * Group a packed shipment's store quantities by destination DC.
 *
 * ⚠️ AN UNKNOWN STORE IS RETURNED, NOT DROPPED. A store missing from this list means
 * Neiman opened one or renamed one — the answer is to refresh the list, never to
 * quietly ship 12 units to whichever DC the rest happened to use.
 */
export function groupByDc(lines = []) {
  const groups = new Map()
  const unknown = []
  for (const line of lines) {
    const dc = dcForStore(line.store)
    if (!dc) { unknown.push(line); continue }
    if (!groups.has(dc.code)) groups.set(dc.code, { dc, lines: [], units: 0, stores: new Set() })
    const g = groups.get(dc.code)
    g.lines.push(line)
    g.units += Number(line.qty) || 0
    g.stores.add(String(line.store))
  }
  return {
    groups: [...groups.values()].map((g) => ({ ...g, stores: [...g.stores].sort() }))
      .sort((a, b) => a.dc.code.localeCompare(b.dc.code)),
    unknown,
  }
}

// ⚠️ NETSUITE'S `entityid` IS NOT UNIQUE, AND 541 IS THE PROOF. Querying entityid
// '541' returns TWO live customers: "Nordstrom - 541 - University Station Rack" and
// "EXEMPLAR LUXURY - GLOBAL PNDC - 0077". Anything that looks a store up by that
// number alone can land on the wrong retailer entirely — so store lookups here go
// through STORES (Neiman only) and never through a bare entityid query.
export const ENTITYID_IS_NOT_UNIQUE = {
  example: '541',
  customers: ['Nordstrom - 541 - University Station Rack', 'EXEMPLAR LUXURY - GLOBAL PNDC - 0077'],
  rule: 'scope every customer lookup by retailer before matching on the number',
}

export const SOURCE = {
  storesAndDcAssignment: 'NetSuite customer records + custentity_dc_location, pulled 2026-09-11',
  dcAddressesAndHours: 'Saks Global US Routing Guide rev 11 — see src/model/saksRouting.js DCS',
  documentKey: 'saks-routing-rev11',
  counts: { stores: 36, dcs: 3 },
}
