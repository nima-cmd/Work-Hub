// test/exemplarManifest.test.js — the Master Manifest handed to the carrier at pick-up.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifests, manifestAgreesWith } from '../src/model/exemplarManifest.js'

// PO 8928906 / IF7650 as it actually is: 22 cartons, one store, one PO, DC 0510.
const cartons = (n = 22, over = {}) =>
  Array.from({ length: n }, (_, i) => ({ carton: i + 1, units: 10, store: '0077', po: '0008928906', ...over }))

test('the live shipment produces one manifest, named by banner and DC', () => {
  const r = buildManifests(cartons(), { dc: '0510' })
  assert.equal(r.printable, true)
  assert.deepEqual(r.problems, [])
  assert.equal(r.manifests.length, 1)
  const m = r.manifests[0]
  // ⚠️ NEIMAN, NOT SAKS. Nima, 2026-09-14: store 0077 is the Pinnacle Point DC's own
  // ship-to and "this is actualy for Neiman Marcus side not the saks". Its banner was
  // hand-entered as SFA while DC 510 services 10 NM stores, 1 BG, 1 SFA and 1 OFF 5th,
  // and saksRouting names PNDC "NMG-Pinnacle Point".
  assert.equal(m.bannerName, 'Neiman Marcus')
  assert.equal(m.dcName, 'PNDC')
  assert.equal(m.totalCartons, 22)
  assert.deepEqual(m.pos, ['0008928906'])
  assert.equal(m.stores[0].store, '0077')
})

test('⚠️ ONE MANIFEST PER BANNER — a single sheet covering two is not the document (p13)', () => {
  // Exemplar is four banners behind one portal. Store 0077 is SFA; 0003 is a Neiman
  // store. Merging them would hand the driver one sheet where the guide wants two.
  const mixed = [...cartons(2), ...cartons(2, { store: '0003' })]
  const r = buildManifests(mixed)
  assert.ok(r.manifests.length >= 1)
  const names = r.manifests.map((m) => m.bannerName)
  assert.equal(new Set(names).size, names.length, 'each manifest is its own banner')
})

test('⚠️ A STORE ROUTED TO A DIFFERENT DC IS REPORTED, NOT PRINTED OVER', () => {
  // exemplarStores records that NetSuite is wrong about where 18 stores ship. A sheet
  // that silently prints the shipment's DC for a store routed elsewhere disagrees with
  // the freight it travels with.
  const r = buildManifests(cartons(1), { dc: '0560' })
  assert.equal(r.printable, false)
  assert.match(r.problems[0], /serviced by DC 510/)
})

test('⚠️ AN UNKNOWN STORE IS A PROBLEM, NEVER AN EMPTY COLUMN', () => {
  const r = buildManifests(cartons(1, { store: '9999' }))
  assert.equal(r.printable, false)
  assert.match(r.problems[0], /not in Exemplar's DC List/)
})

test('a carton with no store or no PO stops the sheet', () => {
  for (const bad of [{ store: '' }, { po: '' }]) {
    const r = buildManifests(cartons(1, bad))
    assert.equal(r.printable, false)
    assert.equal(r.problems.length, 1)
  }
})

test('nothing to manifest is not printable either', () => {
  assert.equal(buildManifests([]).printable, false)
})

test('⚠️ THE MANIFEST IS CHECKED AGAINST THE FREIGHT, because they are two reads', () => {
  // Cartons come from NetSuite's package records; the totals come from the routing
  // feed. A manifest whose count differs from the BOL's is a discrepancy the DC raises.
  const r = buildManifests(cartons(), { dc: '0510' })
  assert.equal(manifestAgreesWith(r, { cartons: 22, units: 220 }).agrees, true)
  const off = manifestAgreesWith(r, { cartons: 21, units: 220 })
  assert.equal(off.agrees, false)
  assert.match(off.notes[0], /22 cartons, the shipment says 21/)
})
