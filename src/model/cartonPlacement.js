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

/**
 * ⚠️ THE WORDING IS THE GUIDE'S, NOT OURS, AND IT IS ONE CONSTANT.
 *
 * Both source documents say "PACKING SLIP ATTACHED" — the Routing Guide's
 * documentsRequired list and the Manual's §8.5 handling note. Nima said "enclosed" on
 * 2026-09-14, which is the natural way to say it and may well be what the PDF reads;
 * our extraction says ATTACHED in every place. It lives here so that if the manual is
 * re-read and says otherwise, it is one edit rather than six.
 */
export const SLIP_MARKING = 'PACKING SLIP ATTACHED'

/**
 * Where the six "PACKING SLIP ATTACHED" markings go, and what they must not cover.
 *
 * ⚠️ FIVE FACES ARE FREE AND ONE IS NOT. The marking goes on all six sides of the
 * carton carrying the slip — and one of those sides is the long side already carrying
 * the GS1-128. §8.2's rule that a FedEx label may not cover the GS1-128 is the same
 * principle: nothing goes over the symbol. So the marking on that face has to sit
 * beside it, and this computes whether it can.
 *
 * ⚠️ IT ALSO MUST NOT COVER THE POUCH. The pouch is on the carton by definition — it
 * is what the marking is announcing — so the recommendation is to keep the marking on
 * the opposite half of the face from the pouch, and that is stated rather than drawn,
 * because nothing in our data says where the pouch was stuck.
 */
export function markingPlan(box, markingSize, labelPlacement) {
  const f = faces(box)
  if (!f) return { ok: false, why: 'the carton has no recorded dimensions' }
  // ⚠️ "FITS" WITH NO MARGIN IS NOT A FIT ON A LOADED CARTON. A 4in marking on a 4in
  // face is arithmetically fine and physically hopeless — it has to land perfectly
  // square with no overhang, on a box that is taped and may be bowed. Anything with
  // less than half an inch to spare is reported as TIGHT rather than as ok, because
  // an overhanging label peels and a peeled marking is a missing one.
  const SNUG_IN = 0.5
  const fits = (fw, fh) => {
    for (const [w, h] of [[markingSize.w, markingSize.h], [markingSize.h, markingSize.w]]) {
      if (w <= fw && h <= fh) {
        const spare = Math.min(fw - w, fh - h)
        return { w, h, spareIn: Number(spare.toFixed(2)), tight: spare < SNUG_IN }
      }
    }
    return null
  }

  const out = []
  const push = (name, fw, fh, note) => {
    const f2 = fits(fw, fh)
    out.push({ face: name, faceW: fw, faceH: fh, ok: !!f2, size: f2, note: note || null,
      tight: !!f2?.tight,
      why: f2
        ? (f2.tight ? `only ${f2.spareIn}in to spare on a ${fw}x${fh}in face — it will overhang if it is not landed square` : null)
        : `a ${markingSize.w}x${markingSize.h}in marking does not fit a ${fw}x${fh}in face` })
  }

  const [longSide, end] = f.sides
  // The GS1 face: the marking has to clear the symbol.
  const gs1 = labelPlacement?.ok ? (labelPlacement.options.find((o) => o.face === 'long side') || labelPlacement.options[0]) : null
  if (gs1 && gs1.face === 'long side') {
    const freeW = longSide.w - gs1.labelW
    const f2 = fits(freeW, longSide.h)
    out.push({
      face: 'long side (with the GS1-128)', faceW: longSide.w, faceH: longSide.h,
      ok: !!f2, size: f2, tight: !!f2?.tight,
      note: `keep it clear of the GS1-128 — ${gs1.labelW}in of this face is taken by the symbol, leaving ${freeW.toFixed(1)}in beside it. Nothing may cover the barcode.`,
      why: f2 ? null : `only ${freeW.toFixed(1)}in is free beside the GS1-128 on a ${longSide.w}in face`,
    })
  } else {
    push('long side', longSide.w, longSide.h)
  }
  push('long side (opposite)', longSide.w, longSide.h)
  push('end', end.w, end.h)
  push('end (opposite)', end.w, end.h)
  push('top', f.top.w, f.top.h, 'keep it clear of the packing-slip pouch')
  push('bottom', f.top.w, f.top.h)

  return {
    ok: out.every((o) => o.ok),
    tight: out.filter((o) => o.tight),
    faces: out, marking: SLIP_MARKING, assumesUpright: f.assumesUpright,
  }
}
