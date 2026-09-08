// src/model/pickStock.js — what stock a bulk pick ticket has to draw on, and whether
// the run is actually short.
//
// ── ⚠️ THE MEASURE IS ON HAND, AND THAT IS A DECISION, NOT A DEFAULT ─────────
//
// NetSuite offers two numbers per item-location. `quantityavailable` subtracts what is
// already committed; `quantityonhand` is the physical count. The obvious choice is
// available — and it is the wrong one here, for a reason Nima named on 2026-09-01:
//
//   "on hand would be equal to or greater than what's on order in cases where we have
//    units, so when on hand is less than the units needed we truly know it's short,
//    because if the sales order exists it's a good chance the units are allocated and
//    they're already deducting from available."
//
// The sales orders being picked ARE the commitment. Asking "how much is available"
// while holding the order that consumed the availability double-counts it. Measured the
// same day on PO 7242978: SN37043NG-CHOCOLATE read available 0 / on hand 29 at
// Warehouse. An available-based sheet prints 0 and sends someone to buy 29 units that
// are on the shelf.
//
// So: on hand, compared against the units the ticket needs. Short means short.
//
// ⚠️ THE COMPARISON IS AGAINST THE TOTAL ACROSS THE COLUMNS, NOT AGAINST ONE LOCATION.
// The order's own location is a partner bucket that is routinely EMPTY — every SKU of
// PO 7242978 read 0 at `Warehouse Bulk : Bloomingdale's` — because stock is transferred
// in at pick time. A per-location shortage would flag all 10 SKUs of a healthy pull.
// What is worth flagging is having nowhere to pull from at all.

const num = (v) => Number(v) || 0
const id = (v) => String(v ?? '').trim()

/**
 * The location columns a ticket's stock table needs: the order's own location(s) first,
 * then the two Glendale buckets stock actually lives in.
 *
 * ⚠️ DE-DUPLICATED BY ID. A boutique order already sits in Warehouse (2), and printing
 * "Warehouse" twice — once as the order's location, once as the transfer source — is a
 * table that has forgotten what its own columns mean.
 */
export function stockColumns(orderLocations = [], stockLocations = []) {
  const out = []
  const seen = new Set()
  for (const l of [...orderLocations, ...stockLocations]) {
    const key = id(l.id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      id: key,
      name: id(l.name) || key,
      isOrderLocation: orderLocations.some((o) => id(o.id) === key),
      // Carried through so the shortfall can exclude it and the sheet can label it.
      offsite: !!l.offsite,
    })
  }
  return out
}

/** Every location a ticket needs stock for — the ids the live query is scoped to. */
export const stockLocationIds = (orderLocations = [], stockLocations = []) =>
  stockColumns(orderLocations, stockLocations).map((c) => c.id)

/**
 * Fold on-hand rows onto a ticket's SKUs.
 *
 * @param ticket  the output of bulkPick()
 * @param rows    [{ itemId, locationId, onHand }] — live, per item-location
 * @param opts.locations  the fixed transfer-source locations (STOCK_LOCATIONS)
 * @param opts.ok         did the stock query succeed? A failed lookup must not read as
 *                        "no stock anywhere" — see below.
 */
export function withStock(ticket, rows = [], { locations = [], ok = true, error = null } = {}) {
  const columns = stockColumns(ticket.orderLocations || [], locations)
  // ⚠️ UNKNOWN IS NOT ZERO. When the lookup failed the ticket still prints — it is the
  // document someone walks the floor with — but every stock cell says so rather than
  // showing 0, and nothing is called short. A sheet that quietly reports zero stock
  // because a query timed out would have someone cancel a pull they could have made.
  if (!ok) {
    return { ...ticket, stockColumns: columns, stockKnown: false, stockError: error, shortSkus: [] }
  }

  const byItem = new Map()
  for (const r of rows) {
    const item = id(r.itemId)
    if (!item) continue
    if (!byItem.has(item)) byItem.set(item, {})
    // ⚠️ NULL FOLDS TO 0 ONLY HERE, AFTER THE READ. aggregateItemLocation returns NULL
    // on-hand for a row that exists with no physical stock; absent and zero mean the
    // same thing to a picker, but filtering the row away instead would drop a location
    // from the sheet entirely.
    byItem.get(item)[id(r.locationId)] = num(r.onHand)
  }

  const skus = ticket.skus.map((s) => {
    const found = byItem.get(id(s.itemId)) || {}
    const onHand = {}
    let total = 0
    let offsite = 0
    for (const c of columns) {
      const q = num(found[c.id])
      // ⚠️ A NEGATIVE ON-HAND IS SHOWN BUT NEVER SUBTRACTED FROM THE TOTAL. An oversold
      // location is a real fact and belongs on the sheet — but it holds nothing to pull,
      // not "minus four units". Summing it raw makes a need of 5 against -4 elsewhere
      // report a shortfall of 9, sending someone to find four units that no order wants.
      onHand[c.id] = q
      // ⚠️ OFFSITE IS COUNTED SEPARATELY, NOT INTO THE LOCAL TOTAL. Nima, 2026-09-08:
      // "we wont always pull from offsite we may want to pick where we can pick from".
      // Folding it in would make a pull that needs a van read exactly like one that
      // needs a walk — and the whole point of this sheet is telling those apart.
      if (c.offsite) offsite += Math.max(0, q)
      else total += Math.max(0, q)
    }
    const short = Math.max(0, s.total - total)
    // `onHandTotal` is what can actually be PULLED ON THE FLOOR — the sum of the
    // positive local cells, so it can exceed the sum of what is printed when a
    // location is oversold. `offsiteTotal` is the same measure for the offsite
    // buildings, and `offsiteCovers` is how much of the local gap it would close.
    return {
      ...s,
      onHand,
      onHandTotal: total,
      offsiteTotal: offsite,
      short,
      offsiteCovers: Math.min(short, offsite),
    }
  })

  return {
    ...ticket,
    skus,
    stockColumns: columns,
    stockKnown: true,
    stockError: null,
    // ⚠️ SHORT STILL MEANS SHORT ON THE FLOOR. A SKU that offsite could cover stays on
    // this list, because it IS a decision someone has to make — but it says so, so
    // "short 419 units" never reads as "we do not own them". Measured on SO12578: 419
    // of 1,027 units sit only at Offsite Storage.
    shortSkus: skus.filter((s) => s.short > 0).map((s) => ({
      sku: s.sku, need: s.total, have: s.onHandTotal, short: s.short,
      offsite: s.offsiteTotal, offsiteCovers: s.offsiteCovers,
      // A gap offsite closes completely is a transfer; one it cannot is a real shortage.
      coveredByOffsite: s.offsiteCovers >= s.short,
    })),
  }
}

/**
 * The SKUs whose only stock is offsite — the transfer list.
 *
 * ⚠️ THIS IS THE LIST THE OLD SHEET COULD NOT PRODUCE, and its absence is what made
 * a fillable order look unfillable. Separate from `shortSkus` on purpose: one asks
 * "can we pick this today", the other asks "what has to come over first".
 */
export const offsiteOnly = (ticket = {}) =>
  (ticket.skus || [])
    .filter((s) => s.offsiteTotal > 0 && s.onHandTotal <= 0)
    .map((s) => ({ sku: s.sku, need: s.total, offsite: s.offsiteTotal }))
