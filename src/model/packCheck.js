// src/model/packCheck.js — did every unit on the fulfilment actually get packed?
//
// The problem (Nima, 2026-08-02): packing EDI freight is manual and tedious, and
// a missed item is invisible. Nothing downstream notices — the cartons ship, the
// 856 goes out claiming quantities that aren't in the boxes, and the shortage
// surfaces as a retailer chargeback weeks later.
//
// The check is deliberately per-FULFILMENT, not per sales order. An IF can be
// legitimately short against its SO (partial fulfilment is normal), so an
// SO-level check would cry wolf on every split shipment. "Every unit ON this IF
// is in a carton" has no such false alarm, and when it fails it names the exact
// IF to go back and finish.
//
// Two numbers, both from NetSuite:
//   • ifUnits     — the fulfilment's own line quantities. NOTE: an Item
//     Fulfilment writes THREE lines per item (-qty, +qty, -qty) for the
//     inventory movement, so the caller must sum only POSITIVE InvtPart lines.
//     Summing ABS() triples every count — that mistake reads as a massive
//     over-pack rather than an obvious error.
//   • packedUnits — summed across the IF's carton records.
//
// Nothing here touches a database or the network.

// Cartons exist but carry no quantities at all — a distinct human error from
// "some units are missing". The carton record was created (it has a weight) and
// the quantity field was left blank, so the fix is different: fill in the
// cartons you already made, don't pack more boxes.
const isBlankCartons = (cartons, packed) => cartons > 0 && packed === 0

// One fulfilment's verdict. `status` drives the UI; `short` is how many units
// are unaccounted for (never negative — an over-pack reports its own count).
export function checkFulfilmentPack({ ifNumber, poDc, ifUnits, packedUnits, cartons } = {}) {
  const need = Number(ifUnits) || 0
  const got = Number(packedUnits) || 0
  const boxes = Number(cartons) || 0

  let status
  if (boxes === 0 && got === 0) status = 'not_started'
  else if (got === need) status = 'ok'
  else if (got > need) status = 'over'
  else status = 'short'

  return {
    ifNumber: ifNumber ?? null,
    poDc: poDc ?? null,
    ifUnits: need,
    packedUnits: got,
    cartons: boxes,
    status,
    short: status === 'short' ? need - got : 0,
    over: status === 'over' ? got - need : 0,
    blankCartons: status === 'short' && isBlankCartons(boxes, got),
  }
}

// Roll a PO-DC group's fulfilments into one verdict. A group is only `ready`
// when EVERY member reconciles — one short IF makes the whole BOL wrong, since
// the 856 transmits the group's quantities.
//
// `not_started` is kept separate from `short` on purpose: mid-pack, most IFs
// have no cartons yet and calling that an error would make the check noise that
// gets ignored. Only a group where packing has actually begun can be `short`.
export function checkGroupPack(fulfilments = []) {
  const items = fulfilments.map(checkFulfilmentPack)
  const by = (s) => items.filter((i) => i.status === s)
  const short = by('short')
  const over = by('over')
  const notStarted = by('not_started')

  const ifUnits = items.reduce((n, i) => n + i.ifUnits, 0)
  const packedUnits = items.reduce((n, i) => n + i.packedUnits, 0)

  // Order matters: a genuine miscount outranks work simply not begun.
  const status = short.length ? 'short'
    : over.length ? 'over'
      : notStarted.length && notStarted.length === items.length ? 'not_started'
        : notStarted.length ? 'in_progress'
          : items.length ? 'ok' : 'empty'

  return {
    status,
    ready: status === 'ok',
    ifUnits,
    packedUnits,
    shortUnits: items.reduce((n, i) => n + i.short, 0),
    overUnits: items.reduce((n, i) => n + i.over, 0),
    cartons: items.reduce((n, i) => n + i.cartons, 0),
    counts: { total: items.length, ok: by('ok').length, short: short.length, over: over.length, notStarted: notStarted.length },
    // The fulfilments needing hands-on work, worst first — this is the list the
    // UI shows and the warehouse walks.
    problems: [...short, ...over].sort((a, b) => (b.short + b.over) - (a.short + a.over)),
    fulfilments: items,
  }
}

// A one-line summary for a badge: "36/36 units" when clean, "26/141 — 115 short"
// when not. Deliberately always shows both numbers so a clean group still proves
// it was checked rather than silently showing nothing.
export function packSummary(group) {
  if (!group || group.status === 'empty') return ''
  const base = `${group.packedUnits}/${group.ifUnits} units`
  if (group.status === 'short') return `${base} — ${group.shortUnits} short`
  if (group.status === 'over') return `${base} — ${group.overUnits} over`
  if (group.status === 'not_started') return `${base} — not packed yet`
  if (group.status === 'in_progress') return `${base} — packing`
  return base
}
