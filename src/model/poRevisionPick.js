// src/model/poRevisionPick.js — a pick ticket for a PO that was re-sent.
//
// Nima, 2026-09-10: "could you make a bulk pick ticket comparing the two version and
// what changes they made".
//
// ⚠️ WHY THIS IS NOT THE ORDINARY BULK PICK TICKET. That one reads NetSuite, which
// is the right source when the sales orders exist. Here they do not: PO 1236143's
// second 850 arrived on 09-08, was silently IGNORED by the integration, and created
// nothing. The floor still has to know what to pull, so this reads the EDI directly
// — the 850s are the only place the new version exists.
//
// ⚠️ AND IT IS A DIFF, NOT A REPLACEMENT SHEET. The 320-unit version was already
// picked. Printing the new 311-unit version on its own would send someone to walk
// the whole order again, when the actual work is 13 units to put back and 4 to fetch.
// So every row says what MOVED, and the totals say what to do rather than what to have.
//
// Measured on the real pair (Orderful 1026743587 vs 1037367444):
//   v1  2026-08-29  purpose 00  10 SKUs  320 units  24 stores
//   v2  2026-09-08  purpose 07   7 SKUs  311 units  24 stores
// Three SKUs dropped entirely, one rose by 4, six stores moved.

/**
 * ⚠️ THE STORE GRID IS THE POINT, NOT THE SKU TOTALS. A SKU whose total is unchanged
 * can still have moved between stores — and for a store-allocated PO the units are
 * bagged per store, so an unchanged total with a changed split is real work. Compared
 * at store level for exactly that reason.
 */
export function revisionPick(v1, v2) {
  const skus = [...new Set([...keys(v1), ...keys(v2)])].sort()
  const stores = [...new Set([...storeKeys(v1), ...storeKeys(v2)])].sort()

  const rows = skus.map((sku) => {
    const was = unitsFor(v1, sku)
    const now = unitsFor(v2, sku)
    const byStore = stores
      .map((store) => ({ store, was: at(v1, sku, store), now: at(v2, sku, store) }))
      .filter((s) => s.was !== s.now)
    return {
      sku,
      was,
      now,
      delta: now - was,
      // ⚠️ FOUR VERDICTS, NOT A SIGNED NUMBER. "removed" and "reduced" are different
      // jobs on the floor — one is put the whole lot back, the other is count some
      // out — and "reallocated" is the one a totals-only sheet loses completely.
      verdict: was > 0 && now === 0 ? 'removed'
        : was === 0 && now > 0 ? 'added'
        : now > was ? 'increased'
        : now < was ? 'reduced'
        : byStore.length ? 'reallocated'
        : 'unchanged',
      byStore,
    }
  })

  const changed = rows.filter((r) => r.verdict !== 'unchanged')
  const putBack = rows.filter((r) => r.delta < 0).reduce((a, r) => a - r.delta, 0)
  const fetch = rows.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0)

  const storeRows = stores.map((store) => {
    const was = skus.reduce((a, s) => a + at(v1, s, store), 0)
    const now = skus.reduce((a, s) => a + at(v2, s, store), 0)
    return { store, was, now, delta: now - was }
  })

  // ⚠️ THE FULL GRID, NOT JUST THE CHANGED CELLS. `rows[].byStore` carries only what
  // moved, which is right for the action list and wrong for a pick sheet: someone
  // bagging store 0058 needs all seven of its numbers, not the two that changed.
  // Nima, 2026-09-10: "what thye want in total is the important number".
  const grid = {
    skus,
    stores,
    cell: Object.fromEntries(skus.map((sku) => [sku,
      Object.fromEntries(stores.map((store) => [store, { was: at(v1, sku, store), now: at(v2, sku, store) }])),
    ])),
    // ⚠️ BOTH MARGINS ARE SUMMED FROM THE CELLS, and that is not pedantry. A grid
    // whose row totals and column totals disagree is a grid nobody can trust, and
    // they WILL disagree if one margin comes from the PO1 line quantity and the other
    // from the SDQ store split. Found by the test that asserted they reconcile.
    skuTotals: Object.fromEntries(skus.map((sku) => [sku, {
      was: stores.reduce((a, st) => a + at(v1, sku, st), 0),
      now: stores.reduce((a, st) => a + at(v2, sku, st), 0),
    }])),
    storeTotals: Object.fromEntries(stores.map((store) => [store, {
      was: skus.reduce((a, s) => a + at(v1, s, store), 0),
      now: skus.reduce((a, s) => a + at(v2, s, store), 0),
    }])),
    // ⚠️ AND THE DECLARED LINE QUANTITY IS KEPT SEPARATELY, because a well-formed 850
    // has SDQ summing to PO1 and a malformed one does not. Reporting the difference
    // is worth more than silently preferring either number — a store split that does
    // not add up to the line is the shape that under-ships a store nobody noticed.
    declared: Object.fromEntries(skus.map((sku) => [sku, { was: unitsFor(v1, sku), now: unitsFor(v2, sku) }])),
    sdqMismatch: skus
      .map((sku) => ({
        sku,
        declared: unitsFor(v2, sku),
        fromStores: stores.reduce((a, st) => a + at(v2, sku, st), 0),
      }))
      .filter((x) => x.declared !== x.fromStores),
  }

  return {
    poNumber: v2.poNumber ?? v1.poNumber ?? null,
    v1: summary(v1),
    v2: summary(v2),
    rows,
    changed,
    grid,
    storeRows,
    storesMoved: storeRows.filter((s) => s.delta !== 0),
    // ⚠️ THE HEADLINE IS THE WORK, NOT THE DIFFERENCE. "9 fewer units" is arithmetic;
    // "put 13 back, fetch 4" is the instruction, and they are not the same number
    // because units moved in both directions.
    putBack,
    fetch,
    netDelta: fetch - putBack,
    // ⚠️ A PURPOSE CODE THAT CONTRADICTS THE CONTENT IS THE FINDING. Bloomingdale's
    // sent this as 07 = Duplicate while removing three SKUs. Three for three on their
    // repeat POs. Printed on the sheet, because anyone told "it is a duplicate" will
    // reasonably not look.
    miscoded: v2.purposeCode === '07' && changed.length > 0,
    identical: changed.length === 0,
  }
}

const keys = (v) => (v?.lines || []).map((l) => l.sku)
const storeKeys = (v) => (v?.lines || []).flatMap((l) => (l.byStore || []).map((s) => s.store))
const unitsFor = (v, sku) => (v?.lines || []).filter((l) => l.sku === sku).reduce((a, l) => a + (Number(l.units) || 0), 0)
const at = (v, sku, store) => (v?.lines || [])
  .filter((l) => l.sku === sku)
  .flatMap((l) => l.byStore || [])
  .filter((s) => s.store === store)
  .reduce((a, s) => a + (Number(s.qty) || 0), 0)

const summary = (v) => ({
  transactionId: v?.transactionId ?? null,
  receivedAt: v?.receivedAt ?? null,
  purposeCode: v?.purposeCode ?? null,
  purposeLabel: PURPOSE[v?.purposeCode] ?? (v?.purposeCode ? `code ${v.purposeCode}` : null),
  skuCount: new Set(keys(v)).size,
  units: (v?.lines || []).reduce((a, l) => a + (Number(l.units) || 0), 0),
  storeCount: new Set(storeKeys(v)).size,
})

/** BEG01. Kept local so this module stands alone on a print path. */
const PURPOSE = { '00': 'Original', '01': 'Cancellation', '04': 'Change', '05': 'Replace', '07': 'Duplicate' }

/**
 * One line of instruction per changed SKU.
 *
 * ⚠️ WRITTEN AS AN ACTION, and in the direction the floor works. "reduced 8 -> 12"
 * is a fact someone has to invert in their head while holding a box; "fetch 4 more"
 * is the job. Same reason problemLine exists on the ordinary pick ticket.
 */
export function actionLine(r) {
  const stores = r.byStore.length
    ? ` (${r.byStore.map((s) => `${s.store} ${s.was}->${s.now}`).join(', ')})`
    : ''
  switch (r.verdict) {
    case 'removed': return `PUT BACK all ${r.was} — no longer on the PO${stores}`
    case 'reduced': return `PUT BACK ${-r.delta} — ${r.was} down to ${r.now}${stores}`
    case 'added': return `FETCH ${r.now} — newly added${stores}`
    case 'increased': return `FETCH ${r.delta} more — ${r.was} up to ${r.now}${stores}`
    case 'reallocated': return `SAME total (${r.now}) but re-split between stores${stores}`
    default: return 'unchanged'
  }
}
