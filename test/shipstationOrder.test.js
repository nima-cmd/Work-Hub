import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEdiOrder, buildBoutiqueOrder, billing, cleanStreet, fit, UPS_ACCOUNTS, FIELD_LIMIT,
} from '../src/model/shipstationOrder.js'

// Every rule here was learned against the live API on 2026-08-05 and confirmed on a
// real printed label. These lock them down.

const NOW = new Date('2026-08-05T09:00:00Z')
const SHIPMENT = {
  bolNumber: 'NB1731259', dc: 'HA', authNumber: '00052840190S',
  labels: {
    shipTo: { name: "Macy's Hayward DC", street: '28701 Hall Road', city: 'Hayward', state: 'CA', zip: '94545' },
    freightTerms: 'Third Party Bill', billToAccount: '5R12Y0', billToZip: '30083',
    lines: [{ seq: 1, poNumber: '8040313', storeNumber: '0031', ifNumber: 'IF7468',
      cartonNo: '1', weightLb: 5, lengthIn: 19, widthIn: 12, heightIn: 3 }],
  },
}

test('an EDI carton prints PO+store on line 1 and the auth on line 2', () => {
  const o = buildEdiOrder({ shipment: SHIPMENT, line: SHIPMENT.labels.lines[0], storeId: 351819, now: NOW })
  // Confirmed on a real label: "Trx Ref No.: 8040313-0031"
  assert.equal(o.orderNumber, '8040313-0031')
  assert.equal(o.advancedOptions.customField2, 'AUTH 00052840190S')
  assert.equal(o.weight.value, 5)
  assert.deepEqual(o.dimensions, { units: 'inches', length: 19, width: 12, height: 3 })
  assert.equal(o.orderStatus, 'awaiting_shipment')   // never buys a label
})

// ⚠️ orderKey is the carton's identity and must NOT track the printed number.
// Conflating them forced delete-and-recreate, and ShipStation permanently refuses a
// deleted key (empty 404).
test('orderKey is stable even when the printed number changes', () => {
  const line = { ...SHIPMENT.labels.lines[0] }
  const a = buildEdiOrder({ shipment: SHIPMENT, line, storeId: 1, now: NOW })
  const renamed = { ...SHIPMENT, labels: { ...SHIPMENT.labels, lines: [{ ...line, storeNumber: '9999' }] } }
  const b = buildEdiOrder({ shipment: renamed, line: renamed.labels.lines[0], storeId: 1, now: NOW })
  assert.notEqual(a.orderNumber, b.orderNumber)   // display changed
  assert.equal(a.orderKey, b.orderKey)            // identity did NOT
})

test('"NofM" appears only when the fulfilment genuinely has several cartons', () => {
  // An earlier cut used the worksheet SEQUENCE, so three single-carton boxes read
  // 1, 2, 3 and looked like cartons of a set they were not part of.
  const two = {
    ...SHIPMENT,
    labels: { ...SHIPMENT.labels, lines: [
      { seq: 1, poNumber: '8040291', storeNumber: '0231', ifNumber: 'IF7469', cartonNo: '1', weightLb: 44, lengthIn: 24, widthIn: 16, heightIn: 17 },
      { seq: 2, poNumber: '8040291', storeNumber: '0231', ifNumber: 'IF7469', cartonNo: '2', weightLb: 47, lengthIn: 24, widthIn: 16, heightIn: 17 },
    ] },
  }
  assert.equal(buildEdiOrder({ shipment: two, line: two.labels.lines[0], storeId: 1, now: NOW }).orderNumber, '8040291-0231-1of2')
  assert.equal(buildEdiOrder({ shipment: two, line: two.labels.lines[1], storeId: 1, now: NOW }).orderNumber, '8040291-0231-2of2')
  // ...and the two weights stay distinct — 44 and 47, never averaged.
  assert.equal(buildEdiOrder({ shipment: two, line: two.labels.lines[0], storeId: 1, now: NOW }).weight.value, 44)
  assert.equal(buildEdiOrder({ shipment: two, line: two.labels.lines[1], storeId: 1, now: NOW }).weight.value, 47)
})

// ⚠️ Setting billToMyOtherAccount FORCES my_other_account mode and will not release
// it — a third_party order silently began billing US instead of Macy's. The two
// modes must never be emitted together.
test('the two billing modes are mutually exclusive', () => {
  const tp = billing({ terms: 'Third Party Bill', account: '5R12Y0', zip: '30083' })
  assert.equal(tp.billToParty, 'third_party')
  assert.equal(tp.billToAccount, '5R12Y0')
  assert.equal(tp.billToPostalCode, '30083')
  assert.ok(!('billToMyOtherAccount' in tp), 'third_party must not carry billToMyOtherAccount')
})

test('a boutique order names the Big Box account explicitly', () => {
  // Unspecified, ShipStation bills 18GE01 (ecom). Naghedi's wholesale freight goes
  // on C6J610, so it has to be named — the same hazard upsRates.js guards.
  const o = buildBoutiqueOrder({
    order: { soNumber: 'SO12328', poNumber: null, customer: 'I Am More' },
    fulfilment: { ifNumber: 'IF7442' },
    address: { addressee: 'I Am More', addr1: '6 Spencer Pl', city: 'Scarsdale', state: 'NY', zip: '10583' },
    storeId: 351819, now: NOW,
  })
  assert.equal(o.advancedOptions.billToParty, 'my_other_account')
  assert.equal(o.advancedOptions.billToMyOtherAccount, UPS_ACCOUNTS.bigBox)
  assert.notEqual(o.advancedOptions.billToMyOtherAccount, UPS_ACCOUNTS.small)
})

test('boutique ships with NO weight or dimensions, on purpose', () => {
  // Nima boxes them in ShipStation like retail. Absent, not missing.
  const o = buildBoutiqueOrder({
    order: { soNumber: 'SO12328', customer: 'I Am More' }, fulfilment: { ifNumber: 'IF7442' },
    address: { addr1: '6 Spencer Pl', city: 'Scarsdale', state: 'NY', zip: '10583' }, storeId: 1, now: NOW,
  })
  assert.equal(o.weight, undefined)
  assert.equal(o.dimensions, undefined)
})

test('boutique references the PO when there is one, else the sales order', () => {
  // Live: 10 of 14 boutique IFs have no customer PO.
  const withPo = buildBoutiqueOrder({
    order: { soNumber: 'SO12374', poNumber: '72426N', customer: 'Julian Gold' },
    fulfilment: { ifNumber: 'IF7410' }, address: { addr1: '1 A St', city: 'X', state: 'TX', zip: '7' }, storeId: 1, now: NOW,
  })
  assert.equal(withPo.orderNumber, '72426N')
  assert.equal(withPo.advancedOptions.customField2, 'SO SO12374')   // the other reference

  const noPo = buildBoutiqueOrder({
    order: { soNumber: 'SO12328', poNumber: null, customer: 'I Am More' },
    fulfilment: { ifNumber: 'IF7442' }, address: { addr1: '1 A St', city: 'X', state: 'NY', zip: '1' }, storeId: 1, now: NOW,
  })
  assert.equal(noPo.orderNumber, 'SO12328')
  assert.equal(noPo.advancedOptions.customField2, 'IF IF7442')      // never repeats line 1
})

test('printed fields respect the 26-character limit', () => {
  assert.equal(fit('x'.repeat(40)).length, FIELD_LIMIT)
  const o = buildEdiOrder({
    shipment: { ...SHIPMENT, authNumber: 'A'.repeat(40) },
    line: SHIPMENT.labels.lines[0], storeId: 1, now: NOW,
  })
  assert.ok(o.advancedOptions.customField2.length <= FIELD_LIMIT)
  assert.ok(o.orderNumber.length <= FIELD_LIMIT)
})

// NetSuite's addr1 sometimes repeats the whole address; left alone it prints twice.
test('a duplicated street tail is stripped, but a real street is untouched', () => {
  assert.equal(
    cleanStreet('6 Spencer Pl, Scarsdale, NY 10583', { city: 'Scarsdale', state: 'NY', zip: '10583' }),
    '6 Spencer Pl',
  )
  assert.equal(cleanStreet('28701 Hall Road', { city: 'Hayward', state: 'CA', zip: '94545' }), '28701 Hall Road')
  // never returns empty — a blank street is undeliverable
  assert.equal(cleanStreet('Scarsdale, NY 10583', { city: 'Scarsdale', state: 'NY', zip: '10583' }), 'Scarsdale, NY 10583')
})
