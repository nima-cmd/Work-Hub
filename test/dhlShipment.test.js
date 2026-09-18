// test/dhlShipment.test.js — assembling a DHL shipment, and refusing to.
//
// ⚠️ ALMOST EVERY TEST HERE IS A REFUSAL, and that is the shape of the module. A waybill
// and an electronic customs declaration cannot be unsent, so the useful behaviour is
// what it declines to guess: a box size, a shipping weight, who pays duty, a name that
// is really an email address.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildShipment, checkParcel, INCOTERMS, DUTY_PAID_BY } from '../src/model/dhlShipment.js'

// IF7702 as it stands after Nima pulled the Cocoa: 9 units, 6 lines, real tariff codes.
const DECLARATION = {
  problems: [],
  lines: [
    { description: 'Handbag - Mercer Large Bucket', names: ['Mercer Large Bucket'], qty: 2, unitPrice: 170, lineTotal: 340, hsCode: '4202228100', coo: 'CN', weightLb: 3.04 },
    { description: 'Handbag - St. Barths Petit Tote', names: ['St. Barths Petit Tote'], qty: 2, unitPrice: 98, lineTotal: 196, hsCode: '4202228100', coo: 'CN', weightLb: 2 },
  ],
}
const SHIPPER = { name: 'NAGHEDI', addressLine1: '825 Western Ave', city: 'Glendale', stateCode: 'CA', postalCode: '91201', countryCode: 'US', phone: '2125551234' }
const RECEIVER = { name: 'Donna Monna', contactName: 'Patricia Canepa', addressLine1: 'VICTOR MAURTUA 276', city: 'Lima', postalCode: '15073', countryCode: 'PE' }
const PARCEL = { lengthIn: 18, widthIn: 14, heightIn: 12, weightLb: 15 }
const TERMS = { incoterm: 'CFR', dutyPaidBy: 'receiver' }
const OK = { declaration: DECLARATION, shipper: SHIPPER, receiver: RECEIVER, parcel: PARCEL, terms: TERMS, productCode: 'P', shipOn: '2026-09-22T10:00:00 GMT-07:00' }

test('a complete shipment builds a payload on the right account', () => {
  const r = buildShipment(OK)
  assert.equal(r.ok, true)
  assert.equal(r.account, '885857720')
  assert.equal(r.payload.accounts[0].number, '885857720')
  assert.equal(r.payload.content.isCustomsDeclarable, true)
  assert.equal(r.payload.content.incoterm, 'CFR')
})

// ── The box is typed in, never computed ─────────────────────────────────────

test('⚠️ every box field is required and NAMES ITSELF', () => {
  // Nima: "we would always want to put in the dimension ourselves."
  const r = checkParcel({ lengthIn: 18, weightLb: 15 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['width', 'height'])
  assert.match(r.why, /measured, not estimated/)
})

test('⚠️ a zero or negative dimension is missing, not a dimension', () => {
  for (const bad of [0, -1, '', null, 'abc']) {
    assert.equal(checkParcel({ ...PARCEL, heightIn: bad }).ok, false, `height ${bad}`)
  }
})

test('⚠️ the GOODS weight never becomes the SHIPPING weight', () => {
  // IF7702's items sum to 12.75 lb — merchandise only, no carton, no dunnage. DHL bills
  // on the greater of actual and dimensional weight, so pre-filling from the item sum
  // would bill low on every parcel.
  const r = buildShipment(OK)
  assert.equal(r.summary.shippingWeightLb, 15, 'what a person weighed')
  assert.equal(r.summary.goodsWeightLb, 5.04, 'the item records, offered only as a reference')
  assert.notEqual(r.summary.shippingWeightLb, r.summary.goodsWeightLb)
  assert.equal(r.payload.content.packages[0].weight, 15)
})

test('⚠️ no weight at all is a refusal — it never falls back to the goods weight', () => {
  const r = buildShipment({ ...OK, parcel: { ...PARCEL, weightLb: null } })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /weight/.test(p)))
})

// ── The declaration's own gate is honoured ──────────────────────────────────

test("⚠️ a blocked declaration blocks the SHIPMENT — verbatim", () => {
  // Passing it through would transmit electronically the exact declaration the
  // paperwork gate exists to stop.
  const r = buildShipment({
    ...OK,
    declaration: { ...DECLARATION, problems: ['NS09999XX-NEW: no tariff code (HTS) on the item record'] },
  })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /no tariff code/.test(p)))
})

test('an empty declaration is refused', () => {
  const r = buildShipment({ ...OK, declaration: { problems: [], lines: [] } })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /nothing to declare/.test(p)))
})

test("the item's own tariff code reaches DHL, dots intact", () => {
  const r = buildShipment({
    ...OK,
    declaration: { problems: [], lines: [{ ...DECLARATION.lines[0], hsCode: '6404.20.4060' }] },
  })
  assert.equal(r.payload.content.exportDeclaration.lineItems[0].commodityCodes[0].value, '6404.20.4060')
})

// ── Terms are per customer and have no defaults ─────────────────────────────

test('⚠️ no incoterm and no duty payer are REFUSALS, not defaults', () => {
  // These live in the DHL address book per customer, not in NetSuite. Silently
  // declaring DDP when the customer pays duty hands Naghedi a bill it never agreed to.
  const r = buildShipment({ ...OK, terms: {} })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /no incoterm/.test(p)))
  assert.ok(r.problems.some((p) => /nobody is named to pay duty/.test(p)))
})

test('an incoterm we do not recognise is refused rather than passed through', () => {
  const r = buildShipment({ ...OK, terms: { incoterm: 'XYZ', dutyPaidBy: 'receiver' } })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /not an incoterm/.test(p)))
  assert.ok(INCOTERMS.includes('CFR') && DUTY_PAID_BY.includes('receiver'))
})

// ── Addresses ───────────────────────────────────────────────────────────────

test('⚠️ a name that is an EMAIL ADDRESS is caught', () => {
  // NetSuite holds "contact: patricia@donnamonnatw.com" as the addressee on SO12576.
  // DHL would accept it and print it on the waybill.
  const r = buildShipment({
    ...OK,
    receiver: { ...RECEIVER, name: 'contact: patricia@donnamonnatw.com' },
  })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /looks like an email address/.test(p)))
})

test('a missing street, city or country is named per side', () => {
  const r = buildShipment({ ...OK, receiver: { ...RECEIVER, city: '' } })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /receiver address has no city/.test(p)))
})

// ── The account rule still applies ──────────────────────────────────────────

test('⚠️ a China-origin shipment is refused here too', () => {
  const r = buildShipment({ ...OK, shipper: { ...SHIPPER, countryCode: 'CN', city: 'Shenzhen' } })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /never been confirmed/.test(p)))
})

test('⚠️ ONE package — multi-box is not guessed at', () => {
  // Splitting a declaration across cartons is a packing decision, not arithmetic.
  const r = buildShipment(OK)
  assert.equal(r.payload.content.packages.length, 1)
})

test('every problem is collected, not just the first', () => {
  const r = buildShipment({ declaration: null, parcel: {}, terms: {} })
  assert.equal(r.ok, false)
  assert.ok(r.problems.length > 5, `only got: ${r.problems.join(' | ')}`)
})
