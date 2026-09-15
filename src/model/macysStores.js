// src/model/macysStores.js — the Bloomingdale's store-to-DC map, from Macy's own file.
//
// Source: "Shipping - Store to DC Listing for Small Ticket Merchandise", the Excel file
// the Routing Guide §2.1 (p5) points at. Its own Summary of Changes is dated 2026-07-28.
//
// ⚠️ §2.1 IS EXPLICIT THAT THIS FILE IS NOT OPTIONAL: "Purchase orders will only contain
// location numbers and quantities. Store to DC listing documents must be utilized to map
// each location to the correct receiving DC." The PO tells you the store; only this
// tells you where it ships.
//
// ⚠️ AND IT KEYS ON WHAT WE ALREADY HAVE. Our Bloomingdale's ship-to strings are
// "Bloomingdale's - 0001 59th St. - New York" — store number, store name, NO DC. Until
// now the DC was only knowable once an Item Fulfilment existed (see parseDc in dc.js,
// which reads it out of the fulfilment's ship-to). This maps store -> DC at ORDER time.
//
// ⚠️ TU AND HI ARE REAL, AND THEY WERE THE TWO CODES WE COULD NOT ABBREVIATE.
// DC_ABBREV in dc.js has carried seven codes and a standing note that a cargo tag for
// Bloomies University Village or Hawaii Pool Stock abbreviated to nothing. This file
// names both: store 0065 (Seattle WA) is TU, store 0947 (Hawaii Pool Stock, c/o Los
// Angeles, City of Industry CA) is HI.
//
// ⚠️ CHESHIRE IS GONE FROM THIS FILE TOO. The Routing Guide's 4/14/26 revision removed
// the Cheshire, West Johnson and Sacramento DCs; no store here routes to any of them,
// which is two independent documents agreeing rather than one being trusted.

export const SOURCE = {
  file: 'Shipping - Store to DC Listing for Small Ticket Merchandise',
  kind: 'Small Ticket (non-furniture)',
  updated: '2026-07-28',
  updatedSource: 'the file\'s own Summary of Changes sheet',
  pointedAtBy: "Macy's Routing Guide §2.1, p5",
  alsoExists: 'a separate Big Ticket listing, which we do not ship against',
  documentKey: 'macys-store-dc-listing',
  contact: { email: 'ECTech@macys.com', phone: '(513) 782-1222' },
}

const S = (store, dc, name, street, city, state, zip) => ({ store, dc, name, street, city, state, zip })

/** Every Bloomingdale's location in the Small Ticket listing. */
export const STORES = [
  S('0001', 'SC', "59th St. - New York", "1000 Third Ave", "New York", 'NY', '10022'),
  S('0002', 'ST', "Boca Raton", "5840 Glades Rd", "Boca Raton", 'FL', '33431'),
  S('0003', 'ST', "Aventura", "19555 Biscayne Blvd", "Aventura", 'FL', '33180'),
  S('0004', 'SC', "Huntington", "270 Walt Whitman Rd", "Huntington STA", 'NY', '11746'),
  S('0005', 'SC', "Bergen County - Riverside", "400 Hackensack Ave", "Hackensack", 'NJ', '07601'),
  S('0006', 'SC', "Short Hills", "1200 Morris Turnpike", "Short Hills", 'NJ', '07078'),
  S('0008', 'CL', "North Michigan", "900 NMichigan Ave", "Chicago", 'IL', '60611'),
  S('0010', 'ST', "Palm Beach Gardens", "3105 PGA Blvd", "Palm Beach Gardens", 'FL', '33410'),
  S('0011', 'SC', "Chestnut Hill I & II", "225 Boylston St", "Newton", 'MA', '02467'),
  S('0012', 'SC', "White Plains", "175 Bloomingdale Rd", "White Plains", 'NY', '10605'),
  S('0014', 'JP', "Tysons Corner Flint", "8100 Tysons Corner Center", "MC Lean", 'VA', '22102'),
  S('0016', 'JP', "King Of Prussia", "2 Rt 202 North 660 West Dekalb Pike", "King of Prussia", 'PA', '19406'),
  S('0017', 'JP', "Willow Grove Park", "2400 Moreland Park Rd", "Willow Grove", 'PA', '19090'),
  S('0020', 'ST', "Orlando FL", "4152 Conroy Rd", "Orlando", 'FL', '32839'),
  S('0024', 'JP', "Bridgewater", "410 Commons Way", "Bridgewater", 'NJ', '08807'),
  S('0027', 'SC', "Roosevelt Field", "630 Old Country Rd", "Garden City", 'NY', '11530'),
  S('0028', 'CI', "Century City CA", "10250 Santa Monica Blvd", "Los Angeles", 'CA', '90067'),
  S('0029', 'CI', "Sherman Oaks", "14060 Riverside Dr", "Sherman Oaks", 'CA', '91423'),
  S('0030', 'CI', "Newport Beach Fashion", "701 Newport Center Dr", "Newport Beach", 'CA', '92660'),
  S('0031', 'HA', "Stanford CA", "1 Stanford Shopping Center", "Palo Alto", 'CA', '94304'),
  S('0032', 'CI', "Beverly Center", "8500 Beverly Blvd", "Los Angeles", 'CA', '90048'),
  S('0034', 'JP', "Chevy Chase - Wisconsin", "5300 Western Ave", "Chevy Chase", 'MD', '20815'),
  S('0037', 'SC', "Willowbrook Place", "1400 Willowbrook Mall", "Wayne", 'NJ', '07470'),
  S('0046', 'SC', "Norwalk", "100 North Water Street", "Norwalk", 'CT', '06854'),
  S('0050', 'SC', "Westchester Furniture Clearance", "2 Saw Mill River Road", "Hawthorne", 'NY', '10532'),
  S('0053', 'SC', "Soho", "504 Broadway", "New York", 'NY', '10012'),
  S('0055', 'ST', "Lenox Square", "3393 Peachtree Rd NE", "Atlanta", 'GA', '30326'),
  S('0057', 'HA', "Valley Fair", "2847 Stevens Creek Blvd", "Santa Clara", 'CA', '95050'),
  S('0058', 'CI', "Ala Moana", "1450 Ala Moana Blvd Suite 1000", "Honolulu", 'HI', '96814'),
  S('0060', 'CI', "Glendale Galleria", "103 S. Brand Ave", "Glendale", 'CA', '91204'),
  S('0061', 'CI', "San Diego - Fashion Valley", "7057 Friars Rd", "San Diego", 'CA', '92108'),
  S('0063', 'JP', "Mosaic", "2920 District Ave # 190", "Fairfax", 'VA', '22031'),
  S('0062', 'CI', "South Coast Plaza", "3333 South Bristol St", "Costa Mesa", 'CA', '92626'),
  S('0064', 'CL', "Bloomies Old Orchard (BMS)", "4999 Old Orchard Rd, Suite B10, Building B2", "Skokie", 'IL', '60077'),
  S('0065', 'TU', "Bloomies University Village (BMS)", "2604 NE University Village St", "Seattle", 'WA', '98105'),
  S('0066', 'SC', "Grove at Shrewsbury (BMS)", "615 Broad Street", "Shrewsbury", 'NJ', '07702'),
  S('0231', 'CG', "China Grove Pool Stock/Customer Fulfillment Center", "1305 Liberty Ridge Road", "China Grove", 'NC', '28023'),
  S('0236', 'CG', "China Grove Hold and Flow", "1305 Liberty Ridge Road", "China Grove", 'NC', '28023'),
  S('0019', 'SC', "Secaucus Pool Stock", "500 Meadowlands Pkwy", "Secaucus", 'NJ', '07094'),
  S('0947', 'HI', "Hawaii Pool Stock (c/o Los Angeles)", "15541 East Gale Ave", "City of Industry", 'CA', '91745'),
]

const BY_STORE = new Map(STORES.map((s) => [s.store, s]))

/** Pad a store number the way the listing writes it: four digits. */
export const pad4 = (n) => String(n ?? '').trim().padStart(4, '0')

/** The store row, by number, padded or bare. */
export const store = (n) => BY_STORE.get(pad4(n)) || null

/**
 * The DC code that serves a store — the thing §2.1 says the PO does not tell you.
 *
 * ⚠️ RETURNS NULL FOR AN UNKNOWN STORE rather than guessing a DC. A carton routed to the
 * wrong location is $250 per receipt plus $10 per carton plus the freight
 * (macysRouting.TRANSPORT_OFFSETS.unauthorizedCarrier / Vendor Standards p58), so a
 * guessed DC is the most expensive kind of helpful.
 */
export function dcForStore(n) {
  const s = store(n)
  return s ? s.dc : null
}

/** Every store a DC serves — for consolidating a BOL. */
export const storesForDc = (dc) =>
  STORES.filter((s) => s.dc === String(dc ?? '').trim().toUpperCase())

/** The DC codes in use, with how many stores each serves. */
export function dcCounts() {
  const out = {}
  for (const s of STORES) out[s.dc] = (out[s.dc] || 0) + 1
  return out
}

/**
 * ⚠️ WHICH DC CODES THIS FILE USES THAT dc.js CANNOT NAME.
 *
 * DC_ABBREV maps a DC's NAME to its code, because it was built from fulfilment ship-to
 * strings. This file gives the code and the STORES it serves, not the DC's own name or
 * address — so TU and HI can be recognised and abbreviated, but not addressed. Saying
 * which half we have is the point: a BOL needs the address, and we still do not have
 * one for these two.
 */
export const CODES_WITHOUT_ADDRESS = ['TU', 'HI']
