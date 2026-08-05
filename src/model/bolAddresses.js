// src/model/bolAddresses.js — ship-from / ship-to / carrier data for the VICS
// BOL, aligned to the Macy's Routing Guide (rev 4/14/26). Bloomingdale's is a
// Macy's division: its EDI orders route through a Macy's 1:1 Merge Center, so
// the BOL ship-to is the MERGE CENTER (the final DC is named on the ship-to
// name line), per the guide's examples. Nordstrom ships direct to its own DC.
//
// A field left `null` renders "(confirm …)" in red rather than a guess.

import { dcLabel, DC_ABBREV } from './dc.js'

// Where every shipment ships FROM (the master BOL's Ship From block).
export const SHIP_FROM = {
  name: 'Naghedi',
  street: '825 Western Unit 13',
  city: 'Glendale',
  state: 'CA',
  zip: '91201',
}

// Macy's 1:1 Merge Centers (guide §13.1). Which one a Bloomingdale's shipment
// routes through is assigned per-routing (on the routing email), so it's a
// per-shipment field (mergeCenter code), defaulting to CA. `label` is the short
// name used on the ship-to name lines ("Mega-Merge CA").
export const MERGE_CENTERS = {
  CA: { label: 'Mega-Merge CA', name: 'Mega-Merge CA', street: '12801 Excelsior Drive', city: 'Santa Fe Springs', state: 'CA', zip: '90670' },
  NJ: { label: 'Mega-Merge NJ', name: 'Mega-Merge NJ', street: '270 Daniels Way', city: 'Burlington', state: 'NJ', zip: '08016' },
  HP: { label: 'High Point Merge', name: 'High Point 1:1 Merge Center c/o Dynamic', street: '1124 Elon Place', city: 'High Point', state: 'NC', zip: '27260' },
}
export const DEFAULT_MERGE = 'CA'

// ── Macy's / Bloomingdale's DCs (Nima, 2026-08-05) ──────────────────────────
//
// The file used to assume Bloomingdale's ALWAYS routes through a 1:1 Merge
// Center. That is no longer true, and Nima flagged it: "our Bloomingdales have
// been routed and they are going straight to the DC via UPS ground and Fedex
// Ground… in some cases we may ship freight directly to the dc address not just
// the merge centers."
//
// ⚠️ These addresses are NOT typed from memory — they were harvested from the
// actual Macy's routing notifications sitting in quest_emails (sender
// ML.Manuundel.MacysNet@macys.com), which print the real consignee block:
//
//   "Project Number(s) 9004296 containing Shipment(s) 52129510 -
//    Consigned to: MINOOKA DC 601 MIDPOINT ROAD MINOOKA , IL 60447"
//
// Keyed on the SAME DC names src/model/dc.js already parses out of the NetSuite
// ship-to (DC_ABBREV), so a shipment's DC joins straight through with no second
// naming scheme to keep in sync.
//
// Joppa is deliberately ABSENT rather than guessed — no notification has named it
// yet, and per this file's own rule a missing field must render "(confirm …)" in
// red instead of a plausible-looking address.
export const MACYS_DCS = {
  'Secaucus':       { name: "Macy's Secaucus DC",       street: '500 Meadowlands Parkway', city: 'Secaucus',        state: 'NJ', zip: '07094' },
  'Stone Mountain': { name: "Macy's Stone Mountain DC", street: '4401 Sarr Parkway',       city: 'Stone Mountain',  state: 'GA', zip: '30083' },
  'Los Angeles':    { name: "Macy's Los Angeles DC",   street: '15541 East Gale Avenue',  city: 'City of Industry', state: 'CA', zip: '91745' },
  'Minooka':        { name: "Macy's Minooka DC",       street: '601 Midpoint Road',       city: 'Minooka',         state: 'IL', zip: '60447' },
  'China Grove DC': { name: "Macy's CFC China Grove DC", street: '1305 Liberty Ridge Rd', city: 'China Grove',     state: 'NC', zip: '28023' },
  'Hayward':        { name: "Macy's Hayward DC",       street: '28701 Hall Road',         city: 'Hayward',         state: 'CA', zip: '94545' },
}

// Where a Bloomingdale's shipment is actually consigned. Two shapes, and the
// notification says which outright rather than leaving it to be inferred:
//
//   · consigned to the DC          → parcel (UPS/FedEx Ground, "SMALL PACKAGE")
//     OR freight direct to the DC. Nima: freight-direct happens too, so this is
//     NOT the same question as "is it parcel".
//   · consigned "c/o MEGA-MERGE CA" → the merge center, as before (LTL).
//
// `direct` is therefore about the DESTINATION, never about the carrier — keeping
// those two apart is what lets freight-direct-to-DC work.
// ⚠️ A shipment's `dc` is stored ABBREVIATED ('SC', 'CL', 'HA' — see dcAbbrev in
// src/model/dc.js), while these addresses are keyed on the full DC name the
// notification prints. Looking up one with the other silently returns null, which
// would have rendered "no stored address" for every DC on the board — caught only
// by reading a real routing row. So resolve BOTH ways.
const BY_ABBREV = Object.fromEntries(
  Object.keys(MACYS_DCS).map((name) => [DC_ABBREV[name], MACYS_DCS[name]]).filter(([k]) => k),
)

export function macysDc(dc) {
  if (!dc) return null
  return MACYS_DCS[dc] || BY_ABBREV[dc] || null
}

export function routingShipTo({ dc, direct, mergeCenter } = {}) {
  if (direct) return macysDc(dc)   // null → the BOL prints "(confirm address)"
  return MERGE_CENTERS[mergeCenter || DEFAULT_MERGE] || null
}

// Nordstrom: each DC is its own ship-to (direct, no merge center).
//
// Confirmed against Nordstrom's own vendor portal 2026-08-05 (Nima's screenshot of
// https://nrdrp.sce.manh.com/udc/dm/screen/vendor-request/RoutingRequestLine):
// destination facility 89 / "PORTLAND DC" prints 5703 N MARINE DR, PORTLAND OR
// 97203 — matching the '089' entry below. Our own origin reads back as facility
// EXT2082 "Naghedi CA Warehouse", 825 Western Unit 13, Glendale CA 91201, which is
// SHIP_FROM above.
export const NORDSTROM_DCS = {
  '569': { name: 'Nordstrom DC #569', street: '30 Distribution Drive', city: 'Elizabethtown', state: 'PA', zip: '17022' },
  '584': { name: 'Nordstrom DC #584', street: '490 Columbia Ave', city: 'Riverside', state: 'CA', zip: '92507' },
  '599': { name: 'Nordstrom DC #599', street: '7700 18th Street SW', city: 'Cedar Rapids', state: 'IA', zip: '52404' },
  '299': { name: 'Nordstrom DC #299', street: '5050 Chavenelle Drive', city: 'Dubuque', state: 'IA', zip: '52002' },
  '399': { name: 'Nordstrom DC #399', street: '1600 S Miliken Avenue', city: 'Ontario', state: 'CA', zip: '91761' },
  '499': { name: 'Nordstrom DC #499', street: '37599 Filbert Street', city: 'Newark', state: 'CA', zip: '94560' },
  '699': { name: 'Nordstrom DC #699', street: '839 Commerce Drive', city: 'Upper Marlboro', state: 'MD', zip: '20774' },
  '799': { name: 'Nordstrom DC #799', street: '5497 NE 49th Terrace', city: 'Gainesville', state: 'FL', zip: '32609' },
  '089': { name: 'Nordstrom DC #089', street: '5703 North Marine Drive', city: 'Portland', state: 'OR', zip: '97203-6421' },
  '89': { name: 'Nordstrom DC #089', street: '5703 North Marine Drive', city: 'Portland', state: 'OR', zip: '97203-6421' },
}

// ── Parcel billing on a Bloomingdale's DC-direct routing (Nima, 2026-08-05) ──
//
//   "For Bloomingdales its always ground the account number is 5R12Y0 and the zip
//    code is 30083 for fedex its also always ground letting us select collect"
//
// These are STANDING RULES, not per-notification values, so they are defaults rather
// than something to type on every shipment. The 2026-08-04 notifications agree
// exactly: five UPS Ground routings all read "BILL TO ACCT#5R12Y0" with a
// third-party address of 4401 Sarr Pkwy, Stone Mountain GA 30083, and the FedEx one
// published no account at all ("vendor must use their FedEx account and ship using
// collect freight terms").
//
// ⚠️ THE ZIP IS NOT DECORATION. UPS validates a third-party billing account against
// its postal code, so an import missing 30083 is rejected or silently falls back to
// billing US — which would put Macy's freight on Naghedi's own account.
//
// ⚠️ 5R12Y0 IS MACY'S ACCOUNT. It must never be presented as one of Naghedi's two
// (C6J610 wholesale / 18GE01 ecom) — see upsRates.js, which refuses to mislabel
// them. Hence `terms` is always stated alongside it.
export const PARCEL_BILLING = {
  bloomingdales: {
    service: 'Ground',                 // both carriers, always
    ups:   { terms: 'Third Party Bill', account: '5R12Y0', zip: '30083' },
    fedex: { terms: 'Collect', account: null, zip: null },
  },
}

// Which carrier a free-typed carrier string means. Deliberately tolerant: the field
// holds whatever the routing email said ("UPS GRND", "FEDEX GROUND- PARCEL-COLLECT").
export function carrierKind(carrier) {
  const c = String(carrier || '').toLowerCase()
  if (c.includes('ups')) return 'ups'
  if (c.includes('fedex') || c.includes('fdx')) return 'fedex'
  return null
}

// Resolve billing for a shipment: anything explicitly stored WINS, the partner rule
// fills the rest. Same shape as derived task urgency — a standing rule should not
// need retyping, and a recorded exception must not be overwritten by one.
// Local rather than importing shipWindow's partnerKey — this module is an address
// and carrier table and should not depend on the ship-window rules to read a name.
function parcelPartner(partner) {
  return /bloomingdale/i.test(String(partner || '')) ? 'bloomingdales' : null
}

export function parcelBilling({ partner, carrier, freightTerms, billToAccount } = {}) {
  const rule = PARCEL_BILLING[parcelPartner(partner)] || null
  const kind = carrierKind(carrier)
  const base = rule && kind ? rule[kind] : null
  return {
    service: rule?.service || null,
    carrierKind: kind,
    terms: freightTerms || base?.terms || null,
    account: billToAccount || base?.account || null,
    // Only ever the zip belonging to the account actually being billed, so a stored
    // account with no zip does not silently inherit Macy's.
    accountZip: billToAccount && billToAccount !== base?.account ? null : (base?.zip || null),
    fromRule: !freightTerms && !billToAccount && !!base,
  }
}

// Carrier → SCAC (guide §9.1 + Naghedi's Carrier tab). TL/IM/LTL are Collect
// except RXO (3rd Party). Nordstrom always CTE (California Transport, CAIE).
export const CARRIERS = {
  'FedEx Freight': 'FXNL',
  'FEDEX ECONOMY': 'FXNL',
  'RXO Logistics': 'XLTL',
  'Dynamic LTL': 'DYXI',
  'Pilot LTL': 'PAAF',
  'PERFORMANCE TRANSPORT LLC': 'GLTN',
  'California Transport Enterprises': 'CAIE',
}

export const COMMODITY = { description: 'Polyester Handbags', nmfc: '', class: '100', packaging: 'PLT' }

// City name for a DC code, with any trailing "DC" stripped (dcLabel('CG') is
// "China Grove DC" → "China Grove"), so the ship-to reads "Macy's China Grove
// DC (CG)" not "… China Grove DC DC (CG)".
function dcCityName(dc) {
  return String(dcLabel(dc) || dc).replace(/\s*DC\s*$/i, '').trim()
}

// Resolve the ship-to block. Bloomingdale's routes via a merge center:
//   kind 'final'  → name "Macy's <City> DC (<code>)" / "<merge label>", at the
//                   merge-center address (the final DC is named, not addressed).
//   kind 'master' → name "Macy's <merge label>", at the merge-center address.
// Nordstrom ships direct to its DC (kind is ignored).
// Returns { block, missing[] }; block.name may be a 2-line string (\n).
export function shipToFor(partner, dc, label, { kind = 'final', mergeCenter = DEFAULT_MERGE } = {}) {
  let block
  if (partner === 'Nordstrom') {
    block = { ...(NORDSTROM_DCS[String(dc)] || { name: `Nordstrom DC #${dc}`, street: null, city: null, state: null, zip: null }) }
  } else {
    const mc = MERGE_CENTERS[mergeCenter] || MERGE_CENTERS[DEFAULT_MERGE]
    const name = kind === 'master'
      ? `Macy's ${mc.label}`
      : `Macy's ${dcCityName(dc)} DC (${dc})\n${mc.label}`
    block = { name, street: mc.street, city: mc.city, state: mc.state, zip: mc.zip }
  }
  const missing = ['street', 'city', 'state', 'zip'].filter((k) => !block[k])
  return { block, missing }
}
