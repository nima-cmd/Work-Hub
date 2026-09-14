// src/model/cartonPlacement.js — WHERE each label goes on the physical box.
//
// Nima, 2026-09-14: "can we have a print out of what the box would look like with all
// labels indicated where they should be clear instruction for applying the label".
//
// ⚠️ ASKING THAT QUESTION IMMEDIATELY BREAKS ON THIS SHIPMENT, which is the point of
// computing it rather than drawing a generic picture. §8.2 (p36) puts the GS1-128 on
// the longest side with its bottom edge 1.38in to 12in from the carton's base. On a
// carton only 4in tall there is no band: 1.38 + the label's own 4in shortest dimension
// is 5.38in, taller than the box. PO 8928906 has three such cartons (24x14x4).
//
// So this returns, per carton, the faces a label CAN go on and says plainly when there
// are none — instead of printing an instruction nobody can follow.

/** A box's three dimensions, largest first, plus the upright height as packed. */
export function faces({ length, width, height } = {}) {
  const l = Number(length) || 0
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!l || !w || !h) return null
  // ⚠️ THE THIRD DIMENSION IS TAKEN AS THE UPRIGHT HEIGHT, because that is how the box
  // names are written (22x16x7) and how they are palletised. It is an ASSUMPTION about
  // orientation, not a fact from the guide — a carton stood on a different face has a
  // different band, and `assumesUpright` says so out loud rather than hiding it.
  return {
    upright: h,
    sides: [
      { name: 'long side', w: l, h },
      { name: 'end', w, h },
    ],
    top: { name: 'top', w: l, h: w },
    assumesUpright: 'the third dimension is treated as the upright height',
  }
}

/**
 * Can this label go on this carton, and where?
 *
 * @param box    { length, width, height } inches
 * @param label  { w, h } inches — a 4x6 is { w: 4, h: 6 }
 * @param rule   { minHeightIn, maxHeightIn, side }  (LABEL_PLACEMENT)
 */
export function placementFor(box, label, rule) {
  const f = faces(box)
  if (!f) return { ok: false, why: 'the carton has no recorded dimensions' }
  const min = Number(rule?.minHeightIn) || 0
  const max = Number(rule?.maxHeightIn) || Infinity

  // ⚠️ BOTH ORIENTATIONS ARE TRIED. A 4x6 laid on its side is 6 wide by 4 tall and
  // fits a shallow carton that the portrait one cannot — and the guide constrains the
  // BARCODE's direction (picket fence), not the paper's. Which orientation is used is
  // reported so the instruction sheet can say which way round to stick it.
  const options = []
  for (const face of f.sides) {
    for (const [ow, oh, how] of [[label.w, label.h, 'upright'], [label.h, label.w, 'on its side']]) {
      if (ow > face.w) continue
      // The label's bottom edge must sit at or above `min`, and its own top must stay
      // on the box. Its highest allowed bottom edge is the lesser of `max` and the
      // room left above it.
      const highestBottom = Math.min(max, face.h - oh)
      if (highestBottom < min) continue
      options.push({
        face: face.name, faceW: face.w, faceH: face.h,
        labelW: ow, labelH: oh, orientation: how,
        bottomFrom: min, bottomTo: Number(highestBottom.toFixed(2)),
      })
    }
  }
  if (!options.length) {
    const shortest = Math.min(label.w, label.h)
    return {
      ok: false,
      // Named precisely, because the fix depends on which constraint bit.
      why: `a ${label.w}x${label.h}in label needs ${(min + shortest).toFixed(2)}in of upright face `
         + `(${min}in clearance + ${shortest}in of label) and the tallest side is ${f.upright}in`,
      box, label, rule,
    }
  }
  return { ok: true, options, assumesUpright: f.assumesUpright }
}

/** Parse "22x16x7" / "24X14X4" into dimensions. Returns null when it is not dimensional. */
export function parseBox(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/)
  return m ? { length: Number(m[1]), width: Number(m[2]), height: Number(m[3]) } : null
}

/**
 * Every distinct box on a shipment, with its placement verdict.
 *
 * ⚠️ GROUPED BY BOX, NOT BY CARTON. The person applying labels works a pallet of one
 * box size at a time, and 22 copies of the same diagram is not an instruction sheet.
 */
export function placementPlan(cartons = [], label, rule) {
  const byBox = new Map()
  for (const c of cartons) {
    const key = String(c.box ?? c.boxName ?? '').trim() || '(unrecorded)'
    if (!byBox.has(key)) byBox.set(key, { box: key, cartons: [], dims: parseBox(key) })
    byBox.get(key).cartons.push(c.carton)
  }
  const groups = [...byBox.values()].map((g) => ({
    ...g,
    count: g.cartons.length,
    placement: g.dims ? placementFor(g.dims, label, rule) : { ok: false, why: `"${g.box}" is not a dimensional box name` },
  })).sort((a, b) => b.count - a.count)
  return {
    groups,
    blocked: groups.filter((g) => !g.placement.ok),
    ok: groups.every((g) => g.placement.ok),
  }
}
