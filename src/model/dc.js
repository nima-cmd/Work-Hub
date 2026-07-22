// src/model/dc.js — Bloomingdale's distribution-center parsing (Nima,
// 2026-07-21). A fulfilled Bloomingdale's order carries its assigned DC inside
// the ship-to name: "Macy's Inc. : Bloomingdale's DC - Secaucus : Bloomingdale's
// - 0011 Chestnut Hill". We pull the DC out to consolidate a PO's cartons by
// destination — one cargo tag per DC per PO — and abbreviate it to fit a label.
//
// Open (pre-fulfillment) SOs show only the store, no DC, so parseDc returns
// null there; the DC is assigned when the Item Fulfillment is created.

// Nima's warehouse abbreviations (2026-07-21). Hayward has no code yet — add it
// here when Nima gives one; until then it falls back to a derived short code.
export const DC_ABBREV = {
  'Secaucus': 'SC',
  'Stone Mountain': 'ST',
  'Joppa': 'JP',
  'Los Angeles': 'CI',
  'Minooka': 'LC',
  'China Grove DC': 'CG',
}

// Pull the DC name out of a Bloomingdale's ship-to string ("… DC - Secaucus : …").
export function parseDc(customer) {
  const m = (customer || '').match(/\bDC\s*-\s*([^:]+?)\s*:/i)
  return m ? m[1].trim() : null
}

// Abbreviate a DC name; unmapped names derive a 2-letter code so a label never
// breaks (flagged to Nima for a real code).
export function dcAbbrev(name) {
  if (!name) return null
  if (DC_ABBREV[name]) return DC_ABBREV[name]
  const bare = name.replace(/\bDC\b/i, '').trim()
  return bare.slice(0, 2).toUpperCase()
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
