// test/transferPurpose.test.js — what a transfer order is for.
//
// ⚠️ THE LOAD-BEARING TESTS ARE THE ONES ASSERTING NO ANSWER. 135 of 181 transfer orders
// land on a generic floor, and the failure mode this module exists to prevent is making
// all 135 look decided by reporting their destination as a purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  purposeFromDestination, purposeFor, purposeBreakdown, PURPOSE_SOURCE, NOT_A_PURPOSE,
} from '../src/model/transferPurpose.js'

const to = (n, o = {}) => ({ toNumber: n, units: 100, ...o })

test('⚠️ a holding location is NOT a purpose — 135 of 181 land on one', () => {
  // Nima, 2026-09-15: the transfer is fulfilled "usually to a ship state that way the
  // units can't be used for any order in china and aren't in the LA warehouse either."
  assert.equal(purposeFromDestination('Virtual Warehouse'), null)
  assert.equal(purposeFromDestination('Warehouse'), null)
  assert.equal(purposeFromDestination(''), null)
  assert.equal(purposeFromDestination(null), null)
  const p = purposeFor(to('TO224', { destination: 'Virtual Warehouse' }))
  assert.equal(p.state, 'unassigned')
  assert.equal(p.role, null)
  // It still SAYS where the units are — the fix is to stop concluding from it.
  assert.match(p.detail, /Virtual Warehouse/)
  assert.match(p.detail, /holding location rather than a purpose/)
})

test('a partner destination IS a purpose, and it is observed not entered', () => {
  const p = purposeFor(to('TO150', { destination: "Warehouse Bulk : Bloomingdale's" }))
  assert.equal(p.state, 'known')
  assert.equal(p.partner, "Bloomingdale's")
  assert.equal(p.role, 'partner stock')
  assert.equal(p.source, PURPOSE_SOURCE.DESTINATION)
  assert.equal(p.source.kind, 'observed')
  assert.match(p.detail, /earmarked for Bloomingdale's/)
  // ⚠️ AND IT IS NOT RE-ENTERED BY HAND. It is already true in NetSuite; asking somebody
  // to retype it is how two copies start disagreeing.
  assert.equal(p.entered, null)
})

test('destinations that are their own reason carry through under their own name', () => {
  // Office, Consignment, Offsite Storage — real, and not mapped to a vocabulary this
  // module would have to keep in step with NetSuite's location tree.
  assert.equal(purposeFor(to('TO1', { destination: 'Consignment' })).role, 'consignment')
  assert.equal(purposeFor(to('TO2', { destination: 'Offsite Storage' })).role, 'offsite storage')
  assert.equal(purposeFor(to('TO3', { destination: 'Office' })).role, 'office')
})

test('⚠️ an entered purpose fills the gap NetSuite cannot — and names its author', () => {
  const p = purposeFor(to('TO220', {
    destination: 'Virtual Warehouse', purpose: 'holiday ecom replen', purposeBy: 'Nima',
  }))
  assert.equal(p.state, 'known')
  assert.equal(p.role, 'holiday ecom replen')
  assert.equal(p.source, PURPOSE_SOURCE.ENTERED)
  assert.equal(p.source.kind, 'entered')
  assert.equal(p.by, 'Nima')
  assert.match(p.detail, /Nima: holiday ecom replen/)
})

test('⚠️ OBSERVED BEATS ENTERED here — the opposite of the usual rule, deliberately', () => {
  // Everywhere else an entered value wins because it is a person correcting a guess.
  // Here the "derivation" is a field somebody set in NetSuite, and NetSuite is where the
  // units actually move: a note that disagreed would describe freight that went
  // elsewhere.
  const p = purposeFor(to('TO150', {
    destination: 'Warehouse Bulk : Nordstrom', purpose: 'Bloomingdale holiday', purposeBy: 'Nima',
  }))
  assert.equal(p.partner, 'Nordstrom', 'where it actually goes wins')
  assert.equal(p.source.kind, 'observed')
  // ⚠️ AND THE DISAGREEMENT IS REPORTED, NEVER RESOLVED SILENTLY — custody.js's rule.
  assert.ok(p.conflict)
  assert.match(p.conflict, /noted as "Bloomingdale holiday" here/)
  assert.match(p.conflict, /NetSuite transfers it to Warehouse Bulk : Nordstrom/)
  // The note is not thrown away either.
  assert.equal(p.entered, 'Bloomingdale holiday')
})

test('a note that AGREES with the destination raises no conflict', () => {
  const p = purposeFor(to('TO150', { destination: 'Warehouse Bulk : Nordstrom', purpose: 'Nordstrom' }))
  assert.equal(p.conflict, null)
})

test('⚠️ the container breakdown does NOT pick a winner', () => {
  // The 59 spans six POs; a single "purpose" for a container would erase the answer.
  const b = purposeBreakdown([
    to('TO1', { destination: 'Warehouse Bulk : Nordstrom', units: 300 }),
    to('TO2', { destination: 'Warehouse Bulk : Nordstrom', units: 200 }),
    to('TO3', { destination: "Warehouse Bulk : Bloomingdale's", units: 400 }),
    to('TO4', { destination: 'Virtual Warehouse', units: 500 }),
    to('TO5', { destination: 'Warehouse', units: 77 }),
  ])
  assert.equal(b.roles.length, 2)
  // Nordstrom is 300 + 200 across two transfer orders; Bloomingdale's is 400 in one.
  // Biggest by UNITS, not by transfer-order count — a container's answer is how much
  // stock is spoken for, not how many documents carry it.
  assert.equal(b.roles[0].partner, 'Nordstrom', 'ordered by units, biggest first')
  assert.equal(b.roles[0].units, 500)
  assert.deepEqual(b.roles[0].transferOrders, ['TO1', 'TO2'])
  assert.equal(b.roles[1].partner, "Bloomingdale's")
  assert.equal(b.roles[1].units, 400)
  assert.equal(b.unassigned, 2)
  // ⚠️ THE PARTITION MUST ADD UP. A counter that does not account for its own population
  // is the shape check:counters exists to catch.
  const assigned = b.roles.reduce((a, r) => a + r.transferOrders.length, 0)
  assert.equal(assigned + b.unassigned, b.total)
  assert.equal(b.total, 5)
})

test('an empty container has no roles and no unassigned — not a zero-length claim', () => {
  const b = purposeBreakdown([])
  assert.deepEqual(b.roles, [])
  assert.equal(b.unassigned, 0)
  assert.equal(b.total, 0)
})

test('⚠️ the holding-location list is ENTERED, so widening it is a decision', () => {
  // src/model/transferOrder.js records the same rule for its own destination list:
  // widening it is "a decision, never a guess".
  assert.ok(NOT_A_PURPOSE.has('Virtual Warehouse'))
  assert.ok(NOT_A_PURPOSE.has('Warehouse'))
  assert.ok(!NOT_A_PURPOSE.has("Warehouse Bulk : Bloomingdale's"), 'a partner floor is a purpose')
})
