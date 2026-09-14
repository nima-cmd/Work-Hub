// test/cartonPlacement.test.js — where the GS1-128 physically goes on the box.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placementFor, parseBox, placementPlan, faces, markingPlan, SLIP_MARKING } from '../src/model/cartonPlacement.js'
import { LABEL_PLACEMENT } from '../src/model/exemplarStandards.js'

const L4x6 = { w: 4, h: 6 }

test('a tall carton takes the label either way up, and the band is computed', () => {
  const r = placementFor(parseBox('22x16x16'), L4x6, LABEL_PLACEMENT)
  assert.equal(r.ok, true)
  const longUpright = r.options.find((o) => o.face === 'long side' && o.orientation === 'upright')
  assert.equal(longUpright.bottomFrom, 1.38)
  // 16in face less a 6in label = a bottom edge up to 10in, under the 12in ceiling.
  assert.equal(longUpright.bottomTo, 10)
})

test('⚠️ A SHALLOW CARTON TAKES NO LABEL AT ALL, AND THIS SHIPMENT HAS THREE', () => {
  // PO 8928906 has 3 cartons of 24x14x4. §8.2 wants the bottom edge at least 1.38in up;
  // the label's own shortest dimension is 4in; the box is 4in tall. There is no band,
  // and no stock we hold changes that — 3x6 needs 4.38in, the half sheet 6.88in.
  const r = placementFor(parseBox('24X14X4'), L4x6, LABEL_PLACEMENT)
  assert.equal(r.ok, false)
  assert.match(r.why, /needs 5.38in of upright face/)
  assert.match(r.why, /tallest side is 4in/)
  for (const label of [{ w: 3, h: 6 }, { w: 5.5, h: 8.5 }]) {
    assert.equal(placementFor(parseBox('24X14X4'), label, LABEL_PLACEMENT).ok, false)
  }
})

test('⚠️ THE 12in CEILING BINDS ON A TALL CARTON, not just the box height', () => {
  const r = placementFor({ length: 30, width: 20, height: 40 }, L4x6, LABEL_PLACEMENT)
  assert.equal(r.options.find((o) => o.orientation === 'upright').bottomTo, 12)
})

test('a 7in carton only takes the label on its side, which is worth being told', () => {
  // 1.38 + 6 = 7.38 > 7, so upright does not fit; 1.38 + 4 = 5.38 does.
  const r = placementFor(parseBox('22x16x7'), L4x6, LABEL_PLACEMENT)
  assert.equal(r.ok, true)
  assert.ok(r.options.every((o) => o.orientation === 'on its side'))
})

test('a label wider than the face is refused even when the height works', () => {
  const r = placementFor({ length: 3, width: 3, height: 20 }, L4x6, LABEL_PLACEMENT)
  assert.equal(r.ok, false)
})

test('⚠️ THE UPRIGHT ASSUMPTION IS STATED, because a carton on a different face has a different band', () => {
  assert.match(faces(parseBox('22x16x7')).assumesUpright, /third dimension/)
  assert.match(placementFor(parseBox('22x16x7'), L4x6, LABEL_PLACEMENT).assumesUpright, /third dimension/)
})

test('the plan groups by box, not by carton, and names what is blocked', () => {
  const cartons = [
    { carton: 1, box: '22x16x7' }, { carton: 2, box: '22x16x7' }, { carton: 3, box: '24X14X4' },
  ]
  const p = placementPlan(cartons, L4x6, LABEL_PLACEMENT)
  assert.equal(p.ok, false)
  assert.equal(p.groups[0].box, '22x16x7')
  assert.equal(p.groups[0].count, 2)
  assert.equal(p.blocked.length, 1)
  assert.equal(p.blocked[0].box, '24X14X4')
})

test('a non-dimensional box name is reported rather than skipped', () => {
  const p = placementPlan([{ carton: 1, box: 'CUSTOM' }], L4x6, LABEL_PLACEMENT)
  assert.equal(p.ok, false)
  assert.match(p.blocked[0].placement.why, /not a dimensional box name/)
})

// ── The six "PACKING SLIP ATTACHED" markings ────────────────────────────────

test('⚠️ THE WORDING IS THE GUIDE\'S, IN ONE PLACE', () => {
  // Both source documents say ATTACHED. Nima said "enclosed" on 2026-09-14, which is
  // the natural way to say it; if the manual is re-read and disagrees, this is the
  // single edit rather than six scattered strings.
  assert.equal(SLIP_MARKING, 'PACKING SLIP ATTACHED')
})

test('all six faces are planned, and the one sharing a side with the barcode says so', () => {
  const box = parseBox('22x16x7')
  const lab = placementFor(box, { w: 4, h: 6 }, LABEL_PLACEMENT)
  const m = markingPlan(box, { w: 4, h: 6 }, lab)
  assert.equal(m.faces.length, 6)
  const gs1Face = m.faces.find((f) => /GS1/.test(f.face))
  assert.ok(gs1Face, 'the GS1 face is called out by name')
  assert.match(gs1Face.note, /Nothing may cover the barcode/)
})

test('⚠️ A MARKING WITH NO MARGIN IS "TIGHT", NOT "FITS"', () => {
  // 24x14x4: a 4in marking on a 4in face is arithmetically fine and physically
  // hopeless — it has to land perfectly square on a taped, possibly bowed box, and an
  // overhanging label peels. A peeled marking is a missing one.
  const box = parseBox('24X14X4')
  const m = markingPlan(box, { w: 4, h: 6 }, placementFor(box, { w: 4, h: 6 }, LABEL_PLACEMENT))
  assert.equal(m.tight.length, 4)
  assert.match(m.tight[0].why, /0in to spare/)
  assert.ok(m.tight.every((f) => f.ok), 'tight is still ok — it is a warning, not a refusal')
})

test('a roomy carton reports no tight faces', () => {
  const box = parseBox('22x16x16')
  const m = markingPlan(box, { w: 4, h: 6 }, placementFor(box, { w: 4, h: 6 }, LABEL_PLACEMENT))
  assert.deepEqual(m.tight, [])
})

test('the top face is flagged for the pouch, because that is what the marking announces', () => {
  const box = parseBox('22x16x7')
  const m = markingPlan(box, { w: 4, h: 6 }, placementFor(box, { w: 4, h: 6 }, LABEL_PLACEMENT))
  assert.match(m.faces.find((f) => f.face === 'top').note, /pouch/)
})
