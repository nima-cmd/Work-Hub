import test from 'node:test'
import assert from 'node:assert/strict'
import { labelTracking, labelCount, isLabelled, SHIPSTATION_TRACKING_SQL } from '../src/model/labelEvidence.js'
import { shipstationEligibility, HOLD } from '../src/model/shipstationEligible.js'

// The live defect (2026-08-11): IF7507's three ShipStation labels lived in
// shipstation_order, not on the fulfilment, so labelCount read 0 and the box
// looked unlabelled to BOTH the push gate and labelGap's "needs a label" chip.

test('label evidence: a ShipStation label counts even when NetSuite has none', () => {
  // IF7507's real shape: nothing from NetSuite, one lead tracking number from the
  // harvest after a human bought the label.
  assert.equal(labelCount({ nsTracking: null, ssTracking: ['1Z18GE010320563727'] }), 1)
  assert.equal(isLabelled({ nsTracking: null, ssTracking: ['1Z18GE010320563727'] }), true)
})

test('label evidence: a NetSuite label still counts on its own', () => {
  // IF7448's real shape — this half already worked and must keep working.
  assert.equal(labelCount({ nsTracking: ['1ZC6J6100311775078'], ssTracking: null }), 1)
})

test('label evidence: no label anywhere is still no label', () => {
  // IF7412: a real FedEx label that exists on paper and in no system. Nothing here
  // can invent it, and PACKED_NO_LABEL says so honestly.
  assert.equal(labelCount({}), 0)
  assert.equal(labelCount({ nsTracking: [], ssTracking: null }), 0)
  assert.equal(isLabelled({ nsTracking: null, ssTracking: [] }), false)
})

test('label evidence: the same number from both sources counts once', () => {
  // Once the harvest reaches NetSuite, the two sources agree — that must not read
  // as two labels on one box.
  const t = '1Z18GE010320563727'
  assert.deepEqual(labelTracking({ nsTracking: [t], ssTracking: [t] }), [t])
  assert.equal(labelCount({ nsTracking: [t], ssTracking: [t] }), 1)
})

test('label evidence: NetSuite is listed first, as the system of record', () => {
  assert.deepEqual(
    labelTracking({ nsTracking: ['NS1'], ssTracking: ['SS1'] }),
    ['NS1', 'SS1'],
  )
})

test('label evidence: blanks and single values are tolerated, not counted', () => {
  assert.equal(labelCount({ nsTracking: ['', '  '] }), 0)
  assert.equal(labelCount({ ssTracking: '1Z999' }), 1) // a bare string, not an array
})

test('label evidence: the fixed count makes ALREADY_LABELLED fire for IF7507', () => {
  // End to end: the gate that force can never lift now sees the ShipStation label.
  const v = shipstationEligibility({
    status: 'Picked',
    labelCount: labelCount({ nsTracking: null, ssTracking: ['1Z18GE010320563727'] }),
    carrier: 'UPS', shipMethodName: 'UPS® Ground',
  })
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.ALREADY_LABELLED)
})

test('label evidence: the SQL fragment excludes voided labels and has no backtick', () => {
  assert.match(SHIPSTATION_TRACKING_SQL, /NOT COALESCE\(so\.voided, false\)/)
  assert.match(SHIPSTATION_TRACKING_SQL, /so\.if_number = f\.if_number/)
  // A backtick here would close the template literal in server/queries.js and 500
  // the whole API.
  assert.equal(SHIPSTATION_TRACKING_SQL.includes('`'), false)
})
