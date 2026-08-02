// Unit tests for the live-NetSuite row mappers (pure; no network, no DB).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  mapOrderRow, mapFulfillmentRow, mapInvoiceRow,
  windowStart, orderSql, fulfillmentSql, invoiceSql, invoiceBySo,
  SO_STATUS, IF_STATUS, INV_STATUS, SO_OPEN_CODES, SO_TERMINAL_CODES,
  APPROVAL_ON_HOLD, APPROVAL_APPROVED,
  mapPurchaseOrderRow, foldPurchaseOrderLines, purchaseOrderSql, PO_OPEN_CODES,
  mapOrderConfirmationRow, foldOrderConfirmationLines, orderConfirmationSql, OC_OPEN_CODES,
  orderLineSql, foldOrderLines, NON_ITEM_LINE_TYPES,
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

test('mapInvoiceRow: the approved-to-ship gate is decoded from the custom list', () => {
  // Nima's step 5. These four codes were queried live 2026-07-31; the strings
  // must match EXACTLY, because server/queries.js launchState substring-matches
  // them ('approved', 'pending payment') and pipeline.js computeFlags matches
  // 'fob'. A renamed string breaks the gate silently.
  const approved = mapInvoiceRow({ inv_number: 'INV11361', so_number: 'SO12267', status: 'A', invoice_status: 3 })
  assert.equal(approved.shippingStatus, 'Approved For Shipping')
  assert.equal(mapInvoiceRow({ inv_number: 'I', invoice_status: 1 }).shippingStatus, 'Pending Payment')
  assert.equal(mapInvoiceRow({ inv_number: 'I', invoice_status: 4 }).shippingStatus, 'Shipped')
  assert.equal(mapInvoiceRow({ inv_number: 'I', invoice_status: 5 }).shippingStatus, 'FOB Pending Approval')

  // SuiteQL returns THIS custom list as a number while the SO's approval list
  // arrives as a string — so the mapper must not care which it gets.
  assert.equal(mapInvoiceRow({ inv_number: 'I', invoice_status: '3' }).shippingStatus, 'Approved For Shipping')

  // An unset or unknown code must be '' so loadInvoices' COALESCE preserves what
  // we already knew, rather than writing a wrong gate value.
  assert.equal(mapInvoiceRow({ inv_number: 'I' }).shippingStatus, '')
  assert.equal(mapInvoiceRow({ inv_number: 'I', invoice_status: 2 }).shippingStatus, '')

  // The gate must NOT set a stage: stageFromShipping would promote every
  // 'Shipped'/'Approved' invoice's order and reshuffle the Kanban queues, which
  // is a separate decision from making the gate live.
  assert.equal(approved.stage, undefined)
})

test('invoiceSql: asks for the gate field — step 5 is dead without it', () => {
  assert.match(invoiceSql('2026-06-30'), /custbody_invoice_status/)
})

test('invoiceBySo: links an IF to its invoice, and refuses to guess', () => {
  // Without this the live path never wrote fulfillments.invoice_number (148 of
  // 156 rows null), so getLaunchBay's `invoices ON inv_number = f.invoice_number`
  // join matched nothing and every bay row read "awaiting invoice" — including
  // three whose invoice was already in the same database.
  const { bySo, ambiguous } = invoiceBySo([
    { so_number: 'SO12267', inv_number: 'INV11361' },
    { so_number: 'SO12373', inv_number: 'INV11412' },
    // the same invoice twice (the SuiteQL link table is LINE-level) is not a conflict
    { so_number: 'SO12267', inv_number: 'INV11361' },
    // two genuinely different invoices on one SO — unknowable, so unlinked
    { so_number: 'SO12292', inv_number: 'INV11411' },
    { so_number: 'SO12292', inv_number: 'INV11500' },
    { so_number: '', inv_number: 'INV9' },        // unlinked invoice, ignored
  ])
  assert.equal(bySo.get('SO12267'), 'INV11361')
  assert.equal(bySo.get('SO12373'), 'INV11412')
  assert.equal(bySo.has('SO12292'), false, 'an ambiguous SO must get no link at all')
  assert.deepEqual(ambiguous, ['SO12292'])
  assert.equal(bySo.size, 2)
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

test('mapOrderRow: an On Hold order is NOT pending fulfilment', () => {
  // The bug this fixes. In this account the native Pending-Approval status is
  // never used — a held order still reads status B "Pending Fulfillment" and the
  // hold lives only on custbody_approval_status. Measured live 2026-07-31: all
  // 27 held orders were sitting in Kanban's Pending Fulfillment as work to start.
  const held = mapOrderRow({ tranid: 'SO12303', customer: 'Joseph- New Orleans', status: 'B', approval_status: APPROVAL_ON_HOLD })
  assert.equal(held.stage, STAGE.ON_HOLD)
  // NetSuite's own status string stays honest — it really does say Pending
  // Fulfillment. Only the stage (and so the queue) changes.
  assert.equal(held.soStatus, 'Pending Fulfillment')
})

test('mapOrderRow: approved and unset both stay OPEN', () => {
  assert.equal(mapOrderRow({ tranid: 'SO1', status: 'B', approval_status: APPROVAL_APPROVED }).stage, STAGE.OPEN)
  // Absent field must not be read as held — the CSV path supplies no such value.
  assert.equal(mapOrderRow({ tranid: 'SO2', status: 'B' }).stage, STAGE.OPEN)
  assert.equal(mapOrderRow({ tranid: 'SO3', status: 'B', approval_status: null }).stage, STAGE.OPEN)
})

test('mapOrderRow: SuiteQL hands the custom list back as a STRING', () => {
  // It arrives as "2", not 2. A === comparison against the number silently never
  // matches, which is the same shape of bug as reading the field not at all.
  assert.equal(mapOrderRow({ tranid: 'SO4', status: 'B', approval_status: '2' }).stage, STAGE.ON_HOLD)
})

test('orderSql: asks for the approval field — the hold is invisible without it', () => {
  assert.match(orderSql('2026-06-30'), /custbody_approval_status/)
})

test('a shipped order stays shipped even if it was once held', () => {
  // Terminal wins: a held-then-closed order must not reappear as work.
  const r = mapOrderRow({ tranid: 'SO5', status: 'G', approval_status: APPROVAL_ON_HOLD })
  assert.equal(r.stage, STAGE.SHIPPED)
})

test('mapOrderRow: a placeholder order is flagged so it can be kept out of the queues', () => {
  // A temp order that holds stock until the real one arrives — Nima: "we don't
  // need to track it." SuiteQL returns a checkbox as 'T'/'F'.
  assert.equal(mapOrderRow({ tranid: 'SO12261', status: 'B', is_placeholder: 'T' }).isPlaceholder, true)
  assert.equal(mapOrderRow({ tranid: 'SO12262', status: 'B', is_placeholder: 'F' }).isPlaceholder, false)
})

test('mapOrderRow: an absent placeholder field is null, NOT false', () => {
  // The CSV path knows nothing about this field. Sending false would let a CSV
  // import overwrite what the live pull established — the same null-clobber that
  // is_ats already guards against with a COALESCE in loadOrders.
  assert.equal(mapOrderRow({ tranid: 'SO1', status: 'B' }).isPlaceholder, null)
  assert.equal(mapOrderRow({ tranid: 'SO2', status: 'B', is_placeholder: null }).isPlaceholder, null)
})

test('orderSql: asks for the placeholder field too', () => {
  assert.match(orderSql('2026-06-30'), /custbody_is_placeholder/)
})

// ── purchase orders (inbound supply) ─────────────────────────────────────────

test('mapPurchaseOrderRow: matches what the CSV path writes', () => {
  // Real PO1754 line, measured live 2026-08-02 against the frozen CSV row.
  const r = mapPurchaseOrderRow({
    po_number: 'PO1754',
    vendor: 'Guangzhou Fantasy Leather Factory (Chelly)',
    status: 'Purchase Order : Pending Receipt',
    duedate: '2026-07-15',
    destination: 'Virtual Warehouse',
    item: 'SN13012LD-MIAMI-PINK',
    quantity: '75',
    quantityshiprecv: '0',
  })
  assert.equal(r.poNumber, 'PO1754')
  assert.equal(r.item, 'SN13012LD-MIAMI-PINK')
  assert.equal(r.expectedReceipt, '2026-07-15')
  assert.equal(r.qtyOrdered, 75)
  assert.equal(r.qtyRemaining, 75)
  // BUILTIN.DF prefixes the record type; the CSV column carries the bare status.
  assert.equal(r.status, 'Pending Receipt')
  assert.equal(r.source, 'PoReceiving')
})

test('mapPurchaseOrderRow: remaining is ordered minus received', () => {
  const r = mapPurchaseOrderRow({
    po_number: 'PO1738', item: 'SN01-BLACK', quantity: '100', quantityshiprecv: '30',
  })
  assert.equal(r.qtyReceived, 30)
  assert.equal(r.qtyRemaining, 70)
})

test('purchaseOrderSql: takes the location FULL path, never the leaf', () => {
  const sql = purchaseOrderSql('2026-07-03')
  // The OC↔PO match key joins to order_confirmations.location, which stores
  // "Warehouse Bulk : Nordstrom". BUILTIN.DF on the custom field returns only
  // "Nordstrom" and would silently match nothing — and would also aim the
  // warehouse app's Inventory Transfer CSVs at the wrong location.
  assert.match(sql, /loc\.fullname AS destination/)
  assert.doesNotMatch(sql, /BUILTIN\.DF\(t\.custbody_acs_final_destination\)/)
  assert.match(sql, /LEFT JOIN location loc/)
  // A PO with no destination set must still come through — those 16 POs are a
  // real finding to surface, not rows to drop.
  assert.doesNotMatch(sql, /INNER JOIN location/)
})

test('purchaseOrderSql: scopes to open POs or recent changes', () => {
  const sql = purchaseOrderSql('2026-07-03')
  assert.match(sql, /t\.type='PurchOrd'/)
  assert.match(sql, /tl\.mainline='F'/)
  for (const c of PO_OPEN_CODES) assert.match(sql, new RegExp(`'${c}'`))
  assert.match(sql, /2026-07-03/)
})

test('foldPurchaseOrderLines: sums an item repeated across lines', () => {
  // (po_number, item) is the primary key, so two lines for one item must be
  // added together — the upsert would otherwise keep only the last one.
  const out = foldPurchaseOrderLines([
    { po_number: 'PO1', item: 'SN-A', quantity: '10', quantityshiprecv: '0' },
    { po_number: 'PO1', item: 'SN-A', quantity: '5', quantityshiprecv: '0' },
    { po_number: 'PO1', item: 'SN-B', quantity: '7', quantityshiprecv: '0' },
  ])
  assert.equal(out.length, 2)
  const a = out.find((r) => r.item === 'SN-A')
  assert.equal(a.qtyOrdered, 15)
  assert.equal(a.qtyRemaining, 15)
})

test('foldPurchaseOrderLines: drops fully received lines, keeps partials', () => {
  // Mirrors the saved search's own scope: every row the CSV path wrote still
  // owed units. A fully received line is supply that no longer exists.
  const out = foldPurchaseOrderLines([
    { po_number: 'PO1', item: 'DONE', quantity: '10', quantityshiprecv: '10' },
    { po_number: 'PO1', item: 'PART', quantity: '10', quantityshiprecv: '4' },
  ])
  assert.deepEqual(out.map((r) => r.item), ['PART'])
  assert.equal(out[0].qtyRemaining, 6)
})

test('foldPurchaseOrderLines: skips rows missing either key half', () => {
  const out = foldPurchaseOrderLines([
    { po_number: '', item: 'SN-A', quantity: '5' },
    { po_number: 'PO1', item: '', quantity: '5' },
  ])
  assert.deepEqual(out, [])
})

// ── order confirmations (pre-SO demand) ──────────────────────────────────────

test('mapOrderConfirmationRow: matches what the CSV path writes', () => {
  // Real OC1558 line, measured live 2026-08-02 against the frozen CSV row.
  const r = mapOrderConfirmationRow({
    oc_number: 'OC1558',
    customer: '509 Kapok',
    status: 'Order Confirmation : Open',
    po_check_number: 'hol/res  bags',
    startdate: '2026-11-15',
    item: 'SN04023QJ-LINEN',
    quantity: '-12',
    location: 'Warehouse',
  })
  assert.equal(r.ocNumber, 'OC1558')
  assert.equal(r.item, 'SN04023QJ-LINEN')
  // Estimate lines store the quantity NEGATIVE; the CSV column carried +12.
  assert.equal(r.qty, 12)
  // BUILTIN.DF prefixes the (renamed) record type; the CSV carried bare "Open".
  assert.equal(r.status, 'Open')
  assert.equal(r.customer, 'Kapok') // entity id stripped
  assert.equal(r.location, 'Warehouse')
  assert.equal(r.poCheckNumber, 'hol/res  bags')
  assert.equal(r.orderStartDate, '2026-11-15')
  assert.equal(r.source, 'OcPipeline')
})

test('mapOrderConfirmationRow: a null quantity stays null, never 0', () => {
  // Non-item lines (OC1596's "EU Distributor" discount) genuinely have no
  // quantity. The upsert COALESCEs, so a 0 here would overwrite a real number
  // while a null correctly leaves the stored value alone.
  const r = mapOrderConfirmationRow({
    oc_number: 'OC1596', item: 'EU Distributor', quantity: null, status: 'Order Confirmation : Open',
  })
  assert.equal(r.qty, null)
})

test('orderConfirmationSql: takes the location FULL path, never the leaf', () => {
  const sql = orderConfirmationSql()
  // Same trap as purchase_orders.destination — this is the other half of the
  // OC↔PO match key and holds "Warehouse Bulk : Nordstrom".
  assert.match(sql, /COALESCE\(lloc\.fullname, hloc\.fullname\) AS location/)
  assert.match(sql, /LEFT JOIN location lloc/)
  // An OC with no location must still come through, not be joined away.
  assert.doesNotMatch(sql, /INNER JOIN location/)
})

test('orderConfirmationSql: scopes to the not-yet-converted statuses only', () => {
  const sql = orderConfirmationSql()
  // The record is renamed "Order Confirmation" in this account but is still an
  // Estimate underneath.
  assert.match(sql, /t\.type='Estimate'/)
  assert.match(sql, /tl\.mainline='F'/)
  for (const c of OC_OPEN_CODES) assert.match(sql, new RegExp(`'${c}'`))
  // B (Processed) = converted to a Sales Order. Including it would double-count
  // real orders as open demand.
  assert.deepEqual(OC_OPEN_CODES, ['A', 'X'])
  // ⚠️ And deliberately NO lastmodifieddate window, unlike purchaseOrderSql: a
  // converted OC must LEAVE the table, so widening the net would pull it back.
  assert.doesNotMatch(sql, /lastmodifieddate/)
})

test('foldOrderConfirmationLines: sums an item repeated across lines', () => {
  // Real OC1596 shape: line 7 orders 53 of SN02264NB-TEAK and an amendment
  // appends 5 more at line 120. The frozen CSV table records 5 — the
  // row-at-a-time upsert let the later line overwrite the earlier one. Both
  // lines are open demand for the same SKU, so 58 is the honest figure.
  const out = foldOrderConfirmationLines([
    { oc_number: 'OC1596', item: 'SN02264NB-TEAK', quantity: '-53' },
    { oc_number: 'OC1596', item: 'SN02264NB-TEAK', quantity: '-5' },
    { oc_number: 'OC1596', item: 'SN-B', quantity: '-7' },
  ])
  assert.equal(out.length, 2)
  assert.equal(out.find((r) => r.item === 'SN02264NB-TEAK').qty, 58)
})

test('foldOrderConfirmationLines: drops Memorized templates and keyless rows', () => {
  // "Memorized" rows are recurring-transaction TEMPLATES, not real dated OCs —
  // the same filter fromOcPipeline applies, so both paths agree on what counts.
  const out = foldOrderConfirmationLines([
    { oc_number: 'Memorized', item: 'SN-A', quantity: '-5' },
    { oc_number: '', item: 'SN-A', quantity: '-5' },
    { oc_number: 'OC1', item: '', quantity: '-5' },
  ])
  assert.deepEqual(out, [])
})

// ── SO line quantities ───────────────────────────────────────────────────────

test('foldOrderLines: freight and tax lines are NOT goods', () => {
  // Real SO12419, measured live 2026-08-02: seven item lines totalling 14 units,
  // all 14 committed — plus a ShipItem and a TaxItem that each carry quantity 1
  // and no quantitycommitted. The CSV's "Sum of Quantity" counted all nine, so
  // the app stored 16 ordered / 14 allocated and flagged the order "short 2".
  // It was never short. That one pattern produced 87% of the shortage flags.
  const rows = [
    ...[3, 1, 2, 2, 2, 2, 2].map((q) => ({
      tranid: 'SO12419', itemtype: 'InvtPart',
      quantity: String(-q), quantitycommitted: String(q), quantityshiprecv: '0',
    })),
    { tranid: 'SO12419', itemtype: 'ShipItem', quantity: '-1', quantitycommitted: null, quantityshiprecv: '0' },
    { tranid: 'SO12419', itemtype: 'TaxItem', quantity: '-1', quantitycommitted: null, quantityshiprecv: '0' },
  ]
  const q = foldOrderLines(rows).get('SO12419')
  assert.deepEqual(q, { qtyOrdered: 14, qtyAllocated: 14, qtyFulfilled: 0 })
  // The whole point: no shortage left to report.
  assert.equal(q.qtyOrdered - q.qtyAllocated - q.qtyFulfilled, 0)
})

test('foldOrderLines: ABS the ordered quantity but not the other two', () => {
  // Sales-order lines come back NEGATIVE (−3 for an order of 3) exactly as
  // Estimate lines do — 1,884 of 1,884 open lines, zero positive. Committed and
  // ship/recv are already positive and must pass through untouched.
  const q = foldOrderLines([
    { tranid: 'SO1', itemtype: 'InvtPart', quantity: '-3', quantitycommitted: '1', quantityshiprecv: '2' },
  ]).get('SO1')
  assert.deepEqual(q, { qtyOrdered: 3, qtyAllocated: 1, qtyFulfilled: 2 })
})

test('foldOrderLines: an unknown item type still counts as goods', () => {
  // A DENY list, not an allow list of InvtPart: the day an Assembly or Kit line
  // shows up its units must land in demand rather than silently vanish.
  const q = foldOrderLines([
    { tranid: 'SO1', itemtype: 'Assembly', quantity: '-4', quantitycommitted: '4', quantityshiprecv: '0' },
  ]).get('SO1')
  assert.equal(q.qtyOrdered, 4)
  assert.ok(!NON_ITEM_LINE_TYPES.includes('Assembly'))
})

test('foldOrderLines: seen-but-uncountable is 0; never-seen is absent', () => {
  // The two must not be conflated. An order whose lines are all closed or all
  // freight/tax HAS an answer, and it is zero open units — writing it stops a
  // stale CSV figure (freight and tax included) from living on through COALESCE.
  // An order the pull never returned has NO answer, so it must stay absent and
  // let COALESCE keep whatever was known.
  const out = foldOrderLines([
    { tranid: 'SO1', itemtype: 'ShipItem', quantity: '-1', quantitycommitted: null, quantityshiprecv: '0', isclosed: 'F' },
    { tranid: 'SO2', itemtype: 'InvtPart', quantity: '-9', quantitycommitted: null, quantityshiprecv: '0', isclosed: 'T' },
    { tranid: '', itemtype: 'InvtPart', quantity: '-9', quantitycommitted: '9', quantityshiprecv: '0', isclosed: 'F' },
  ])
  assert.deepEqual(out.get('SO1'), { qtyOrdered: 0, qtyAllocated: 0, qtyFulfilled: 0 })
  assert.deepEqual(out.get('SO2'), { qtyOrdered: 0, qtyAllocated: 0, qtyFulfilled: 0 })
  assert.equal(out.has('SO3'), false) // never seen — the record carries no qty keys
  assert.equal(out.size, 2)
})

test('foldOrderLines: sums repeated lines for the same SO', () => {
  const q = foldOrderLines([
    { tranid: 'SO1', itemtype: 'InvtPart', quantity: '-5', quantitycommitted: '5', quantityshiprecv: '0' },
    { tranid: 'so1', itemtype: 'InvtPart', quantity: '-6', quantitycommitted: '0', quantityshiprecv: '6' },
  ]).get('SO1')
  assert.deepEqual(q, { qtyOrdered: 11, qtyAllocated: 5, qtyFulfilled: 6 })
})

test('orderLineSql: line grain only, and the same open-or-recent window', () => {
  const sql = orderLineSql('2026-07-01')
  // mainline='F' drops the header row, which has a null itemtype and no quantity.
  assert.match(sql, /tl\.mainline='F'/)
  // quantityfulfilled is NOT_EXPOSED to SuiteQL; quantityshiprecv is the one that works.
  assert.match(sql, /quantityshiprecv/)
  assert.doesNotMatch(sql, /quantityfulfilled/)
  assert.match(sql, /lastmodifieddate >= TO_DATE\('2026-07-01'/)
})

test('foldOrderLines: a closed line is cancelled demand, not a shortage', () => {
  // Real SO12159, partially fulfilled, two closed lines totalling 18 units.
  // A closed line can never be committed and can never ship — measured live, all
  // 76 in the window carry 0 committed and 0 ship/recv — so leaving it in
  // `ordered` manufactures a shortage with nothing that could ever clear it.
  const q = foldOrderLines([
    { tranid: 'SO12159', itemtype: 'InvtPart', quantity: '-10', quantitycommitted: '10', quantityshiprecv: '0', isclosed: 'F' },
    { tranid: 'SO12159', itemtype: 'InvtPart', quantity: '-4', quantitycommitted: null, quantityshiprecv: '0', isclosed: 'T' },
    { tranid: 'SO12159', itemtype: 'InvtPart', quantity: '-14', quantitycommitted: null, quantityshiprecv: '0', isclosed: 'T' },
  ]).get('SO12159')
  assert.deepEqual(q, { qtyOrdered: 10, qtyAllocated: 10, qtyFulfilled: 0 })
})

test('orderLineSql: selects isclosed so cancelled lines can be dropped', () => {
  assert.match(orderLineSql('2026-07-01'), /tl\.isclosed/)
})
