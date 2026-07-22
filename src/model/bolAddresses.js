// src/model/bolAddresses.js — ship-from / ship-to / carrier data for the VICS
// BOL, aligned to the Macy's Routing Guide (rev 4/14/26). Bloomingdale's is a
// Macy's division: its EDI orders route through a Macy's 1:1 Merge Center, so
// the BOL ship-to is the MERGE CENTER (the final DC is named on the ship-to
// name line), per the guide's examples. Nordstrom ships direct to its own DC.
//
// A field left `null` renders "(confirm …)" in red rather than a guess.

import { dcLabel } from './dc.js'

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

// Nordstrom: each DC is its own ship-to (direct, no merge center).
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
