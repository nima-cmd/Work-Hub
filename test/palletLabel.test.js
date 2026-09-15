// test/palletLabel.test.js — the pallet placard, §12.6.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { palletLabel, palletPlan, REQUIRED, PLACEMENT_UNSPECIFIED } from '../src/model/palletLabel.js'

const base = {
  operatingCompany: 'Exemplar Luxury Group', po: '0008928906', department: '0118',
  store: '0077', storeAbbrev: 'PNDC', dc: '0510', dcName: 'PNDC', cartons: 22,
}

test('the five fields the Manual names are the five it requires', () => {
  assert.equal(REQUIRED.length, 5)
  assert.equal(palletLabel(base).printable, true)
  assert.equal(palletLabel(base).fields.length, 5)
})

test('⚠️ A MISSING FIELD IS A PROBLEM, NEVER A PLACEHOLDER', () => {
  // A placard reading "DEPT: —" is a $250 fee that looks like a formatting choice.
  const r = palletLabel({ ...base, department: '', cartons: 0 })
  assert.equal(r.printable, false)
  assert.deepEqual(r.missing.map((m) => m.field).sort(), ['cartons', 'department'])
})

test('⚠️ ZERO CARTONS IS MISSING, NOT ZERO', () => {
  // "0 cartons on this pallet" is not a fact anyone meant to state.
  assert.ok(palletLabel({ ...base, cartons: 0 }).missing.some((m) => m.field === 'cartons'))
})

test('multiple POs get a placard line EACH, in the Manual\'s format', () => {
  // PALLET.multiPoPlacard is "PO number - carton count", which is only meaningful per
  // PO — a placard saying "3 POs, 22 cartons" tells a receiver nothing.
  const r = palletLabel({ ...base, cartons: 22, poBreakdown: [{ po: 'A', cartons: 10 }, { po: 'B', cartons: 12 }] })
  assert.deepEqual(r.placards, ['A - 10', 'B - 12'])
  assert.equal(r.printable, true)
})

test('⚠️ AND THE PER-PO COUNTS MUST ADD UP TO THE PALLET', () => {
  const r = palletLabel({ ...base, cartons: 22, poBreakdown: [{ po: 'A', cartons: 10 }] })
  assert.equal(r.printable, false)
  assert.match(r.errors[0], /total 10 but the pallet says 22/)
})

test('a pallet numbered beyond the total is refused', () => {
  assert.match(palletLabel({ ...base, pallet: 3, ofPallets: 2 }).errors[0], /exceeds the total/)
})

test('one pallet needs no split, and gets the whole count', () => {
  const p = palletPlan({ ...base, pallets: 1 })
  assert.equal(p.ok, true)
  assert.equal(p.labels.length, 1)
  assert.equal(p.labels[0].cartons, 22)
})

test('⚠️ SEVERAL PALLETS REFUSE TO GUESS THE SPLIT — it is a fact from the floor', () => {
  // Nothing in our data says which carton went on which pallet, and a placard with the
  // wrong carton count is exactly what §12.6 charges for.
  const p = palletPlan({ ...base, pallets: 3 })
  assert.equal(p.ok, false)
  assert.match(p.why, /nothing in our data says how the 22 cartons are split/)
})

test('a given split is used, numbered, and must add up', () => {
  const ok = palletPlan({ ...base, pallets: 2, perPallet: [12, 10] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.labels.map((l) => [l.pallet, l.ofPallets, l.cartons]), [[1, 2, 12], [2, 2, 10]])
  assert.match(palletPlan({ ...base, pallets: 2, perPallet: [12, 5] }).why, /total 17, the shipment has 22/)
})

test('⚠️ THE GUIDE IS SILENT ON PLACEMENT, AND WE SAY SO RATHER THAN INVENT A RULE', () => {
  assert.match(PLACEMENT_UNSPECIFIED, /does not say how many faces/)
})
