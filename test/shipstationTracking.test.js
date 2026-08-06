import test from 'node:test'
import assert from 'node:assert/strict'
import { mapTracking, pickLive, recordFromOrder, harvestTracking } from '../src/ingest/shipstationTracking.js'
import { boutiqueOrdersFor, ediOrdersFor } from '../src/ingest/shipstationPush.js'

// ⚠️ The voided-reprint case is real: PO 8040313 DC CL carries THREE shipments
// for one carton, two of them voided reprints. A naive "newest wins" would store
// a dead tracking number as the live one.
test('the live label wins over newer voided reprints', () => {
  const rows = [
    mapTracking({ orderKey: 'WH-IF7468-1', trackingNumber: '1ZLIVE', voided: false, createDate: '2026-08-05T13:10' }),
    mapTracking({ orderKey: 'WH-IF7468-1', trackingNumber: '1ZDEAD', voided: true, createDate: '2026-08-05T14:00' }),
  ]
  const [pick] = pickLive(rows)
  assert.equal(pick.trackingNumber, '1ZLIVE')
  assert.equal(pick.voided, false)
})

test('when every label was voided the card still learns one existed', () => {
  const rows = [
    mapTracking({ orderKey: 'WH-IF7468-1', trackingNumber: '1ZA', voided: true, createDate: '2026-08-05T10:00' }),
    mapTracking({ orderKey: 'WH-IF7468-1', trackingNumber: '1ZB', voided: true, createDate: '2026-08-05T11:00' }),
  ]
  const [pick] = pickLive(rows)
  assert.equal(pick.trackingNumber, '1ZB')
  assert.equal(pick.voided, true) // shown as killed, not hidden
})

test('a shipment belonging to someone else is never claimed', async () => {
  const request = async () => ({ ok: true, data: { pages: 1, shipments: [
    { orderKey: 'WH-IF7456-1', trackingNumber: '1ZOURS', createDate: '2026-08-05T13:10' },
    { orderKey: '2925443645475', trackingNumber: '1ZRETAIL', createDate: '2026-08-05T13:11' }, // a Shopify order
  ] } })
  process.env.SHIPSTATION_API_KEY ||= 'test'
  process.env.SHIPSTATION_API_SECRET ||= 'test'
  const r = await harvestTracking({ ours: new Set(['WH-IF7456-1']), request })
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].trackingNumber, '1ZOURS')
  assert.equal(r.scanned, 2) // it saw both and kept one
})

// The push carries if/carton from the source data; only the BACKFILL parses the
// key, because for orders pushed before the table existed there is nothing else.
test('backfill reads an EDI carton and a boutique order apart, and skips foreign keys', () => {
  const edi = recordFromOrder({ orderKey: 'WH-IF7459-1', orderNumber: '8040313-0008', orderId: 1, advancedOptions: { storeId: 351819 } })
  assert.deepEqual(
    { if: edi.ifNumber, carton: edi.cartonNo, scope: edi.scope, po: edi.poNumber },
    { if: 'IF7459', carton: 1, scope: 'edi', po: '8040313' },
  )
  const boutique = recordFromOrder({ orderKey: 'WH-IF7409', orderNumber: 'SO12371', orderId: 2 })
  assert.deepEqual(
    { if: boutique.ifNumber, carton: boutique.cartonNo, scope: boutique.scope, po: boutique.poNumber },
    { if: 'IF7409', carton: null, scope: 'boutique', po: null },
  )
  // 99,000 retail shipments share the account — none of them are ours.
  assert.equal(recordFromOrder({ orderKey: '2925443645475' }), null)
  assert.equal(recordFromOrder({}), null)
})

// The record is built in the SAME loop as the order it describes, so the two
// cannot drift — the failure mode this repo hits every time it keeps two copies.
test('every pushed order gets exactly one record, aligned by key', () => {
  // Since 2026-08-06 the rows must also satisfy the eligibility gate — Picked, no
  // existing label, domestic UPS on a mapped service (src/model/shipstationEligible.js).
  const rows = [{
    order: { soNumber: 'SO12371', poNumber: null, customer: 'Turner & Co', status: 'Picked' },
    fulfilment: { ifNumber: 'IF7409', status: 'Picked' },
    address: { zip: '19807', city: 'Wilmington', state: 'DE', street1: '14 Guyencourt Road' },
    carrier: 'UPS', shipMethod: '4', labelCount: 0,
  }, {
    order: { soNumber: 'SO12999', poNumber: null, customer: 'No Address Inc', status: 'Picked' },
    fulfilment: { ifNumber: 'IF7999', status: 'Picked' },
    address: null,   // skipped, and must NOT be recorded as pushed
    carrier: 'UPS', shipMethod: '4', labelCount: 0,
  }]
  const { orders, skipped, records } = boutiqueOrdersFor(rows, { storeId: 351819 })
  assert.equal(orders.length, 1)
  assert.equal(skipped.length, 1)
  assert.deepEqual(records.map((r) => r.orderKey), orders.map((o) => o.orderKey))
  assert.equal(records[0].ifNumber, 'IF7409')
  assert.equal(records[0].scope, 'boutique')
})

test('the EDI builder returns orders and their records together', () => {
  const shipment = {
    dc: 'CL', authNumber: 'A123',
    labels: {
      applicable: true, cartons: 1, shipTo: { zip: '30083', city: 'Atlanta', state: 'GA', street1: '1 Way' },
      lines: [{ ifNumber: 'IF7459', cartonNo: 1, poNumber: '8040313', storeNumber: '0008', weightLb: 44 }],
    },
  }
  const { orders, records } = ediOrdersFor([shipment], { storeId: 351819 })
  assert.equal(orders.length, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].orderKey, orders[0].orderKey)
  assert.deepEqual(
    { if: records[0].ifNumber, carton: records[0].cartonNo, po: records[0].poNumber, dc: records[0].dc },
    { if: 'IF7459', carton: 1, po: '8040313', dc: 'CL' },
  )
})
