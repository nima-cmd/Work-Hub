// test/ediSdq.test.js — the 850's SDQ (mark for) and N1 (ship to).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sdqPairs, extractStoreQuantities, extractStoreCodes, extractShipTo,
  looksUnallocated, HOLD_STORE,
} from '../src/model/ediPoDiff.js'

// Shapes copied from the real messages, 2026-08-31.
const line = (dq, shipTo) => ({
  baselineItemData: [{ quantity: '17', productServiceID1: 'SN06012LD' }],
  destinationQuantity: dq ? [dq] : [],
  N1_loop: shipTo ? [{ partyIdentification: [{ entityIdentifierCode: 'ST', name: shipTo }] }] : [],
})
const msg = (lines) => ({ transactionSets: [{ PO1_loop: lines }] })

test('⚠️ AN SDQ SEGMENT REPEATS — the old regex read one store and dropped the rest', () => {
  // Real segment from PO 50220600 line 1. The regex matched only the UNSUFFIXED
  // identificationCode, so nine of ten stores were invisible.
  const seg = {
    unitOrBasisForMeasurementCode: 'EA', identificationCodeQualifier: '92',
    identificationCode: '0167', quantity: '3',
    identificationCode1: '0351', quantity1: '3',
    identificationCode2: '0371', quantity2: '3',
    identificationCode3: '0372', quantity3: '5',
    identificationCode4: '0378', quantity4: '3',
  }
  assert.deepEqual(sdqPairs(seg), [
    { store: '0167', qty: 3 }, { store: '0351', qty: 3 }, { store: '0371', qty: 3 },
    { store: '0372', qty: 5 }, { store: '0378', qty: 3 },
  ])
})

test('⚠️ the 10-digit BUYER code is not a store', () => {
  // Qualifier 92 tags both the buying party and each store; four digits is what separates
  // them. 0005189002 is Naghedi's buyer code on every Nordstrom 850.
  assert.deepEqual(sdqPairs({ identificationCode: '0005189002', quantity: '5' }), [])
  assert.deepEqual(sdqPairs({ identificationCode: '0297', quantity: '5' }), [{ store: '0297', qty: 5 }])
})

test('a store with no matching quantity is skipped, not counted as zero', () => {
  assert.deepEqual(sdqPairs({ identificationCode: '0167' }), [])
  assert.deepEqual(sdqPairs({ identificationCode: '0167', quantity: 'abc' }), [])
  assert.deepEqual(sdqPairs({}), [])
})

test('quantities total across every line and segment', () => {
  const m = msg([
    line({ identificationCode: '0167', quantity: '10', identificationCode1: '0351', quantity1: '5' }),
    line({ identificationCode: '0167', quantity: '4' }),
  ])
  assert.deepEqual(extractStoreQuantities(m), [
    { store: '0167', units: 14 }, { store: '0351', units: 5 },
  ])
  assert.deepEqual(extractStoreCodes(m), ['0167', '0351'])
})

test('⚠️ SHIP TO CARRIES NO QUALIFIER — which is why nothing ever read it', () => {
  // { entityIdentifierCode: "ST", name: "0299" }. The qualifier-92 regex could never
  // match it, so the app has never known where a Rack PO actually goes.
  const m = msg([line({ identificationCode: '0297', quantity: '10' }, '0299')])
  assert.deepEqual(extractShipTo(m), ['0299'])
  // Mark for and ship to are DIFFERENT things and both are now readable.
  assert.deepEqual(extractStoreCodes(m), ['0297'])
})

test('a PO can ship to more than one dock', () => {
  // PO 50220600: the CA stores go to 0399, the FL stores to 0799.
  const m = msg([
    line({ identificationCode: '0167', quantity: '10' }, '0399'),
    line({ identificationCode: '7742', quantity: '9' }, '0799'),
  ])
  assert.deepEqual(extractShipTo(m), ['0399', '0799'])
})

test('⚠️ UNALLOCATED IS MARK-FOR == SHIP-TO, not "there is a 299 on it"', () => {
  // Nordstrom's own rule: "Pre-Allocation Stores will appear with THE SAME VALUE, THE DC
  // LOCATION, in the Mark For and in the Ship To location … never ship until the PO has
  // been store allocated."
  const parked = msg([line({ identificationCode: '0299', quantity: '50' }, '0299')])
  assert.equal(looksUnallocated(extractStoreCodes(parked), extractShipTo(parked)), true)

  // ⚠️ THE CASE THAT WOULD HAVE BEEN HELD WRONGLY. PO 50203208 marks for 0297 and ships
  // to 0299 — two different values, so it is allocated and shippable. 0297 is the CS Rack
  // Warehouse, confirmed in writing by Nordstrom. Reading "there is a 299" as unallocated
  // would have stopped 1,033 units of shoes that were cleared to go.
  const shoes = msg([line({ identificationCode: '0297', quantity: '1033' }, '0299')])
  assert.equal(looksUnallocated(extractStoreCodes(shoes), extractShipTo(shoes)), false)

  // Real stores shipping to their DC are obviously fine.
  const normal = msg([line({ identificationCode: '0167', quantity: '10' }, '0399')])
  assert.equal(looksUnallocated(extractStoreCodes(normal), extractShipTo(normal)), false)
})

test('without a ship-to it falls back to the old heuristic, and nothing else changes', () => {
  assert.equal(looksUnallocated([HOLD_STORE]), true)
  assert.equal(looksUnallocated(['0297']), false)
  assert.equal(looksUnallocated([HOLD_STORE, '0004']), false)
  assert.equal(looksUnallocated([]), false)
})

test('a message with no SDQ at all yields nothing rather than throwing', () => {
  assert.deepEqual(extractStoreQuantities({}), [])
  assert.deepEqual(extractStoreQuantities(null), [])
  assert.deepEqual(extractShipTo(null), [])
  assert.deepEqual(extractStoreCodes(undefined), [])
})
