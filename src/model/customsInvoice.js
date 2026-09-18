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

/**
 * ⚠️ THESE TWO CODES ARE A LAST RESORT, AND ON LIVE DATA THEY MATCH ALMOST NOTHING.
 *
 * Measured 2026-09-18 against `weaver_netsuite_item.hts`, which mirrors NetSuite and
 * covers 4,153 of 4,284 items across 22 distinct codes:
 *
 *     bag  '4202221000'  → ZERO items carry it. Real handbags are '4202228100' (1,431).
 *     shoe '6404193760'  → 420 of 2,267 shoes. Most are '6404.20.4060' (1,574).
 *
 * So every bag this app ever declared went out under a code that exists nowhere in the
 * catalogue, and four shoes in five were declared under the wrong one. The codes were
 * entered by hand in 2026-08 as a stand-in, and nothing checked them against the item
 * master — which had them all along.
 *
 * ⚠️ AND TWO CODES CANNOT COVER THIS CATALOGUE. Shoes span SEVEN codes, handbags four,
 * and accessories NINE — including 711719 and 7113.11, which are jewellery. Nima,
 * 2026-09-18: "chelly ... does provide accessories like pendants as well which are
 * totaly different items and have a different code attached". A per-category constant
 * is the wrong shape for the problem; the item knows its own code.
 *
 * Kept only so an item with NO hts on record can still be described — and even then
 * `hsCode` is left NULL rather than filled from here. See hsCodeFor.
 */
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

/**
 * The tariff code for one line — the ITEM'S OWN, never a category default.
 *
 * ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
 * │ Every item in NetSuite carries its own HTS code (the number customs uses to │
 * │ decide the duty). We mirror all of them. This returns that code.            │
 * │                                                                             │
 * │ Until now the app ignored them and stamped one code on every bag and        │
 * │ another on every shoe. Both were wrong: the bag code matches no item at     │
 * │ all, and most shoes are a different code from the one we used.              │
 * │                                                                             │
 * │ If an item has no code on record, this returns NOTHING rather than          │
 * │ guessing. A missing code stops the paperwork and someone fills it in; a     │
 * │ guessed one is a false declaration that nobody ever notices.                │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ FORMATTING IS PRESERVED EXACTLY AS NETSUITE HOLDS IT. The same catalogue stores
 * both '4202228100' and '6404.20.4060' — dotted and undotted. Normalising here would
 * be this app inventing a format for a legal identifier it does not own, and the dots
 * are how a person recognises the code on the DHL form. Compare on digits if you must
 * compare; transmit what the item says.
 */
export function hsCodeFor(line = {}) {
  const hts = String(line.hts ?? '').trim()
  // ⚠️ NO FALLBACK TO HS_CODES. An item with no tariff code on record is a catalogue
  // gap (72 shoes and 5 accessories on 2026-09-18) and must surface as a problem, not
  // be quietly filled from a category constant that is wrong anyway.
  return hts || null
}

/**
 * Decide WHAT to declare: the contents of the box, priced from the order.
 *
 * ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
 * │ A customs form has to answer two different questions, and the answers live  │
 * │ in two different NetSuite records:                                          │
 * │                                                                             │
 * │   WHAT is in the box?   -> the Item Fulfilment (what was actually picked)   │
 * │   WHAT is it worth?     -> the Sales Order (the price the customer pays)    │
 * │                                                                             │
 * │ Before this function, the form was built entirely from the Sales Order. If  │
 * │ you pulled an item out of the shipment, the paperwork still listed it —     │
 * │ declaring goods that were not in the box. This takes the QUANTITIES from    │
 * │ the fulfilment and the PRICES from the order, so the two always agree.      │
 * │                                                                             │
 * │ Nima, 2026-09-18: "lets use that method if possible of IF for units and     │
 * │ sales order for price."                                                     │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * @param priced  [{ item, displayName, qty, rate, coo, weight }] — from the SALES ORDER
 * @param shipped [{ item, qty }] — from the ITEM FULFILMENT
 *
 * ⚠️ AN ITEM IN THE BOX WITH NO PRICE IS A PROBLEM, NOT A ZERO. It cannot be declared
 * at all — a customs line with no value is a false declaration, and defaulting it to 0
 * or to another line's price is exactly the kind of guess that gets a shipment held.
 * It is returned in `unpriced` so the caller can BLOCK the document and name the item.
 *
 * ⚠️ AND AN UNREADABLE FULFILMENT FALLS BACK TO THE ORDER, loudly. If `shipped` is
 * empty we cannot tell "the box is empty" from "NetSuite did not answer" — and emitting
 * a zero-line customs form for a real shipment is far worse than over-declaring. The
 * caller is told the contents were NOT verified (`verified: false`) so the existing
 * "not checked" warning still fires.
 */
export function declarableLines({ priced = [], shipped = [] } = {}) {
  const byItem = new Map()
  for (const l of priced) {
    const k = String(l.item || '').trim()
    if (!k) continue
    // A style can appear on several order lines; the first priced line carries the
    // item's own facts (name, origin, weight) and they do not differ between lines.
    if (!byItem.has(k)) byItem.set(k, l)
  }

  // ⚠️ THE FALLBACK. See the header note — empty means "unread", not "empty box".
  if (!shipped.length) {
    return { lines: priced, excluded: [], unpriced: [], verified: false, source: 'order' }
  }

  const lines = []
  const unpriced = []
  const shippedItems = new Set()
  for (const sLine of shipped) {
    const k = String(sLine.item || '').trim()
    if (!k) continue
    shippedItems.add(k)
    const qty = Number(sLine.qty || 0)
    if (!qty) continue
    const p = byItem.get(k)
    if (!p) {
      // In the box, never priced. Cannot be declared; the caller must not ship on this.
      unpriced.push({ item: k, qty })
      continue
    }
    // ⚠️ QUANTITY FROM THE BOX, EVERYTHING ELSE FROM THE ORDER.
    lines.push({ ...p, item: k, qty })
  }

  // Priced but not shipped — normal for a partial shipment, and simply left off.
  const excluded = [...byItem.values()]
    .filter((l) => !shippedItems.has(String(l.item || '').trim()))
    .map((l) => ({ item: l.item, qty: Number(l.qty || 0), rate: Number(l.rate || 0) }))

  return { lines, excluded, unpriced, verified: true, source: 'fulfilment' }
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100

/**
 * Collapse priced order lines into declarable lines.
 *
 * @param lines [{ item, displayName, qty, rate, coo, weight }]
 */
export function buildCustomsLines(lines = [], opts = {}) {
  // ⚠️ `hsCodes` IS ACCEPTED AND DELIBERATELY UNUSED. It was the category→code map; the
  // code now comes from the item itself (hsCodeFor). The option stays so existing
  // callers do not break, and this note stays so nobody wires it back in believing it
  // is the source of truth. Remove both once no caller passes it.
  const { hsCodes: _unusedHsCodes = HS_CODES } = opts
  const byKey = new Map()
  for (const l of lines) {
    const qty = Number(l.qty || 0)
    if (!qty) continue
    const category = categoryOf(l.item)
    const unitPrice = money(l.rate)
    const coo = (l.coo || '').toUpperCase() || null
    // ⚠️ THE TARIFF CODE JOINS THE KEY, and it is load-bearing for the same reason the
    // country of origin is. Chelly supplies handbags AND pendants; a pendant is 711719
    // and a bag is 4202228100. Two such items at the same price would otherwise collapse
    // into one line and be declared under whichever sorted first — jewellery filed as a
    // handbag, on a form somebody signs. Nima, 2026-09-18: pendants "are totaly
    // different items and have a different code attached".
    const hsCode = hsCodeFor(l)
    const key = `${category}|${unitPrice}|${coo || '?'}|${hsCode || '?'}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        category, unitPrice, coo,
        // ⚠️ THE ITEM'S OWN CODE. `hsCodes` is no longer consulted — see HS_CODES for
        // what the two category constants actually matched on live data (a bag code
        // carried by zero items).
        hsCode,
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
    // ⚠️ NO TARIFF CODE IS THE BLOCKING PROBLEM NOW, and it replaces the category test.
    // "Not a bag or a shoe by item number" was a proxy for "we cannot pick a code"; the
    // real question is simply whether the ITEM has one. 72 shoes and 5 accessories have
    // no hts on record (2026-09-18) — those are catalogue gaps someone must fill, and a
    // line without a code cannot be declared at all.
    if (!l.hsCode) {
      problems.push(`${l.items[0]}: no tariff code (HTS) on the item record — it cannot be declared until one is set in NetSuite`)
    }
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
