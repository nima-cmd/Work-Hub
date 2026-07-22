// src/model/bolAddresses.js — the ship-from / ship-to address book the VICS BOL
// generator draws from. Values transcribed from Nima's real BOL templates
// (Bloomingdales / Nordstrom "Address" + "Carrier" tabs) on 2026-07-22, so the
// generated BOL matches what he files today.
//
// A field left `null` renders "(confirm …)" in red on the BOL rather than a
// guess — a wrong freight address misroutes a truck.

import { dcLabel } from './dc.js'

// Where every shipment ships FROM (the master BOL's Ship From block).
export const SHIP_FROM = {
  name: 'Naghedi',
  street: '825 Western Unit 13',
  city: 'Glendale',
  state: 'CA',
  zip: '91201',
}

// Bloomingdale's: EVERY DC ships to the SAME consolidator — Macy's MEGA-MERGE in
// Santa Fe Springs — with the destination DC named on the "c/o" line. So one
// address serves all Bloomingdale's DCs; only the DC name changes.
export const BLOOMINGDALES_CONSOLIDATOR = {
  name: 'MEGA-MERGE CA',
  street: '12801 EXCELSIOR DRIVE',
  city: 'SANTA FE SPGS',
  state: 'CA',
  zip: '90670',
}

// Nordstrom: each DC is its own ship-to (from the Nordstrom "Address" tab).
// Keyed by DC code (numeric), matching the feed's "PO Number - DC". 089 is
// listed both zero-padded and bare since the feed/sheets use both.
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

// Known carriers → SCAC (from the "Carrier" tab). Nordstrom always routes CTE.
export const CARRIERS = {
  'PERFORMANCE TRANSPORT LLC': 'GLTN',
  'California Transport Enterprises': 'CAIE', // Nordstrom's CTE
  'FEDEX ECONOMY': 'FXNL',
}

// Commodity line — Naghedi ships one thing on these BOLs.
export const COMMODITY = { description: 'Polyester Handbags', nmfc: '', class: '100', packaging: 'PLT' }

// Resolve the ship-to block for a shipment. Bloomingdale's → the shared
// consolidator, its name line reading "<DC> c/o MEGA-MERGE CA" (matching the
// template's Address tab); Nordstrom → its DC entry. Returns { block, missing[] }.
export function shipToFor(partner, dc, label) {
  let block
  if (partner === 'Nordstrom') {
    block = { ...(NORDSTROM_DCS[String(dc)] || { name: `Nordstrom DC #${dc}`, street: null, city: null, state: null, zip: null }) }
  } else {
    const dcName = (label || dcLabel(dc) || String(dc)).toUpperCase()
    block = { ...BLOOMINGDALES_CONSOLIDATOR, name: `${dcName} c/o MEGA-MERGE CA` }
  }
  const missing = ['street', 'city', 'state', 'zip'].filter((k) => !block[k])
  return { block, missing }
}
