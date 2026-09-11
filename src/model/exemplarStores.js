// src/model/exemplarStores.js — Exemplar's stores, DCs and who services whom.
//
// Nima, 2026-09-11: "We are providing you everything we have. ... we also need to
// make sure the store names are correct in the system as well."
//
// ── ⚠️ EXEMPLAR IS A NEW ENTITY. THE OLD RECORDS ARE NOT A ROUTING BUG. ─────
//
// Nima, 2026-09-11: "the store number in there are for old neiman marcus and global
// they are a new company we need to only look at the new ones we made its a new
// entity."
//
// He is right, and this corrects an alarm I raised an hour earlier. I had built
// src/model/nmgStores.js from NetSuite's `custentity_dc_location`, found it disagreed
// with the official servicing list on 18 of 33 Neiman stores, and wrote that "freight
// routed on the NetSuite field goes to the wrong building — a refused delivery and a
// chargeback". That conclusion did not survive one query:
//
//   • 32 of the 39 old "Neiman Marcus - …" customers have NEVER had a sales order
//   • the 6 that ever did last ordered 2025-03-11, eighteen months ago
//   • the new entity is TWO records created 2026-09-04, and its only ship-to is
//     "EXEMPLAR LUXURY - GLOBAL PNDC - 0077", dc 0510 — the official numbering
//
// So nothing ships through the old records at all. The disagreement is real and the
// consequence I attached to it was invented: I measured a field, found it wrong, and
// asserted a cost without checking whether anything used it. That is the same
// mistake as reading a permission blind spot as absence — a number that looks alarming
// is still only a number until you ask what depends on it.
//
// ⚠️ WHAT THIS FILE IS FOR, THEREFORE: it is REFERENCE, not the routing authority.
// The documents are Saks-Global-era (the ELG Manual records "formerly Saks Global"),
// and the new entity has one ship-to so far. Use it to validate a store number and to
// look up a DC address for a document; do NOT assume a store here has a live customer
// record, and do not recreate the old numbering anywhere.

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
 * ⚠️ THE STOREFRONT RENAME — a NAME change, not a renumbering.
 *
 * Rohan Fenton, Director EDI, Exemplar Luxury Group, forwarded by Nima 2026-09-11:
 * effective 2026-09-21 the identifier "SAKS GLOBAL" is replaced by "EXEMPLAR LUXURY
 * GROUP" in the REF(19) and MTX segments. Store and DC numbers are untouched, which
 * is why store 0077 is still 0077 on DC 510 — it is the STOREFRONT column of the
 * 2026-04-21 list that changes, and 0073/0077 are the two stores whose storefront
 * reads "SAKS GLOBAL". That is exactly why Nima renamed the NetSuite customer.
 *
 * ⚠️ THE LETTER'S OWN INSTRUCTION IS SELF-CONTRADICTORY AND I AM NOT GUESSING AT IT:
 * "For partners currently utilizing version 5010, please update your systems to
 * reflect this change in the REF(19) and MTX segments for EDI version 4050." It
 * addresses 5010 partners and then names 4050. Both mapping specs are in Drive
 * (saks-edi-5010, saks-edi-4050) and which one Exemplar expects from us is still
 * open — a question for edi@saks.com, not an inference.
 *
 * ⚠️ AND "SAKS OFF 5TH" IS ABSENT FROM THE UPDATED STOREFRONT LIST. The letter names
 * four: Exemplar Luxury Group, Saks Fifth Avenue, Neiman Marcus, Bergdorf Goodman.
 * Twelve O5 stores are on the servicing list. Dropped, folded in, or simply not
 * mentioned — recorded as unknown rather than resolved either way.
 */
export const STOREFRONT_RENAME = {
  from: 'SAKS GLOBAL',
  to: 'EXEMPLAR LUXURY GROUP',
  effective: '2026-09-21',
  segments: ['REF(19)', 'MTX'],
  affectsStores: ['0073', '0077'],
  renumbering: false,
  source: 'Rohan Fenton, Director EDI, Exemplar Luxury Group — notice relayed 2026-09-11',
  contact: 'edi@saks.com',
  updatedStorefrontList: [
    'Exemplar Luxury Group', 'Saks Fifth Avenue', 'Neiman Marcus', 'Bergdorf Goodman',
  ],
  openQuestions: [
    'The notice addresses 5010 partners but names the 4050 segments — which version does Exemplar expect from us?',
    'Saks OFF 5th is not on the updated storefront list, yet 12 O5 stores are on the servicing list.',
  ],
}

/** The storefront name to put in REF(19)/MTX for a date. */
export function storefrontFor(store, on = new Date().toISOString().slice(0, 10)) {
  const s = STOREFRONT_RENAME.affectsStores.includes(pad4(store))
  if (!s) return null
  return on >= STOREFRONT_RENAME.effective ? STOREFRONT_RENAME.to : STOREFRONT_RENAME.from
}

/**
 * THE distribution centres — the single address source for every Exemplar document.
 *
 * ⚠️ THERE WERE TWO OF THESE AND THEY DISAGREED ON ALL SEVEN ENTRIES. saksRouting.js
 * had its own DCS transcribed from the Routing Guide's prose, and the carton label
 * imported THAT one. Compared against the dedicated DC list of 2026-04-21:
 *
 *   510  "4123 Pinnacle Point Dr"      → "4123 Pinnacle Point"      (no "Dr")
 *   517  "2500 Workman Mill Road"      → "2500 S Workman Mill"      (missing "S")
 *   577  same                          → same
 *   560  "600 Research Dr, Pittston"   → "600-620 Research Drive,
 *                                         CenterPoint Commerce & Trade Park,
 *                                         Pittston Township"        (materially short)
 *   072  keyed as a DC                 → 072 is a STORE; the DC is 550
 *   694  keyed as a DC                 → 694 is a STORE whose DC is N/A
 *
 * A carton label carrying an incomplete consignee is fee 55/355, "No/incorrect
 * format — DC, Dept or Suite # on GS1 or carton", $10 per carton / $250 minimum.
 * saksRouting.js now derives its table from this one, so there is one place to fix.
 *
 * ⚠️ 517 AND 577 ARE THE SAME BUILDING WITH DIFFERENT DC NUMBERS. 2500 S Workman
 * Mill, Whittier is DC 517 for the Saks banners and DC 577 for Neiman. The number is
 * per banner, not per address, so a Neiman carton labelled 517 is mis-routed inside
 * a warehouse that did receive it.
 *
 * Addresses from the EDI Store and DC codes list (2026-04-21). The operational
 * fields — receiving hours, how to book, the notes — are from the Routing Guide
 * rev 11, which is the only source for them.
 */
export const DCS = {
  510: {
    dc: '510', name: 'PNDC', abbrev: 'PNDC',
    street: '4123 Pinnacle Point', city: 'Dallas', state: 'TX', zip: '75211',
    receiving: 'Tue-Fri 6:30 AM - 3:30 PM',
    appointment: 'Conduit (scheduling link in the guide)',
    // ⚠️ Jewellery goes to Suite J at the same address — a different dock, same code.
    jewelleryStreet: '4123 Pinnacle Point Suite J',
    guidePage: 4,
  },
  517: {
    dc: '517', name: 'SAKS WCSC', abbrev: 'WCSC', banners: ['SFA', 'O5'],
    street: '2500 S Workman Mill', city: 'Whittier', state: 'CA', zip: '90601',
    receiving: 'Mon-Fri 10:00 AM - 5:00 PM',
    // ⚠️ The only DC that says delivery is REFUSED without a TMS routing, in writing.
    appointment: 'No appointment needed IF the PO is routed in Dynamic TMS — delivery is REJECTED if it is not',
    guidePage: 5,
  },
  550: {
    dc: '550', name: 'NCDC', abbrev: 'WH4',
    street: '115 Morrison Ave', city: 'Thomasville', state: 'NC', zip: '27360',
    receiving: 'Mon-Fri 7:30 AM - 3:30 PM',
    appointment: 'Email NMtickets@sun-wd.com',
    // ⚠️ NCDC bypasses the TMS entirely — keyed as a special order (guide p18).
    note: 'POs for NCDC ship direct without the TMS or DTS approval. Its STORE number is 0072; the DC number is 550.',
    guidePage: 5,
  },
  560: {
    dc: '560', name: 'ECDC', abbrev: 'ECDC',
    street: '600-620 Research Drive', street2: 'CenterPoint Commerce & Trade Park',
    city: 'Pittston Township', state: 'PA', zip: '18640',
    receiving: 'Mon-Fri 7 AM - 3:30 PM',
    appointment: 'Conduit',
    note: 'Also the Bergdorf Goodman DC. Services 42 of the 67 stores.',
    guidePage: 4,
  },
  577: {
    dc: '577', name: 'NM WCSC', abbrev: 'WCSC', banners: ['NM'],
    street: '2500 S Workman Mill', city: 'Whittier', state: 'CA', zip: '90601',
    receiving: 'Mon-Fri 3:00 AM - 3:30 PM',
    appointment: 'Email SG-Transportation@saks.com, subject "Delivery Apt Request"',
    guidePage: 4,
  },
}

/** The consignee block for a label or a BOL, as lines. */
export function dcAddressLines(code) {
  const d = DCS[String(code ?? '').replace(/^0+/, '')]
  if (!d) return null
  return [d.street, d.street2, `${d.city}, ${d.state} ${d.zip}`].filter(Boolean)
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
 * ⚠️ DORMANT LEGACY RECORDS, NOT LIVE MIS-ROUTING. The old "Neiman Marcus - …"
 * customers carry a custentity_dc_location that disagrees with the official
 * servicing list, and NONE of them is in use: 32 have never had a sales order and
 * the rest stopped 2025-03-11. Kept only so that if anyone ever reactivates one,
 * the disagreement is already on the record — and so my original framing of this as
 * a live chargeback risk is corrected in the place it was made.
 *
 * `netsuite` is the legacy value, `official` what the 2026-06-10 list says.
 */
export const LEGACY_DC_DISAGREEMENTS = [
  ['BH', 'Bal Harbour', '510', '560'], ['AT', 'Atlanta', '510', '560'],
  ['NB', 'Northbrook', '510', '560'], ['WC', 'Westchester', '510', '560'],
  ['OB', 'Oakbrook', '510', '560'], ['MA', 'Michigan Ave', '510', '560'],
  ['TY', 'Tysons Galleria', '510', '560'], ['SH', 'Short Hills', '510', '560'],
  ['DN', 'Denver', '577', '510'], ['PR', 'Paramus', '510', '560'],
  ['KP', 'King of Prussia', '510', '560'], ['TR', 'Troy', '510', '560'],
  ['CG', 'Coral Gables', '510', '560'], ['TB', 'Tampa Bay', '510', '560'],
  ['OR', 'Orlando', '510', '560'], ['BR', 'Boca Raton', '510', '560'],
  ['CH', 'Charlotte', '510', '560'], ['RF', 'Roosevelt Field / Long Island', '510', '560'],
].map(([abbrev, name, ns, official]) => ({ abbrev, name, netsuite: ns, official, live: false }))

/**
 * ⚠️ THREE OLD RECORDS ARE ON NO CURRENT EXEMPLAR LIST. Boston (BN), Ala Moana (AM)
 * and Topanga (TP) exist as legacy NetSuite customers and appear on neither
 * document. Boston and Topanga are two of the six that ever shipped, both last on
 * 2025-03-11. Closed, renamed, or never carried over to the new entity — a question
 * for Exemplar, not something to infer.
 */
export const LEGACY_ONLY = [
  { abbrev: 'BN', name: 'Boston', netsuiteStore: '1020' },
  { abbrev: 'AM', name: 'Ala Moana', netsuiteStore: '1031' },
  { abbrev: 'TP', name: 'Topanga', netsuiteStore: '1105' },
]


/**
 * ⚠️ THE NEW ENTITY, AS IT ACTUALLY EXISTS IN NETSUITE — measured 2026-09-11.
 *
 * This is the list Nima means by "the new ones we made". It is very short, and that
 * is the point: anything routed to Exemplar today goes to ONE ship-to. A second
 * destination needs a customer record that does not exist yet, so an order for one
 * would be a question, not a lookup.
 */
export const LIVE_ENTITY = {
  name: 'Exemplar Luxury Group',
  formerly: 'Saks Global',
  createdInNetSuite: '2026-09-04',
  parentCustomer: { entityid: '539', name: 'Exemplar Luxury Group' },
  shipTos: [
    { entityid: '541', name: 'EXEMPLAR LUXURY - GLOBAL PNDC - 0077', store: '0077', dc: '510', salesOrders: 1 },
  ],
  // ⚠️ Legacy records are NOT part of this entity. 39 "Neiman Marcus - …" customers
  // remain active-but-unused in NetSuite; see LEGACY_DC_DISAGREEMENTS.
  legacyCustomers: 39,
}

/** Is this store number one the new entity can actually ship to today? */
export function isLiveShipTo(num) {
  const p = pad4(num)
  return LIVE_ENTITY.shipTos.some((s) => s.store === p)
}
