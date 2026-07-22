// src/model/bolAddresses.js — the ship-from / ship-to address book the VICS BOL
// generator draws from (Nima, 2026-07-22).
//
// SAFETY: this is a real freight document. Any field left `null` renders as a
// loud "⚠ CONFIRM" on the BOL rather than a guess — a wrong address misroutes
// a truck. Fill nulls from the partner BOL templates in Drive
// (Warehouse Documents/Big Department Stores/{Bloomingdales,Nordstrom}) — they
// were cloud-only placeholders that wouldn't download the session this was
// built, so the confirmed values below come from Nima's notes, and the rest
// wait for him.

// Where every shipment ships FROM.
export const SHIP_FROM = {
  name: 'NAGHEDI NYC',
  street: '825 Western Ave, Unit 13',
  city: 'Glendale',
  state: 'CA',
  zip: '91201',
}

// Bloomingdale's: EVERY DC ships to the SAME consolidator — MEGA-MERGE in Santa
// Fe Springs — with the destination DC called out "c/o". So one address serves
// all Bloomingdale's DCs; only the "c/o <DC>" line changes.
export const BLOOMINGDALES_CONSOLIDATOR = {
  name: 'MEGA-MERGE CA',
  street: '12801 Excelsior Dr',
  city: 'Santa Fe Springs',
  state: 'CA',
  zip: null, // ⚠ confirm from the Bloomingdale's master BOL template
}

// Nordstrom: each DC is its own ship-to. Memory carries the DC city/state; the
// street lines + ZIPs wait on the Nordstrom BOL templates / Store Address List.
// Keyed by DC code (numeric), matching the feed's "PO Number - DC".
export const NORDSTROM_DCS = {
  '569': { name: 'Nordstrom DC #569', city: 'Elizabethtown', state: 'PA', street: null, zip: null },
  '584': { name: 'Nordstrom DC #584', city: 'Riverside', state: 'CA', street: null, zip: null },
  '599': { name: 'Nordstrom DC #599', city: 'Cedar Rapids', state: 'IA', street: null, zip: null },
  '299': { name: 'Nordstrom DC #299', city: 'Dubuque', state: 'IA', street: null, zip: null },
  '399': { name: 'Nordstrom DC #399', city: 'Ontario', state: 'CA', street: null, zip: null },
  '499': { name: 'Nordstrom DC #499', city: 'Newark', state: 'CA', street: null, zip: null },
  '699': { name: 'Nordstrom DC #699', city: 'Upper Marlboro', state: 'MD', street: null, zip: null },
  '799': { name: 'Nordstrom DC #799', city: 'Gainesville', state: 'FL', street: null, zip: null },
  '089': { name: 'Nordstrom DC #089', city: 'Portland', state: 'OR', street: null, zip: null },
}

// Known carriers → SCAC (Nima, 2026-07-22). Nordstrom always routes CTE.
export const CARRIERS = {
  'FedEx Freight': 'FXNL',
  'FedEx Economy Freight': 'FXNL',
  'FedEx Priority Freight': 'FXNL',
  'California Transport Enterprises': 'CAIE', // Nordstrom's CTE
  'Performance Transport': 'GLTN',
}

// Commodity line — Naghedi ships one thing on these BOLs.
export const COMMODITY = { description: 'Polyester Handbags', nmfc: '100', packaging: 'PLT' }

// Resolve the ship-to block for a shipment. Bloomingdale's → the shared
// consolidator with a "c/o <DC>" attention line; Nordstrom → its DC entry.
// Returns { block, missing[] } — `missing` lists any null fields so the caller
// and the BOL can flag them instead of shipping a blank/guessed address.
export function shipToFor(partner, dc, dcLabel) {
  let block
  if (partner === 'Nordstrom') {
    const entry = NORDSTROM_DCS[String(dc)] || { name: `Nordstrom DC #${dc}`, street: null, city: null, state: null, zip: null }
    block = { ...entry }
  } else {
    block = { ...BLOOMINGDALES_CONSOLIDATOR, attn: `c/o ${dcLabel || dc}` }
  }
  const missing = ['street', 'city', 'state', 'zip'].filter((k) => !block[k])
  return { block, missing }
}
