// src/model/packingSlip.js — a factory packing slip, read twice.
//
// ── ⚠️ WHY IT PRODUCES TWO SHAPES ────────────────────────────────────────────
//
// Nima, 2026-09-09: "We dont care what units are in a box in our import file but
// the app does need to know what po whta units are in what box."
//
// One pass, two consumers, and they want different things:
//
//   skuTotals[]  PO + SKU + total units      → the NetSuite Item Receipt / Transfer
//   cartons{}    PO → box N → [{sku, qty}]   → the warehouse app's bin map and search
//
// Collapsing either into the other loses something real: the import must not care
// which carton a unit sat in, and the floor cannot find a bag without knowing.
//
// ── ⚠️ THE UNITS COME FROM PACK/CTN, NEVER FROM THE QUTY TOTAL ───────────────
//
// A slip's last row is a GRAND TOTAL — carton count in `CTNS`, unit count in
// `QUTY`, and no style. Because merged cells are filled downward, that row inherits
// the style above it and looks like a real line. Reading units from `QUTY` would
// therefore double every container. Reading `PACK/CTN` × carton count cannot,
// because the totals row leaves PACK/CTN empty. That is not a lucky accident to
// preserve by chance — it is the invariant, so it is stated here and tested.
//
// ⚠️ THE SAME TRAP CATCHES THE CARTON TALLY, AND IN THE ORIGINAL IT WAS NOT
// GUARDED. Measured 2026-09-09 against two real slips: Naghedi-Warehouse's parser
// reports 110 cartons for a 55-carton container and 22 for an 11-carton air
// shipment — exactly double, because the totals row's own count is added to the
// sum of the parts. Its box CONTENTS are correct (they are built from the CTNS
// NO. ranges and protected by the PACK/CTN test), so only the summary figure is
// wrong. Here the same test guards both.
//
// ── provenance ───────────────────────────────────────────────────────────────
//
// Ported from Naghedi-Warehouse `src/services/packingSlip.js`, which was itself
// derived from Bita's standalone script. ⚠️ Verified before porting: on the two
// slips in test/fixtures, that parser and Bita's independent CSVs agree on every
// PO+SKU quantity — 44 rows / 1,439 units and 4 rows / 150 units, ZERO
// differences. Two implementations written separately agreeing on unseen files is
// why this is a lift rather than a rewrite.
//
// ⚠️ PURE ON PURPOSE. Rows in, container out — no xlsx, no DOM, no network, so it
// is testable against real fixtures. The file reading lives in
// src/ingest/packingSlipFile.js.

/** Colour as it appears in a SKU: upper-case, spaces to hyphens. */
export const colorToSku = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '-')

const SHOE_SIZES = ['35', '35.5', '36', '36.5', '37', '37.5', '38', '38.5', '39', '39.5', '40', '41']

const txt = (v) => String(v ?? '').trim()

/**
 * "3-6" → [3,4,5,6] · "11" → [11] · "" → []
 *
 * ⚠️ A RANGE IS CARTONS, NOT A QUANTITY. `CTNS NO.` "3-6" with PACK/CTN 11 means
 * four cartons each holding eleven — 44 units, and four separate boxes on the
 * floor. Treating the range as one box loses three of them.
 */
export function expandRange(ctnsStr) {
  const s = txt(ctnsStr)
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (range) {
    const a = parseInt(range[1], 10)
    const b = parseInt(range[2], 10)
    // The 500 ceiling is a typo guard: "3-6000" is a mis-key, not a container.
    if (b >= a && b - a < 500) return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  }
  const single = parseInt(s, 10)
  return Number.isNaN(single) ? [] : [single]
}

/** Is this a raw factory slip? Its column A header says OFFICE.NO. */
export const isRawFactorySlip = (rows = []) =>
  rows.slice(0, 25).some((r) => txt(r?.[0]).toUpperCase().includes('OFFICE'))

/**
 * Is this the master packing list — the already-broken-down form?
 *
 * That is what Bita's script emits and what the reference CSVs are: one row per
 * PO+SKU with a total. It carries no cartons at all, which is why importing one
 * can feed the NetSuite side but never the bin map.
 */
export const isMasterPackingList = (rows = []) =>
  rows.slice(0, 10).some((r) => {
    const hdr = (r || []).map((c) => txt(c).toUpperCase())
    return hdr.includes('SKU') && hdr.some((h) => h.includes('TOTAL UNITS') || h === 'UNITS' || h === 'QTY' || h === 'QUANTITY' || h.includes('TOTAL QTY'))
  })

// Column indexes on a raw factory slip, from the OFFICE.NO. header row.
const COL = { po: 0, customer: 1, cartonRange: 2, cartonCount: 3, style: 4, color: 6, packPerCtn: 7 }

/**
 * Parse a raw factory slip.
 *
 * @param rows  2-D array of cell values (strings), sheet order
 * @param opts.containerNum  the label, e.g. "55 Container 2026.9.7"
 * @param opts.containerDate optional, for the id
 * @returns { containerNum, poNumbers, skuTotals, cartons, poMeta, cartonCount, unitCount, skipped }
 */
/**
 * ⚠️ NON-MERCHANDISE SLIP LINES — accessories that travel WITH a bag.
 *
 * Nima, 2026-09-11, on container "59 cartons LCL to LA": "firstly the strap shouldn't
 * be counted its not a real item." The slip carried "straps-CHOCOLATE", 5 units
 * against PO1758. Nothing was purchased, so the PO has no line for it; the importer
 * already kept it off both CSVs, but it was still in the headline unit count, which
 * is what made it look like cargo.
 *
 * ⚠️ A BLANKET "ANYTHING WITH STRAP" RULE WOULD LOSE REAL STOCK. NetSuite holds 32
 * REAL strap items — STRAP-PETIT-CASHMERE, STRAP-SMALL-ONYX and the rest, all
 * Inventory Items that can be ordered and received like anything else.
 *
 * The distinction is the whole rule, and it is precise:
 *   straps-CHOCOLATE       plural, no size  -> accessory, excluded
 *   STRAP-PETIT-CASHMERE   singular, sized  -> stock, kept
 *   STRAP-SMALL-ONYX       singular, sized  -> stock, kept
 *
 * Anchored on the WHOLE sku, never a substring, so "STRAPS" inside a longer style
 * code cannot trigger it.
 */
export const NON_MERCHANDISE = [
  { test: /^straps-[a-z0-9-]+$/i, what: 'straps packed with a bag, not a purchased line' },
]

export function isNonMerchandise(sku) {
  const s = String(sku ?? '').trim()
  // A sized strap is real stock and is never excluded, whatever else matches.
  if (/^strap-(petit|small)-/i.test(s)) return false
  return NON_MERCHANDISE.some((r) => r.test.test(s))
}

const splitMerchandise = (rows = []) => ({
  merchandise: rows.filter((r) => !isNonMerchandise(r.sku)),
  nonMerch: rows.filter((r) => isNonMerchandise(r.sku)),
})

export function parseRawFactorySlip(rows = [], { containerNum, containerDate = null } = {}) {
  const headerIdx = rows.findIndex((r) => txt(r?.[0]).toUpperCase().includes('OFFICE'))
  if (headerIdx === -1) {
    throw new Error('Not a factory packing slip: no "OFFICE" header in column A.')
  }
  // Data starts two rows below: the row between is the Chinese sub-header, which on
  // a shoe slip also carries the size columns.
  const dataStart = headerIdx + 2
  const grid = rows.map((r) => (r || []).slice())

  // ⚠️ SNAPSHOT THE CARTON COUNT BEFORE FILLING DOWN. Each carton's count sits on
  // its first row only; a mixed-carton continuation row leaves it blank. Fill it
  // down and every continuation row claims the same cartons again.
  const rawCartonCount = grid.map((r) => txt(r[COL.cartonCount]))

  // Merged cells carry no value except in their top-left, so fill down the columns
  // a continuation row legitimately inherits.
  for (const c of [COL.po, COL.customer, COL.cartonRange, COL.cartonCount, COL.style, COL.color]) {
    let last = ''
    for (const row of grid) {
      const v = txt(row[c])
      if (v === '') {
        // A slip that puts the order name in column B and nothing in A: take B as
        // the PO rather than leaving the line unattributed.
        if (c === COL.po && last === '' && txt(row[COL.customer]) !== '') last = txt(row[COL.customer])
        row[c] = last
      } else last = v
    }
  }

  // Shoe slips put size headers on the sub-header row; bags do not.
  const sub = grid[headerIdx + 1] || []
  const shoeCols = []
  const firstSize = sub.findIndex((c) => txt(c) === '35')
  if (firstSize !== -1) {
    for (let i = firstSize; i < sub.length; i++) {
      const c = txt(sub[i])
      if (!SHOE_SIZES.includes(c)) break
      shoeCols.push({ size: c, colIdx: i })
    }
  }
  // When column H is itself a size header the units column sits past the sizes.
  const unitsCol = SHOE_SIZES.includes(txt(sub[COL.packPerCtn]))
    ? COL.packPerCtn + shoeCols.length
    : COL.packPerCtn

  const totals = new Map()      // `po|sku` → units
  const meta = {}               // po → { cartons, memo }
  const boxesByPo = {}          // po → Map(boxNumber → Map(sku → qty))
  const skipped = []            // rows carrying a quantity but no style

  for (let i = dataStart; i < grid.length; i++) {
    const row = grid[i]
    const po = txt(row[COL.po])
    const style = txt(row[COL.style])
    const color = txt(row[COL.color])
    const cartonsOnRow = row[COL.cartonCount] ? Number(row[COL.cartonCount]) || 1 : 1

    if (/cancel/i.test(po)) continue               // cancelled production never arrives
    if (style.toLowerCase() === 'paper') continue  // packing material, not product
    // ⚠️ A PURELY NUMERIC "STYLE" IS FOOTER LEAKAGE. Customs and weight rows land in
    // the style column as bare numbers (79.85, 82.95). Real styles are SN…/NS….
    if (/^[\d.]+$/.test(style)) continue
    if (!style) {
      const q = Number(row[unitsCol]) || 0
      // Surfaced rather than dropped: a quantity with no style is either a slip
      // error or a format we do not read, and silence would hide both.
      if (q > 0) skipped.push({ color, qty: q * cartonsOnRow, reason: 'no style on row' })
      continue
    }

    const perCarton = Number(row[unitsCol]) || 0

    // ⚠️ THE TOTALS-ROW GUARD, and the whole reason the carton tally is trustworthy
    // here. A grand-total row has a carton count and no PACK/CTN. Requiring
    // PACK/CTN before counting anything means it can contribute neither units nor
    // cartons. Without this the 55-carton container reports 110.
    if (perCarton <= 0 && shoeCols.length === 0) continue

    const m = (meta[po] ??= { cartons: 0, memo: '' })
    const own = parseInt(rawCartonCount[i], 10)
    if (Number.isInteger(own) && String(own) === rawCartonCount[i] && own > 0) m.cartons += own
    if (!m.memo) {
      const cust = txt(row[COL.customer])
      if (cust && cust !== po) m.memo = cust
    }

    const boxNums = expandRange(row[COL.cartonRange])
    const addToBoxes = (skuVal, qtyPerCarton) => {
      if (qtyPerCarton <= 0 || boxNums.length === 0) return
      const poBoxes = (boxesByPo[po] ??= new Map())
      for (const bn of boxNums) {
        const box = poBoxes.get(bn) ?? new Map()
        box.set(skuVal, (box.get(skuVal) ?? 0) + qtyPerCarton)
        poBoxes.set(bn, box)
      }
    }
    const bump = (skuVal, n) => totals.set(`${po}|${skuVal}`, (totals.get(`${po}|${skuVal}`) ?? 0) + n)

    const colorSku = colorToSku(color)
    if (style.toUpperCase().startsWith('NS') && shoeCols.length > 0) {
      for (const { size, colIdx } of shoeCols) {
        const qty = Number(row[colIdx]) || 0
        if (qty <= 0) continue
        // 37 → 370, 36.5 → 365 — the size as NetSuite spells it in a SKU.
        const n = parseFloat(size)
        const sizePart = Number.isNaN(n) ? size : String(Math.round(n * 10))
        const skuVal = `${style}-${colorSku}-${sizePart}`
        bump(skuVal, qty * cartonsOnRow)
        addToBoxes(skuVal, qty)
      }
    } else {
      const skuVal = `${style}-${colorSku}`
      bump(skuVal, perCarton * cartonsOnRow)
      addToBoxes(skuVal, perCarton)
    }
  }

  // ── ⚠️ NON-MERCHANDISE SLIP LINES ─────────────────────────────────────────
  //
  // Nima, 2026-09-11, on container "59 cartons LCL to LA": "firstly the strap
  // shouldn't be counted its not a real item."
  //
  // The factory slip lists accessories that travel WITH a bag — a "straps-CHOCOLATE"
  // line of 5 units against PO1758. Nothing was purchased, so the PO has no line for
  // it, and the importer correctly kept it off both CSVs. It was still counted in the
  // headline units, which is what made it look like cargo.
  //
  // ⚠️ AND A BLANKET "ANYTHING WITH STRAP" RULE WOULD BE WRONG. NetSuite holds 32
  // REAL strap items — STRAP-PETIT-CASHMERE, STRAP-SMALL-ONYX and so on, all
  // Inventory Items — which can be ordered and received like anything else. Dropping
  // those silently would lose real stock.
  //
  // The distinction is precise and is the whole rule: a real strap SKU is SINGULAR
  // and SIZED (STRAP-PETIT-*, STRAP-SMALL-*); the slip's accessory line is PLURAL
  // with no size (straps-<colour>). Only the second is excluded.
  const skuTotals = [...totals.entries()]
    .map(([key, units]) => {
      const [po, sku] = key.split('|')
      const dash = sku.indexOf('-')
      return { poNumber: po || null, sku, style: sku.slice(0, dash), color: sku.slice(dash + 1), units }
    })
    .filter((r) => r.units > 0)
    .sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || '') || a.sku.localeCompare(b.sku))

  const cartons = {}
  for (const [po, poBoxes] of Object.entries(boxesByPo)) {
    cartons[po] = [...poBoxes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([box, items]) => ({
        box,
        items: [...items.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([sku, qty]) => ({ sku, qty })),
      }))
  }

  const poMeta = Object.fromEntries(
    Object.entries(meta).map(([po, m]) => [po, { cartons: m.cartons || null, memo: m.memo || null }]),
  )

  const { merchandise, nonMerch } = splitMerchandise(skuTotals)

  return {
    id: `cnt-${containerNum}${containerDate ? `-${String(containerDate).replace(/[^0-9]/g, '')}` : ''}`,
    containerNum: String(containerNum ?? ''),
    containerDate: containerDate ?? null,
    // ⚠️ POs come from MERCHANDISE only. An accessory-only PO would otherwise appear
    // on the container as a PO we are receiving against, with nothing to receive.
    poNumbers: [...new Set(merchandise.map((r) => r.poNumber).filter(Boolean))],
    // ⚠️ skuTotals carries MERCHANDISE ONLY — the CSVs, the unit count and the
    // over-receive check all read it. Accessory lines are reported separately so
    // they are visible rather than silently dropped.
    skuTotals: merchandise,
    nonMerchandise: nonMerch,
    cartons,
    poMeta,
    cartonCount: Object.values(poMeta).reduce((n, m) => n + (m.cartons ?? 0), 0),
    unitCount: merchandise.reduce((n, r) => n + r.units, 0),
    nonMerchandiseUnits: nonMerch.reduce((n, r) => n + r.units, 0),
    boxCount: Object.values(cartons).reduce((n, l) => n + l.length, 0),
    skipped,
  }
}

/**
 * Parse a master packing list — the already-aggregated form Bita's script emits.
 *
 * ⚠️ IT CARRIES NO CARTONS, and that absence is the point. This form can feed the
 * NetSuite import and can NEVER feed the bin map, so `cartons` is empty rather
 * than guessed. A caller that needs boxes has to read the factory slip.
 */
export function parseMasterPackingList(rows = [], { containerNum, containerDate = null } = {}) {
  const headerIdx = rows.findIndex((r) => (r || []).map((c) => txt(c).toUpperCase()).includes('SKU'))
  if (headerIdx === -1) throw new Error('Not a master packing list: no SKU column.')
  const hdr = (rows[headerIdx] || []).map((c) => txt(c).toUpperCase())
  const at = (...names) => hdr.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const iPo = at('PO NUMBER', 'PO')
  const iSku = hdr.indexOf('SKU')
  const iStyle = at('STYLE')
  const iColor = at('COLOR')
  const iUnits = at('TOTAL UNITS', 'UNITS', 'TOTAL QTY', 'QTY', 'QUANTITY')

  const skuTotals = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || []
    const sku = txt(r[iSku])
    const units = Number(txt(r[iUnits])) || 0
    if (!sku || units <= 0) continue
    skuTotals.push({
      poNumber: iPo >= 0 ? txt(r[iPo]) || null : null,
      sku,
      style: iStyle >= 0 ? txt(r[iStyle]) : sku.split('-')[0],
      color: iColor >= 0 ? txt(r[iColor]) : null,
      units,
    })
  }
  const { merchandise, nonMerch } = splitMerchandise(skuTotals)

  return {
    id: `cnt-${containerNum}${containerDate ? `-${String(containerDate).replace(/[^0-9]/g, '')}` : ''}`,
    containerNum: String(containerNum ?? ''),
    containerDate: containerDate ?? null,
    // ⚠️ POs come from MERCHANDISE only. An accessory-only PO would otherwise appear
    // on the container as a PO we are receiving against, with nothing to receive.
    poNumbers: [...new Set(merchandise.map((r) => r.poNumber).filter(Boolean))],
    // ⚠️ skuTotals carries MERCHANDISE ONLY — the CSVs, the unit count and the
    // over-receive check all read it. Accessory lines are reported separately so
    // they are visible rather than silently dropped.
    skuTotals: merchandise,
    nonMerchandise: nonMerch,
    cartons: {},
    poMeta: {},
    cartonCount: null,
    unitCount: merchandise.reduce((n, r) => n + r.units, 0),
    nonMerchandiseUnits: nonMerch.reduce((n, r) => n + r.units, 0),
    boxCount: 0,
    skipped: [],
  }
}

/** Pick the parser by shape. Factory slip first — it is the richer document. */
export function parsePackingSlip(rows = [], opts = {}) {
  if (isRawFactorySlip(rows)) return { format: 'factory', ...parseRawFactorySlip(rows, opts) }
  if (isMasterPackingList(rows)) return { format: 'master', ...parseMasterPackingList(rows, opts) }
  throw new Error('Unrecognised packing slip: neither an OFFICE.NO. factory slip nor a SKU/Total Units master list.')
}
