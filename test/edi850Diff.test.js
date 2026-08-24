import test from 'node:test'
import assert from 'node:assert/strict'
import { diff850, diff850Headline, flattenBody, labelFor, x12Date, PURPOSE_CODES } from '../src/model/edi850Diff.js'

// The real pair, reduced to its shape: PO 50073678, 17 Aug vs 21 Aug. 10 of 930
// fields differed; 9 were envelope and 1 was the ship-not-before date.
const body = (over = {}) => ({
  interchangeControlHeader: [{ interchangeDate: '260818', interchangeTime: '0022', interchangeControlNumber: '000001688' }],
  functionalGroupHeader: [{ date: '20260818', groupControlNumber: '1688' }],
  transactionSets: [{
    transactionSetHeader: [{ transactionSetControlNumber: '16880001' }],
    beginningSegmentForPurchaseOrder: [{ transactionSetPurposeCode: '07', purchaseOrderNumber: '50073678', date: '20260409' }],
    dateTimeReference: [{ dateTimeQualifier: '001', date: '20260910' }, { dateTimeQualifier: '037', date: '20260828' }],
    lineItems: [{ quantity: '30', unitPrice: '54.00' }],
    ...over,
  }],
  href: 'https://api.orderful.com/v3/transactions/1014668001/message',
})

const newer = () => {
  const b = body()
  b.interchangeControlHeader[0].interchangeDate = '260821'
  b.interchangeControlHeader[0].interchangeControlNumber = '000001691'
  b.functionalGroupHeader[0].date = '20260821'
  b.functionalGroupHeader[0].groupControlNumber = '1691'
  b.transactionSets[0].transactionSetHeader[0].transactionSetControlNumber = '16910001'
  b.transactionSets[0].dateTimeReference[1].date = '20260822'   // the one real change
  b.href = 'https://api.orderful.com/v3/transactions/1019264559/message'
  return b
}

test('the real case: one substantive change, the rest is envelope noise', () => {
  const d = diff850(body(), newer())
  assert.equal(d.counts.substantive, 1)
  assert.ok(d.counts.envelope >= 5, 'control numbers and transmission dates are noise')
  assert.equal(d.substantive[0].label, 'ship not before (DTM 037)')
  assert.equal(d.substantive[0].from, '2026-08-28')
  assert.equal(d.substantive[0].to, '2026-08-22')
})

test('⚠️ a date-only change on a DUPLICATE does not imply rework', () => {
  const d = diff850(body(), newer())
  assert.equal(d.purpose.to, '07')
  assert.equal(d.purpose.toLabel, 'Duplicate')
  assert.equal(d.reworkLikely, false, 'use the fulfilments you have')
})

test('⚠️ but a QUANTITY change does, even on a duplicate', () => {
  // A partner can send purpose 07 and still move a number. The code is not trusted
  // on its own — this is the case that would cost real money.
  const b = newer()
  b.transactionSets[0].lineItems[0].quantity = '25'
  const d = diff850(body(), b)
  assert.equal(d.purpose.to, '07', 'still declared a duplicate')
  assert.equal(d.reworkLikely, true, 'and still needs looking at')
  assert.ok(d.substantive.some((s) => s.label === 'quantity'))
})

test('a purpose of Change or Cancellation always implies rework', () => {
  for (const code of ['01', '04', '05']) {
    const b = newer()
    b.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode = code
    assert.equal(diff850(body(), b).reworkLikely, true, `purpose ${code}`)
  }
})

test('⚠️ an UNKNOWN purpose code implies rework — never "nothing to do"', () => {
  const b = newer()
  b.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode = 'ZZ'
  const d = diff850(body(), b)
  assert.equal(d.reworkLikely, true)
  assert.match(d.purpose.toLabel, /unknown code ZZ/)
})

test('⚠️ an UNRECOGNISED field is substantive, never suppressed', () => {
  // Suppression is an allow-list of noise. If it filtered to what we have labels
  // for, a changed ship-to address would silently vanish from the one report whose
  // job is to catch it.
  const b = newer()
  b.transactionSets[0].somethingNobodyMapped = 'new value'
  const d = diff850(body(), b)
  const hit = d.substantive.find((s) => s.path.includes('somethingNobodyMapped'))
  assert.ok(hit, 'it must appear')
  assert.equal(hit.label, null, 'unlabelled, but present')
  assert.equal(d.reworkLikely, true, 'and unlabelled means look at it')
})

test('a changed ship-to is labelled and flagged', () => {
  const b = newer()
  b.transactionSets[0].shipToPostalCode = '98101'
  const d = diff850(body(), b)
  assert.ok(d.substantive.some((s) => s.label === 'ship-to / location'))
  assert.equal(d.reworkLikely, true)
})

test('identical bodies say so', () => {
  const d = diff850(body(), body())
  assert.equal(d.identical, true)
  assert.equal(d.counts.substantive, 0)
  assert.match(diff850Headline(d), /Identical/)
})

test('the headline names the count of hidden noise, so nobody hunts for it', () => {
  const h = diff850Headline(diff850(body(), newer()))
  assert.match(h, /Duplicate/)
  assert.match(h, /ship not before/)
  assert.match(h, /control-number field/)
})

test('the date qualifier is read from the BODY, not from its array index', () => {
  const b = { transactionSets: [{ dateTimeReference: [{ dateTimeQualifier: '064', date: '20260901' }] }] }
  assert.equal(labelFor('transactionSets.0.dateTimeReference.0.date', b), 'do not deliver before (DTM 064)')
  const c = { transactionSets: [{ dateTimeReference: [{ dateTimeQualifier: '999', date: '20260901' }] }] }
  assert.match(labelFor('transactionSets.0.dateTimeReference.0.date', c), /UNRECOGNISED/)
})

test('x12Date converts CCYYMMDD and leaves everything else alone', () => {
  assert.equal(x12Date('20260822'), '2026-08-22')
  assert.equal(x12Date('1691'), '1691')
  assert.equal(x12Date(null), null)
})

test('flattenBody keeps array positions, so a line moving is visible', () => {
  const f = flattenBody({ a: [{ b: 1 }, { b: 2 }] })
  assert.equal(f['a.0.b'], 1)
  assert.equal(f['a.1.b'], 2)
})

test('07 is Duplicate — the code that answered the real question', () => {
  assert.equal(PURPOSE_CODES['07'], 'Duplicate')
  assert.equal(PURPOSE_CODES['04'], 'Change')
})

test('⚠️ Original -> Duplicate is REASSURING, not a rework signal', () => {
  // The real PO 50073688 case, which this tool got wrong on its first run: the
  // purpose field changing was counted as "a non-date change" and flagged rework on
  // an order that needed none. Its meaning is interpreted by REWORK_PURPOSES; also
  // treating it as an unexplained diff double-counts the one field we understand.
  const before = body()
  before.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode = '00'
  const after = newer()   // purpose '07', ship-not-before moved
  const d = diff850(before, after)
  assert.equal(d.purpose.fromLabel, 'Original')
  assert.equal(d.purpose.toLabel, 'Duplicate')
  assert.equal(d.reworkLikely, false, 'a duplicate that only moved a date needs no rework')
  assert.ok(d.substantive.some((s) => s.label === 'transmission purpose'), 'still shown, just not counted as rework')
})
