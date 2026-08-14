// src/model/customsInvoice.js — the commercial-invoice lines for an international
// shipment, in the shape DHL and UPS each ask for.
//
// Nima, 2026-08-14: "for IF7450 i need to make a DHL label and i need customs
// information per item ... Theres a tool in netsuite that creates the UPS commercial
// invoice for international shipments within UPS i need something like that here."
//
// ── The grouping rule is his, verbatim ──────────────────────────────────────
//
// "we dont need to list things by their SKU in our system if multiple bags have the
//  same price they can be counted together same for shoe, we cant mix a shoe and bag
//  that have the same price together when filling in the documentation and these
//  items would have their own line."
//
// So the line key is (category, unit price) — NOT the SKU. Live example, IF7508: at
// $114 there are 9 St. Barths Small Totes across three colours plus 4 Soho Envelope
// Crossbodies. All bags, same price, so ONE line of 13. A shoe at $114 would get its
// own line even though the price matches.
//
// ⚠️ Country of origin joins the key too. It is CN on 4,119 of 4,127 items so it will
// almost never split a line — but a customs declaration that averages two origins is
// a false declaration, and "it never happens" is not a reason to make it possible.

/** Nima's tariff codes, 2026-08-14. */
export const HS_CODES = { bag: '4202221000', shoe: '6404193760' }
/** Naghedi's tax ID — the UPS form's "Manufacturer's ID". */
export const TAX_ID = '850727470'

// ⚠️ Categories come from the ITEM NUMBER PREFIX, which is the only mechanical signal
// available: NetSuite's `class` is EMPTY on all 4,127 items and there is no category
// custom field. Measured 2026-08-14: NS = 2,232 items, SN = 1,699, and a cross-check
// for bag words on NS items and shoe words on SN items returned ZERO crossovers.
//
// ⚠️ ~196 items carry neither prefix (CC, ST, WN, SS, TL…). Those are UNKNOWN and get
// NO HS code — never a defaulted one. A wrong tariff code is a penalty and a held
// shipment, so this refuses to guess and says which lines need a human instead.
export function categoryOf(itemId) {
  const p = String(itemId || '').slice(0, 2).toUpperCase()
  if (p === 'SN') return 'bag'
  if (p === 'NS') return 'shoe'
  return 'unknown'
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100

/**
 * Collapse priced order lines into declarable lines.
 *
 * @param lines [{ item, displayName, qty, rate, coo, weight }]
 */
export function buildCustomsLines(lines = [], opts = {}) {
  const { hsCodes = HS_CODES } = opts
  const byKey = new Map()
  for (const l of lines) {
    const qty = Number(l.qty || 0)
    if (!qty) continue
    const category = categoryOf(l.item)
    const unitPrice = money(l.rate)
    const coo = (l.coo || '').toUpperCase() || null
    const key = `${category}|${unitPrice}|${coo || '?'}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        category, unitPrice, coo,
        hsCode: hsCodes[category] || null,
        qty: 0, weightLb: 0, items: [], names: [],
      })
    }
    const g = byKey.get(key)
    g.qty += qty
    // ⚠️ Weight is per ITEM, so the line's weight is qty x each — not the item's
    // weight, which is what a careless read would put on the form.
    g.weightLb += qty * Number(l.weight || 0)
    g.items.push(l.item)
    // The product NAME without its colour: the declaration describes goods, not
    // merchandising variants, and "St. Barths Small Tote" is the honest description
    // of nine bags in three colours.
    const base = String(l.displayName || l.item || '').split('|')[0].trim()
    if (base && !g.names.includes(base)) g.names.push(base)
  }

  const out = [...byKey.values()].map((g) => ({
    ...g,
    weightLb: round2(g.weightLb),
    lineTotal: round2(g.qty * g.unitPrice),
    // No weight recorded anywhere in the group is a gap, not a zero.
    missingWeight: g.weightLb === 0,
    description: describeLine(g),
  }))
  // Heaviest value first — the way a customs form is usually read and checked.
  out.sort((a, b) => b.lineTotal - a.lineTotal)

  const problems = []
  for (const l of out) {
    if (l.category === 'unknown') problems.push(`${l.items[0]}: not a bag or a shoe by item number — needs an HS code by hand`)
    if (!l.coo) problems.push(`${l.items[0]}: no country of origin on the item record`)
    if (l.missingWeight) problems.push(`${l.items[0]}: no weight on the item record`)
  }

  return {
    lines: out,
    totalQty: out.reduce((n, l) => n + l.qty, 0),
    totalValue: round2(out.reduce((n, l) => n + l.lineTotal, 0)),
    totalWeightLb: round2(out.reduce((n, l) => n + l.weightLb, 0)),
    taxId: TAX_ID,
    // ⚠️ Never let a form print while a line is unclassified. Surfaced, not thrown —
    // the rest of the document is still useful for checking against.
    problems,
    ready: problems.length === 0,
  }
}

/**
 * The goods description. ⚠️ UPS caps this at 70 characters, so it is built to fit
 * rather than truncated after the fact — a description cut mid-word reads as a
 * mistake to a customs officer.
 */
export function describeLine(g, max = 70) {
  const kind = g.category === 'shoe' ? 'Footwear' : g.category === 'bag' ? 'Handbag' : 'Goods'
  const names = g.names.join(', ')
  const full = names ? `${kind} - ${names}` : kind
  if (full.length <= max) return full
  // Drop names one at a time rather than slicing mid-word.
  for (let i = g.names.length - 1; i > 0; i--) {
    const t = `${kind} - ${g.names.slice(0, i).join(', ')}`
    if (t.length <= max - 6) return `${t} etc.`
  }
  return `${kind} - ${g.names[0] || ''}`.slice(0, max).trim()
}

// ── The two carrier shapes ──────────────────────────────────────────────────
// Column names and order are taken from the actual forms Nima screenshotted, so a
// row can be typed or pasted straight across without re-reading which field is which.

export const DHL_COLUMNS = [
  'Product Name', 'HS/HTS Code', 'Country of Origin', 'Weight (lbs)',
  'Qty Units', 'Unit Price', 'Description',
]
export const UPS_COLUMNS = [
  'Description', 'Schedule B', 'Manufacturer ID', 'Quantity', 'Units',
  'Value (Per Item)', 'Weight (Per Item)', 'Country of Manufacture',
]

export function toDhlRows(built) {
  return built.lines.map((l) => [
    l.names[0] || l.items[0], l.hsCode || '', l.coo || '',
    l.weightLb, l.qty, l.unitPrice, l.description,
  ])
}

export function toUpsRows(built) {
  return built.lines.map((l) => [
    l.description, l.hsCode || '', built.taxId, l.qty, 'Pieces',
    l.unitPrice,
    // ⚠️ UPS asks for weight PER ITEM where DHL asks for the line total. Handing the
    // same number to both would overstate every UPS line by the quantity.
    l.qty ? round2(l.weightLb / l.qty) : 0,
    l.coo || '',
  ])
}

const cell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
export function toCsv(columns, rows) {
  return [columns.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n'
}
