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
export const DC_ABBREV = {
  'Secaucus': 'SC',
  'Stone Mountain': 'ST',
  'Joppa': 'JP',
  'Los Angeles': 'CI',
  'Minooka': 'LC',
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
