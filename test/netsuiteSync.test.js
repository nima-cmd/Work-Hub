// Unit tests for the live-NetSuite row mappers (pure; no network, no DB).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  mapOrderRow, mapFulfillmentRow, mapInvoiceRow,
  windowStart, orderSql, fulfillmentSql, invoiceSql,
  SO_STATUS, IF_STATUS, INV_STATUS, SO_OPEN_CODES, SO_TERMINAL_CODES,
} from '../src/ingest/netsuiteSync.js'
import { STAGE } from '../src/model/stages.js'

test('windowStart: N days back as YYYY-MM-DD', () => {
  assert.equal(windowStart(30, new Date('2026-07-30T12:00:00Z')), '2026-06-30')
  assert.equal(windowStart(1, new Date('2026-01-01T12:00:00Z')), '2025-12-31')
})

test('status maps cover the live-observed codes', () => {
  // measured 2026-07-30: SO B/D/F open, G billed, H closed; IF A/B/C; INV A/B
  assert.equal(SO_STATUS.B, 'Pending Fulfillment')
  assert.equal(SO_STATUS.G, 'Billed')
  assert.equal(SO_STATUS.H, 'Closed')
  assert.deepEqual(IF_STATUS, { A: 'Picked', B: 'Packed', C: 'Shipped' })
  assert.deepEqual(INV_STATUS, { A: 'Open', B: 'Paid In Full' })
  // G/H must be terminal and NOT also open, or the window logic contradicts itself
  for (const c of SO_TERMINAL_CODES) assert.ok(!SO_OPEN_CODES.includes(c), `${c} in both sets`)
})

test('mapOrderRow: an open order (real SO12288 shape)', () => {
  const r = mapOrderRow({
    tranid: 'SO12288', customer: '519 Claudia Martinez', status: 'B',
    trandate: '2026-07-14', shipdate: '2026-08-11', foreigntotal: '258', otherrefnum: null,
    location: 'Warehouse',
  })
  assert.equal(r.soNumber, 'SO12288')
  // the entity-id prefix must be stripped to match what the CSV path stores
  assert.equal(r.customer, 'Claudia Martinez')
  assert.equal(r.soStatus, 'Pending Fulfillment')
  assert.equal(r.stage, STAGE.OPEN)
  assert.equal(r.terminal, false)
  assert.equal(r.billingStatus, null)
  assert.equal(r.amountPaid, 258)
  assert.equal(r.location, 'Warehouse')
  // isAts must be null (not false) so loadOrders' COALESCE preserves the CSV value
  assert.equal(r.isAts, null)
})

test('mapOrderRow: a terminal order closes out as SHIPPED + Fully Billed', () => {
  for (const code of ['G', 'H']) {
    const r = mapOrderRow({ tranid: 'SO11678', customer: 'X', status: code, foreigntotal: '2772' })
    assert.equal(r.stage, STAGE.SHIPPED, `code ${code}`)
    assert.equal(r.terminal, true)
    assert.equal(r.billingStatus, 'Fully Billed')
  }
})

test('mapOrderRow: pending-approval lands ON_HOLD, unknown code degrades', () => {
  assert.equal(mapOrderRow({ tranid: 'SO1', status: 'A' }).stage, STAGE.ON_HOLD)
  const weird = mapOrderRow({ tranid: 'SO2', status: 'Z' })
  assert.equal(weird.stage, STAGE.OPEN) // not terminal, not on-hold
  assert.equal(weird.soStatus, 'Z') // passes the raw code through rather than blanking
})

test('mapFulfillmentRow: only status C yields actualShipDate', () => {
  const shipped = mapFulfillmentRow({ if_number: 'IF7142', so_number: 'SO12086', status: 'C', trandate: '2026-06-27' })
  assert.equal(shipped.stage, STAGE.SHIPPED)
  assert.equal(shipped.ifStatus, 'Shipped')
  assert.equal(shipped.actualShipDate, '2026-06-27') // this is what stamps the credit

  const packed = mapFulfillmentRow({ if_number: 'IF7407', so_number: 'SO12293', status: 'B', trandate: '2026-07-27' })
  assert.equal(packed.stage, STAGE.PACKED)
  assert.equal(packed.actualShipDate, null)

  const picked = mapFulfillmentRow({ if_number: 'IF1', so_number: 'SO1', status: 'A', trandate: '2026-07-01' })
  assert.equal(picked.stage, STAGE.PICKED)
  assert.equal(picked.actualShipDate, null)
})

test('mapInvoiceRow: unpaid vs paid amounts (credit correctness)', () => {
  const paid = mapInvoiceRow({ inv_number: 'INV11355', so_number: 'SO12288', status: 'B', foreigntotal: '271.74', foreignamountunpaid: '0' })
  assert.equal(paid.invoiceStatus, 'Paid In Full')
  assert.equal(paid.amountRemaining, 0)   // genuinely zero — must not be coerced to null
  assert.equal(paid.amountTotal, 271.74)  // the credit's fallback value

  const open = mapInvoiceRow({ inv_number: 'INV11356', so_number: 'SO12293', status: 'A', foreigntotal: '586.46', foreignamountunpaid: '586.46' })
  assert.equal(open.invoiceStatus, 'Open')
  assert.equal(open.amountRemaining, 586.46)
  assert.equal(open.amountTotal, 586.46)

  // missing amounts stay null rather than becoming 0 (0 would be a false credit)
  const bare = mapInvoiceRow({ inv_number: 'INV1', so_number: 'SO1', status: 'A' })
  assert.equal(bare.amountRemaining, null)
  assert.equal(bare.amountTotal, null)
})

test('queries scope to open OR the recent window, and are SELECT-only', () => {
  const sqls = [orderSql('2026-06-30'), fulfillmentSql('2026-06-30'), invoiceSql('2026-06-30')]
  for (const sql of sqls) {
    assert.match(sql, /2026-06-30/)               // the look-back window is applied
    assert.match(sql, /t\.status IN \('A','B','D','E','F'\)/) // open codes included
    assert.ok(/^\s*SELECT/i.test(sql), 'must be a SELECT')
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|MERGE)\b/i.test(sql), 'must not mutate')
  }
  // child docs join the link table (createdfrom isn't queryable) and must dedupe
  for (const sql of [fulfillmentSql('2026-06-30'), invoiceSql('2026-06-30')]) {
    assert.match(sql, /PreviousTransactionLineLink/)
    assert.match(sql, /SELECT DISTINCT/i)
  }
})
