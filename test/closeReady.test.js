import test from 'node:test'
import assert from 'node:assert/strict'
import { closeReadiness } from '../src/model/closeReady.js'

// Nima, 2026-08-05: "letting us know if the orderful ASN been sent that the
// shipment can be marked as shipped."

test('the partner accepting the 856 plus NetSuite agreeing is the green light', () => {
  const r = closeReadiness({ ackStatus: 'ACCEPTED', hasAsn: true, netsuiteConfirmed: true })
  assert.equal(r.ok, true)
  assert.match(r.why, /accepted/)
})

// ⚠️ Neither half alone. Both of these have their own surface that would be
// silenced if closing were allowed here.
test('an accepted 856 with IFs still open is NOT closeable', () => {
  const r = closeReadiness({ ackStatus: 'ACCEPTED', hasAsn: true, netsuiteConfirmed: false })
  assert.equal(r.ok, false)
  assert.match(r.why, /not marked shipped/)   // asnAheadOfNetsuite owns this
})

test('shipped IFs with no 856 is NOT closeable — that is the announcement gap', () => {
  const r = closeReadiness({ hasAsn: false, netsuiteConfirmed: true })
  assert.equal(r.ok, false)
  assert.match(r.why, /no 856/)
})

test('a rejected or pending 856 says which, rather than just "not ready"', () => {
  assert.match(closeReadiness({ hasAsn: true, ackStatus: 'REJECTED', netsuiteConfirmed: true }).why, /856 is rejected/)
  assert.match(closeReadiness({ hasAsn: true, ackStatus: null, netsuiteConfirmed: true }).why, /unacknowledged/)
})

test('an archived BOL has nothing left to decide', () => {
  assert.equal(closeReadiness({ shippedAt: '2026-08-05', ackStatus: 'ACCEPTED', hasAsn: true, netsuiteConfirmed: true }), null)
})

// The live board on 2026-08-05: 9 open BOLs, 0 ready — every one waiting on
// both halves. The honest zero is worth pinning, since a readiness signal that
// can never fire is the counter bug this repo keeps finding.
test('the live shape: no 856 and open IFs names both reasons', () => {
  const r = closeReadiness({ hasAsn: false, netsuiteConfirmed: false })
  assert.equal(r.ok, false)
  assert.match(r.why, /no 856 on file yet · NetSuite has IFs not marked shipped/)
})
