// src/model/dc.js — Bloomingdale's distribution-center parsing (Nima,
// 2026-07-21). A fulfilled Bloomingdale's order carries its assigned DC inside
// the ship-to name: "Macy's Inc. : Bloomingdale's DC - Secaucus : Bloomingdale's
// - 0011 Chestnut Hill". We pull the DC out to consolidate a PO's cartons by
// destination — one cargo tag per DC per PO — and abbreviate it to fit a label.
//
// Open (pre-fulfillment) SOs show only the store, no DC, so parseDc returns
// null there; the DC is assigned when the Item Fulfillment is created.

// Nima's warehouse abbreviations (2026-07-21). Bloomingdale's DCs get 2-letter
// codes; Nordstrom DCs are already numeric (DC 584 → "584", FC 569 → "569") so
// they abbreviate to the number itself — no map entry needed.
import { DCS as EXEMPLAR_DC_TABLE } from './exemplarStores.js'

// ⚠️ THIS MAP IS NAME -> CODE, AND IT IS THE WRONG WAY ROUND FOR AN OPEN ORDER.
// It was built from FULFILMENT ship-to strings, which name the DC — so the DC could only
// be known once an IF existed. An open Bloomingdale's SO reads "Bloomingdale's - 0006
// Short Hills": store number, store name, no DC at all.
//
// src/model/macysStores.js now carries Macy's own Store-to-DC listing, which maps the
// STORE NUMBER to the DC code directly and is the file Routing Guide §2.1 (p5) says must
// be used: "Purchase orders will only contain location numbers and quantities."
// Prefer `dcForStore(store)` when you have a store number; this map stays for parsing a
// fulfilment's ship-to, which is a different question.
//
// ⚠️ AND IT IS MISSING TU AND HI, which is a known gap rather than a discovered one. The
// listing shows store 0065 (Bloomies University Village, Seattle) routes to TU and store
// 0947 (Hawaii Pool Stock, c/o Los Angeles) routes to HI. Their DC NAMES and addresses
// are still unknown — the listing gives the store's address, not the DC's — so they are
// deliberately NOT added here with an invented name. See CODES_WITHOUT_ADDRESS.
export const DC_ABBREV = {
  'Secaucus': 'SC',
  'Stone Mountain': 'ST',
  'Joppa': 'JP',
  'Los Angeles': 'CI',
  'Minooka': 'CL',
  'China Grove DC': 'CG',
  'Hayward': 'HA',
}

// Pull the DC out of a ship-to string. Bloomingdale's names it "… DC - Secaucus
// : …"; Nordstrom uses a numeric "… - DC 584 - …" or "… - FC 569 - …".
export function parseDc(customer) {
  const c = customer || ''
  const bloom = c.match(/\bDC\s*-\s*([^:]+?)\s*:/i)
  if (bloom) return bloom[1].trim()
  const nord = c.match(/\b((?:DC|FC)\s*\d+)\b/i)
  if (nord) return nord[1].replace(/\s+/g, ' ').trim()
  return null
}

// Abbreviate a DC: mapped Bloomingdale's name → code; Nordstrom "DC 584"/"FC
// 569" → the number ("584"/"569"); anything else → a derived 2-letter code.
export function dcAbbrev(name) {
  if (!name) return null
  if (DC_ABBREV[name]) return DC_ABBREV[name]
  const num = name.match(/(?:DC|FC)\s*(\d+)/i)
  if (num) return num[1]
  return name.replace(/\bDC\b/i, '').trim().slice(0, 2).toUpperCase()
}

// The per-DC cargo tag's QR payload — carries the PO and DC so a Scan Bay scan
// knows both (Nima, 2026-07-21). `DC:<po>:<abbrev>`; abbrev empty for a PO-level
// (no-DC) tag. Distinct from an IF barcode so custody scanning can branch on it.
export function dcToken(poNumber, abbrev) {
  return `DC:${poNumber || ''}:${abbrev || ''}`
}
export function parseDcToken(s) {
  const m = /^DC:([^:]+):(.*)$/.exec(String(s || '').trim())
  return m ? { poNumber: m[1].trim(), dc: (m[2] || '').trim() || null } : null
}

// Group a PO group's members by DC → [{ dc, abbrev, stores }], sorted biggest
// first. Members with no DC (unfulfilled, or non-Bloomingdale's) collapse into a
// single { dc: null } bucket so the caller can still print one PO-level tag.
export function dcBreakdown(members = []) {
  const byDc = new Map()
  for (const m of members) {
    const dc = parseDc(m.customer)
    const key = dc || ''
    byDc.set(key, (byDc.get(key) || 0) + 1)
  }
  return [...byDc.entries()]
    .map(([dc, stores]) => ({ dc: dc || null, abbrev: dc ? dcAbbrev(dc) : null, stores }))
    .sort((a, b) => b.stores - a.stores)
}

// Reverse of DC_ABBREV — code → friendly DC name. Built once at module load.
const CODE_TO_NAME = Object.fromEntries(Object.entries(DC_ABBREV).map(([name, code]) => [code, name]))

// A human label for a DC *code* (what the EDIPackagesVolume feed carries in
// "PO Number - DC"). Bloomingdale's 2-letter codes map back to their city;
// Nordstrom numeric codes read as "DC 584". Falls back to the code itself.
export function dcLabel(code) {
  const c = String(code || '').trim()
  if (!c) return ''
  if (CODE_TO_NAME[c]) return CODE_TO_NAME[c]
  // ⚠️ AN EXEMPLAR DC IS NAMED, NOT NUMBERED. "DC 0510" on a routing card tells
  // whoever is booking it nothing, and reads exactly like a Nordstrom DC — which is
  // how the mislabel above stayed invisible on screen.
  const ex = EXEMPLAR_DC_TABLE[c] || EXEMPLAR_DC_TABLE[c.replace(/^0+/, '')]
  if (ex) return `${ex.name} (${c})`
  if (/^\d+$/.test(c)) return `DC ${c}`
  return c
}

// Which trading partner a DC code belongs to. Nordstrom's DCs are numeric
// (584/599/569…); Bloomingdale's are our 2-letter warehouse abbreviations. This
// is the one signal the routing rollup needs to split shipments by partner and
// to know Nordstrom needs a unit count in its portal entry (Nima, 2026-07-22).
//
// ⚠️ IT WAS A TWO-WAY TEST, AND THE ELSE BRANCH WAS A GUESS. Anything
// non-numeric fell to Bloomingdale's, so ShopBop's Amazon FC codes — SBX2, SDF4,
// ABE2, PHX3 — came back as Bloomingdale's. That is how BOL NB1731262 was minted
// for ShopBop PO POJ00384244 and stored under Bloomingdale's (found 2026-08-11),
// and it is the same shape as the Macy's auth line that printed on 9 Nordstrom
// BOLs in #79: a default standing in for an answer.
//
// ShopBop's FCs are named explicitly (Vendor Operations Manual §5.4) rather than
// pattern-matched, because a 4-character alphanumeric code is not a signal — the
// next partner's codes would look the same and inherit the wrong name again.
const SHOPBOP_FCS = new Set(['SBX2', 'SDF4', 'ABE2', 'PHX3', 'MSN5'])

// ⚠️ AND "NUMERIC MEANS NORDSTROM" WAS THE SAME GUESS ONE LEVEL UP, WHICH THE
// COMMENT ABOVE PREDICTED IN WRITING: "the next partner's codes would look the same
// and inherit the wrong name again." Exemplar's DCs are 510, 517, 550, 560 and 577 —
// numeric — so PO 8928906 to DC 0510 came back as **Nordstrom**, and the live routing
// feed consolidated it under `Nordstrom|0510` (found 2026-09-14, while wiring the
// Exemplar pre-ship checklist). Routing it as Nordstrom means Nordstrom's BOL,
// Nordstrom's portal and Nordstrom's deadline on freight bound for Exemplar, and the
// Exemplar rules would never be shown for it at all.
//
// Named explicitly, like the ShopBop FCs and for the same reason — and these names
// are DECLARED, not pattern-matched: they come from exemplarStores.DCS, which is read
// from Exemplar's own Store Servicing DC List.
//
// ⚠️ ZERO-PADDED IN EDI, BARE IN THE GUIDE. The 850 carries `0510`; the DC list says
// `510`. Matched both ways, because a lookup that misses falls through to the numeric
// branch and silently says Nordstrom again — which is this bug.
const EXEMPLAR_DCS = new Set(Object.keys(EXEMPLAR_DC_TABLE))

const isExemplarDc = (c) => EXEMPLAR_DCS.has(c) || EXEMPLAR_DCS.has(c.replace(/^0+/, ''))

export function partnerForDc(code) {
  const c = String(code || '').trim()
  if (isExemplarDc(c)) return 'Exemplar'
  if (/^\d+$/.test(c)) return 'Nordstrom'
  if (SHOPBOP_FCS.has(c.toUpperCase())) return 'Shopbop'
  return "Bloomingdale's"
}

// Nordstrom's portal names a supplier PO as "<our PO>-<destination DC>"
// (e.g. "50073677-89" on request 5189002RR000000061). That makes it a real join
// key back to a routing shipment — the Macy's routing emails carry no PO at all,
// so Bloomingdale's can only be matched on DC + recency, while Nordstrom matches
// exactly.
//
// ⚠️ The portal writes the DC UNPADDED ("89") while orders/routing_shipment store
// it padded ("089"), so the DC is returned BOTH ways and the caller can match
// either. Getting this wrong is a silent no-match, the same trap as the
// Macy's abbreviation lookup.
export function parseSupplierPo(supplierPo) {
  const m = String(supplierPo || '').trim().match(/^(\d+)-(\d+)(?:_\d+)?$/)
  if (!m) return null
  const dc = m[2]
  return { poNumber: m[1], dc, dcPadded: dc.padStart(3, '0') }
}
