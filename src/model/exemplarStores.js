// src/model/exemplarStores.js — Exemplar's stores, DCs and who services whom.
//
// Nima, 2026-09-11: "We are providing you everything we have. ... we also need to
// make sure the store names are correct in the system as well."
//
// ── ⚠️ THIS REPLACES A VERSION OF MINE THAT WAS WRONG ───────────────────────
//
// Earlier the same day I built src/model/nmgStores.js from NetSuite's
// `custentity_dc_location`, and argued in its own header that reading NetSuite was
// better than typing the guide because it gave "one source of truth for where
// freight goes". Measured against the official Store Servicing DC List (6/10/26):
//
//   • 18 of 33 store→DC assignments in NetSuite are WRONG
//   • 17 of them are stores NetSuite sends to PNDC 510 that Exemplar services from
//     ECDC 560 in Pittston PA — Bal Harbour, Atlanta, Northbrook, Westchester,
//     Oakbrook, Michigan Ave, Tysons, Short Hills, Paramus, King of Prussia, Troy,
//     Coral Gables, Tampa Bay, Orlando, Boca Raton, Charlotte, Roosevelt Field
//   • and Denver is the reverse: NetSuite says WCSC 577, Exemplar says PNDC 510
//
// NetSuite appears to hold a coarse east/west split that is not the real servicing
// map. Freight sent on it goes to the wrong building. That is a refused delivery and
// a chargeback, and the field looked authoritative because it is the field the rest
// of the app already routes on.
//
// ⚠️ SO THE STORE NUMBERS ARE ALSO NOT NETSUITE'S. NetSuite numbers Neiman stores
// 1001-1111; Exemplar's are 0110 / 0210 / 0223. The carton label and the EDI
// documents want EXEMPLAR's number — printing 1010 for Beverly Hills instead of
// 0210 is fee code 41/301, "Store # and name missing/incorrect", $250 minimum.
//
// ⚠️ WHAT NETSUITE IS STILL GOOD FOR: the two-letter abbreviation. It appears in
// both sources — NetSuite as "…- 1010 - LA", the servicing list as "Beverly Hills
// (LA)" — and is what let me align the two lists and PROVE the 18 disagreements
// rather than guess at them. It is the join key, not the authority.
//
// Sources, both supplied by Nima 2026-09-11 and both dated on their face:
//   • Store Servicing DC List, 2026-06-10  → store → servicing DC (authoritative)
//   • Saks Global EDI Store and DC codes, 2026-04-21 → DC addresses, store addresses
// Registered in src/model/partnerDocuments.js.

export const SOURCE = {
  servicingList: { title: 'Saks Global Store Servicing DC List', dated: '2026-06-10' },
  ediCodes: { title: 'Saks Global EDI Store and DC codes', dated: '2026-04-21' },
  pulled: '2026-09-11',
}

/** The banners. `O5` is Saks OFF 5th; the list abbreviates it that way. */
export const BANNERS = {
  NM: 'Neiman Marcus',
  BG: 'Bergdorf Goodman',
  SFA: 'Saks Fifth Avenue',
  O5: 'Saks OFF 5th',
}

/**
 * The distribution centres, by Exemplar's DC number.
 *
 * ⚠️ 517 AND 577 ARE THE SAME BUILDING WITH DIFFERENT DC NUMBERS. 2500 S Workman
 * Mill, Whittier is DC 517 for the Saks banners and DC 577 for Neiman. The number is
 * per banner, not per address, so a Neiman carton labelled 517 is mis-routed inside
 * a warehouse that did receive it.
 */
export const DCS = {
  510: { dc: '510', name: 'PNDC', street: '4123 Pinnacle Point', city: 'Dallas', state: 'TX', zip: '75211' },
  517: { dc: '517', name: 'SAKS WCSC', street: '2500 S Workman Mill', city: 'Whittier', state: 'CA', zip: '90601', banners: ['SFA', 'O5'] },
  550: { dc: '550', name: 'NCDC', street: '115 Morrison Ave', city: 'Thomasville', state: 'NC', zip: '27360' },
  560: { dc: '560', name: 'ECDC', street: '600-620 Research Drive', street2: 'CenterPoint Commerce & Trade Park', city: 'Pittston Township', state: 'PA', zip: '18640' },
  577: { dc: '577', name: 'NM WCSC', street: '2500 S Workman Mill', city: 'Whittier', state: 'CA', zip: '90601', banners: ['NM'] },
}

// A store row: [store, banner, name, abbrev|null, street, city, state, zip, dc|null]
const S = (store, banner, name, abbrev, street, city, state, zip, dc) =>
  ({ store, banner, name, abbrev, street, city, state, zip, dc })

/**
 * Every store, from the Store Servicing DC List of 2026-06-10.
 *
 * ⚠️ A STORE NUMBER IS NOT ALWAYS NUMERIC. 0603M / 0603W and 0630M / 0630W are the
 * men's and women's stores at one location, and they are DIFFERENT ship-tos. Parsing
 * these as integers drops the suffix and merges two destinations.
 */
export const STORES = [
  // ── Neiman Marcus ──
  S('0036', 'NM', 'NMS Photo Studio', null, '4123 Pinnacle Point', 'Dallas', 'TX', '75211', '510'),
  S('0110', 'NM', 'Downtown', 'DT', '1618 Main Street', 'Dallas', 'TX', '75201', '510'),
  S('0111', 'NM', 'Fort Worth', 'FW', '5200 Monahans Ave.', 'Fort Worth', 'TX', '76109', '510'),
  S('0112', 'NM', 'Northpark', 'NP', '8687 North Central Expressway, Suite 400', 'Dallas', 'TX', '75225', '510'),
  S('0114', 'NM', 'Houston Galleria', 'HO', '2600 S. Post Oak Blvd', 'Houston', 'TX', '77056', '510'),
  S('0115', 'NM', 'Bal Harbour', 'BH', '9700 Collins Ave', 'Bal Harbour', 'FL', '33154', '560'),
  S('0116', 'NM', 'Atlanta', 'AT', '3393 Peachtree Rd. N.E.', 'Atlanta', 'GA', '30326', '560'),
  S('0117', 'NM', 'St. Louis', 'SL', '100 Plaza Frontenac', 'St. Louis', 'MO', '63131', '510'),
  S('0209', 'NM', 'Northbrook', 'NB', '5000 Northbrook Ct.', 'Northbrook', 'IL', '60062', '560'),
  S('0210', 'NM', 'Beverly Hills', 'LA', '9700 Wilshire Blvd.', 'Beverly Hills', 'CA', '90212', '577'),
  S('0212', 'NM', 'San Francisco', 'SF', '150 Stockton St.', 'San Francisco', 'CA', '94108', '577'),
  S('0213', 'NM', 'Willow Bend', 'PWB', '2201 Dallas Pkwy', 'Plano', 'TX', '75093', '510'),
  S('0214', 'NM', 'Westchester', 'WC', '2 Maple Ave', 'White Plains', 'NY', '10601', '560'),
  S('0215', 'NM', 'Las Vegas', 'LV', '3200 Las Vegas Blvd. South, Suite 100', 'Las Vegas', 'NV', '89109', '577'),
  S('0216', 'NM', 'San Diego', 'SD', '7027 Friars Road', 'San Diego', 'CA', '92108', '577'),
  S('0217', 'NM', 'Oakbrook', 'OB', '6 Oakbrook Center', 'Oak Brook', 'IL', '60523', '560'),
  S('0218', 'NM', 'Fashion Island', 'FI', '601 Newport Center Dr.', 'Newport Beach', 'CA', '92660', '577'),
  S('0219', 'NM', 'Michigan Ave', 'MA', '737 N. Michigan Ave.', 'Chicago', 'IL', '60611', '560'),
  S('0223', 'NM', 'Tysons Galleria', 'TY', '2255 International Dr.', 'McLean', 'VA', '22102', '560'),
  S('0224', 'NM', 'Palo Alto', 'PA', '400 Stanford Shop Ctr', 'Palo Alto', 'CA', '94304', '577'),
  S('0225', 'NM', 'Short Hills', 'SH', '1200 Morris Turnpike', 'Short Hills', 'NJ', '07078', '560'),
  S('0226', 'NM', 'Denver', 'DN', '3030 E. 1st Ave.', 'Denver', 'CO', '80206', '510'),
  S('0228', 'NM', 'Paramus', 'PR', '503 Garden State Plaza', 'Paramus', 'NJ', '07652', '560'),
  S('0229', 'NM', 'Scottsdale', 'SC', '6900 E. Camelback Rd.', 'Scottsdale', 'AZ', '85251', '577'),
  S('0230', 'NM', 'King of Prussia', 'KP', '170 N. Gulph Road', 'King of Prussia', 'PA', '19406', '560'),
  S('0232', 'NM', 'Coral Gables', 'CG', '390 San Lorenzo', 'Coral Gables', 'FL', '33146', '560'),
  S('0233', 'NM', 'Troy', 'TR', '2705 W. Big Beaver', 'Troy', 'MI', '48084', '560'),
  S('0235', 'NM', 'Tampa Bay', 'TB', '2223 N Westshore Blvd., Suite 600', 'Tampa', 'FL', '33607', '560'),
  S('0236', 'NM', 'Orlando', 'OR', '4170 Conroy Road', 'Orlando', 'FL', '32839', '560'),
  S('0237', 'NM', 'San Antonio', 'SA', '15900 La Cantera Parkway, Suite 14', 'San Antonio', 'TX', '78256', '510'),
  S('0238', 'NM', 'Boca Raton', 'BR', '5860 Glades Road', 'Boca Raton', 'FL', '33431', '560'),
  S('0239', 'NM', 'Roosevelt Field / Long Island', 'RF', '620 Old Country Road', 'Garden City', 'NY', '11530', '560'),
  S('0241', 'NM', 'Austin', 'AN', '3400 Palm Way', 'Austin', 'TX', '78758', '510'),
  S('0242', 'NM', 'Charlotte', 'CH', '4400 Sharon Road', 'Charlotte', 'NC', '28211', '560'),
  // ── Bergdorf Goodman ──
  S('0037', 'BG', 'BG Photo Studio', null, '4123 Pinnacle Point Dock 60', 'Dallas', 'TX', '75211', '510'),
  S('0263', 'BG', "Bergdorf Goodman Women's", null, '2 West 58th Street', 'New York', 'NY', '10019', '560'),
  S('0264', 'BG', "Bergdorf Goodman Men's", null, '12 East 58th Street', 'New York', 'NY', '10022', '560'),
  // ── Saks Fifth Avenue ──
  S('0601', 'SFA', 'New York', null, '611 5th Avenue', 'New York', 'NY', '10022', '560'),
  S('0603M', 'SFA', "Beverly Hills Men's", null, '9634 Wilshire Blvd', 'Beverly Hills', 'CA', '90212', '517'),
  S('0603W', 'SFA', "Beverly Hills Women's", null, '9600 Wilshire Blvd', 'Beverly Hills', 'CA', '90212', '517'),
  S('0610', 'SFA', 'Palm Beach Gardens', null, '3109 PGA Boulevard', 'Palm Beach Gardens', 'FL', '33410', '560'),
  S('0612', 'SFA', 'Palm Desert', null, '73555 El Paseo', 'Palm Desert', 'CA', '92260', '517'),
  S('0624', 'SFA', 'Boca Raton', null, '5800 Glades Road', 'Boca Raton', 'FL', '33431', '560'),
  S('0628', 'SFA', 'Troy', null, '2901 W Big Beaver Road', 'Troy', 'MI', '48084', '560'),
  S('0629', 'SFA', 'Atlanta', null, '3440 Peachtree Road', 'Atlanta', 'GA', '30326', '560'),
  S('0630M', 'SFA', 'Boston', null, '800 Boylston Street', 'Somerville', 'MA', '02145', '560'),
  S('0630W', 'SFA', 'Boston', null, '100 Huntington Avenue, # 140', 'Somerville', 'MA', '02145', '560'),
  S('0632', 'SFA', 'Miami-Dade', null, '7687 North Kendall Drive', 'Miami', 'FL', '33156', '560'),
  S('0633', 'SFA', 'Sarasota', null, '120 University Town Center Dr', 'Sarasota', 'FL', '34243', '560'),
  S('0634', 'SFA', 'Houston', null, '5175 Westheimer Road', 'Houston', 'TX', '77056', '510'),
  S('0637', 'SFA', 'Bal Harbour', null, '9700 Collins Avenue', 'Bal Harbour', 'FL', '33154', '560'),
  S('0668', 'SFA', 'Brickell', null, '81 SW 8th Street', 'Miami', 'FL', '33130', '560'),
  S('0669', 'SFA', 'Naples', null, '5395 Tamiami Trail N', 'Naples', 'FL', '34108', '560'),
  S('0672', 'SFA', 'Greenwich', null, '205 Greenwich Ave', 'Greenwich', 'CT', '06830', '560'),
  // ⚠️ DC "N/A" on the servicing list, and that is recorded as null rather than
  // guessed. Samples to the photo studio are direct-to-store and skip the TMS
  // entirely (Routing Guide p5), so it genuinely has no servicing DC.
  S('0694', 'SFA', 'Saks Photo Studio', null, '611 5th Ave, 10th Floor', 'New York', 'NY', '10022', null),
  // ── Saks OFF 5th ──
  S('0705', 'O5', 'Grapevine', null, '3000 Grapevine Mills Parkway Suite 211', 'Grapevine', 'TX', '76051', '510'),
  S('0709', 'O5', 'Woodbury', null, '850 Adirondack Way Suite 850', 'Central Valley', 'NY', '10917', '560'),
  S('0712', 'O5', 'Bergen Mall', null, '120 Bergen Town Center', 'Paramus', 'NJ', '07652', '560'),
  S('0713', 'O5', 'Anaheim', null, '20 City Boulevard W Building B, Suite 2', 'Orange', 'CA', '92868', '517'),
  S('0714', 'O5', 'Aventura', null, '18701 Biscayne Blvd.', 'Aventura', 'FL', '33180', '560'),
  S('0718', 'O5', 'Dolphin', null, '11201 NW 12th Street Suite J100', 'Miami', 'FL', '33126', '560'),
  S('0723', 'O5', 'Naples Estero', null, '10801 Corkscrew Road Suite 353', 'Estero', 'FL', '33928', '560'),
  S('0733', 'O5', 'Sawgrass', null, '12801 W Sunrise Boulevard Suite 445', 'Sunrise', 'FL', '33323', '560'),
  S('0735', 'O5', 'Palm Beach', null, '172 Worth Avenue', 'West Palm Beach', 'FL', '33401', '560'),
  S('0776', 'O5', 'Westbury', null, '1070 Old Country Rd.', 'Garden City', 'NY', '11530', '560'),
  S('0817', 'O5', 'Boca Raton', null, '5800 Glades Road', 'Boca Raton', 'FL', '33434', '560'),
  S('0842', 'O5', 'Buckhead', null, '1 Buckhead Loop', 'Atlanta', 'GA', '30326', '560'),
]

/**
 * DC-as-store numbers. A DC receives on its own store number, which is how a
 * consolidated shipment is addressed — and it is why the live Exemplar order looked
 * confusing: the NetSuite customer is "EXEMPLAR LUXURY - GLOBAL PNDC - 0077", so
 * store 0077 IS Pinnacle Point, not a shop.
 */
export const DC_STORES = {
  '0072': { name: 'GLOBAL NCDC', dc: '550', banner: 'NM' },
  '0073': { name: 'GLOBAL ECDC', dc: '560', banner: 'SFA' },
  '0074': { name: 'BG HNF ECDC', dc: '560', banner: 'BG' },
  '0077': { name: 'GLOBAL PNDC', dc: '510', banner: 'SFA' },
  '0039': { name: 'PJ CORP WH', dc: null, banner: 'NM' },
}

/** Reporting-only codes: these never receive freight. */
export const REPORTING_ONLY = {
  '0080': 'NM ONLINE — EDI 852 reporting only',
  '0083': 'BG ONLINE — EDI 852 reporting only',
  '0683': 'SAKS.COM — EDI 852 reporting only',
}

const BY_STORE = new Map(STORES.map((s) => [s.store, s]))
const BY_ABBREV = new Map(STORES.filter((s) => s.abbrev).map((s) => [s.abbrev, s]))

const pad4 = (v) => {
  const s = String(v ?? '').trim().toUpperCase()
  if (!s) return ''
  const m = s.match(/^(\d+)([MW]?)$/)
  return m ? m[1].padStart(4, '0') + m[2] : s
}

/** A store by its number, tolerant of missing zero-padding (EDI pads, people don't). */
export function store(num) {
  const p = pad4(num)
  return BY_STORE.get(p) || BY_STORE.get(String(num ?? '').trim()) || null
}

/**
 * ⚠️ THE BRIDGE FROM NETSUITE. NetSuite's customer names end in its own store number
 * and the two-letter abbreviation — "Neiman Marcus - BEVERLY HILLS - 1010 - LA". The
 * ABBREVIATION is the reliable half; the number is NetSuite's, not Exemplar's.
 */
export const storeByAbbrev = (abbrev) => BY_ABBREV.get(String(abbrev ?? '').trim().toUpperCase()) || null

/** The DC that services a store — address included, for the label's ship-to block. */
export function servicingDc(num) {
  const s = store(num)
  if (s) return s.dc ? { ...DCS[s.dc], store: s.store, storeName: s.name, banner: s.banner } : null
  const d = DC_STORES[pad4(num)]
  if (d?.dc) return { ...DCS[d.dc], store: pad4(num), storeName: d.name, banner: d.banner }
  return null
}

/** Every store a DC services, for a consolidated BOL. */
export const storesForDc = (dc) => STORES.filter((s) => s.dc === String(dc).replace(/^0+/, ''))

/**
 * Group packed store quantities by servicing DC.
 * ⚠️ Unknown stores come back named, never folded into whichever DC the rest used.
 */
export function groupByDc(lines = []) {
  const groups = new Map()
  const unknown = []
  for (const l of lines) {
    const dc = servicingDc(l.store)
    if (!dc) { unknown.push(l); continue }
    if (!groups.has(dc.dc)) groups.set(dc.dc, { dc, lines: [], units: 0, stores: new Set() })
    const g = groups.get(dc.dc)
    g.lines.push(l); g.units += Number(l.qty) || 0; g.stores.add(pad4(l.store))
  }
  return {
    groups: [...groups.values()].map((g) => ({ ...g, stores: [...g.stores].sort() }))
      .sort((a, b) => a.dc.dc.localeCompare(b.dc.dc)),
    unknown,
  }
}

/**
 * ⚠️ THE REGISTER OF WHERE NETSUITE DISAGREES, kept because it is the actionable
 * half. Each of these is a NetSuite customer record whose custentity_dc_location
 * sends freight to the wrong building. Measured 2026-09-11 by joining on the
 * abbreviation; `ns` is what NetSuite says, `official` what Exemplar says.
 */
export const NETSUITE_DC_CONFLICTS = [
  ['BH', 'Bal Harbour', '510', '560'], ['AT', 'Atlanta', '510', '560'],
  ['NB', 'Northbrook', '510', '560'], ['WC', 'Westchester', '510', '560'],
  ['OB', 'Oakbrook', '510', '560'], ['MA', 'Michigan Ave', '510', '560'],
  ['TY', 'Tysons Galleria', '510', '560'], ['SH', 'Short Hills', '510', '560'],
  ['DN', 'Denver', '577', '510'], ['PR', 'Paramus', '510', '560'],
  ['KP', 'King of Prussia', '510', '560'], ['TR', 'Troy', '510', '560'],
  ['CG', 'Coral Gables', '510', '560'], ['TB', 'Tampa Bay', '510', '560'],
  ['OR', 'Orlando', '510', '560'], ['BR', 'Boca Raton', '510', '560'],
  ['CH', 'Charlotte', '510', '560'], ['RF', 'Roosevelt Field / Long Island', '510', '560'],
].map(([abbrev, name, ns, official]) => ({ abbrev, name, netsuite: ns, official }))

/**
 * ⚠️ THREE NETSUITE STORES ARE ON NO CURRENT EXEMPLAR LIST. Boston (BN), Ala Moana
 * (AM) and Topanga (TP) are live customers in NetSuite and appear on neither the
 * servicing list nor the EDI codes list. Closed, renamed, or not EDI-enabled — a
 * question for Exemplar, not something to infer. An order to one of these has no
 * verifiable ship-to.
 */
export const NETSUITE_ONLY = [
  { abbrev: 'BN', name: 'Boston', netsuiteStore: '1020' },
  { abbrev: 'AM', name: 'Ala Moana', netsuiteStore: '1031' },
  { abbrev: 'TP', name: 'Topanga', netsuiteStore: '1105' },
]
