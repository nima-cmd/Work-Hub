// Unit tests for the pure model logic (no DB, no network).
// Run: `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv } from '../src/ingest/csv.js'
import {
  refNumber, cleanName, num, fromOpenSalesOrders, fromUnpackedFulfillments, fromFulfillmentPipeline,
  fromPoReceiving, fromOcPipeline,
} from '../src/ingest/savedSearches.js'
import { detectSource } from '../src/ingest/detect.js'
import { buildPipeline, computeFlags } from '../src/model/pipeline.js'
import { deriveSource } from '../src/model/source.js'
import { STAGE } from '../src/model/stages.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeAffection } from '../src/model/affection.js'
import { groupOrdersByPo } from '../src/model/poGroups.js'
import { CHARACTERS, resolveCharacterForSender } from '../src/model/characters.js'
import { SHIPS, resolveShipForKey } from '../src/model/ships.js'
import { DIALOGUE, speakLine, taskContext } from '../src/model/dialogue.js'
import { deriveWork, computeEdiWork, MISSED_AFTER_DAYS } from '../src/model/ediWork.js'
import { normalizeDocNumber } from '../src/model/netsuiteDocs.js'
import { computeRoute } from '../src/model/routePlan.js'
import { buildRouteItems, applyDayPlan } from '../src/model/routeItems.js'
import { fromEdiPackagesVolume, fromShipCentralQueue } from '../src/ingest/savedSearches.js'
import { consolidateRouting, netsuiteShippedVerdict } from '../src/model/routing.js'
import { parseBoxDims, splitPoDc, mapEdiPackageRows } from '../src/ingest/ediPackagesLive.js'
import { partnerForDc, dcLabel } from '../src/model/dc.js'
import { extractPoDates } from '../src/ingest/orderfulDates.js'
import { resolveLabelChips } from '../src/model/gmailLabels.js'

test('parseCsv handles quoted commas and duplicate headers', () => {
  const rows = parseCsv('a,b,b\n"x,y",2,3\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].a, 'x,y') // comma preserved inside quotes
  assert.equal(rows[0].b, '2') // first "b"
  assert.equal(rows[0]['b (2)'], '3') // duplicate header disambiguated
})

test('saved-search helpers normalize NetSuite formats', () => {
  assert.equal(refNumber('Sales Order #SO12043'), 'SO12043')
  assert.equal(refNumber('Transfer Order #TO171'), 'TO171')
  assert.equal(cleanName('494 Level Shoes'), 'Level Shoes')
  assert.equal(num('.00'), 0)
  assert.equal(num('6,837.00'), 6837)
  assert.equal(num(''), null)
})

test('buildPipeline merges sources by SO and picks the furthest stage', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', customer: 'X' },
    { source: 'inv', stage: STAGE.INVOICED, soNumber: 'SO1', shippingStatus: 'Pending Payment', customer: 'X' },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders.length, 1)
  assert.equal(orders[0].soNumber, 'SO1')
  assert.equal(orders[0].stage, STAGE.INVOICED) // invoiced (rank 4) beats picked (rank 2)
  assert.equal(orders[0].fulfillments.length, 1)
})

test('buildPipeline drops Transfer Order records — not tracked', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'TO171', ifNumber: 'IF7145', customer: 'X' },
    { source: 'open', stage: STAGE.OPEN, soNumber: 'SO1', customer: 'Y' },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders.length, 1)
  assert.equal(orders[0].soNumber, 'SO1')
})

test('fromUnpackedFulfillments drops Transfer Order rows at the source', () => {
  // Regression: buildPipeline() skips TO# records, but loadFulfillments/
  // loadInvoices read the raw mapper output directly and don't go through
  // buildPipeline — so a TO row surviving the mapper caused a foreign-key
  // crash (fulfillments row referencing an order that was never inserted).
  const rows = fromUnpackedFulfillments([
    { 'Document Number': 'IF7145', 'Created From': 'Transfer Order #TO171', Status: 'Picked', Date: '5/26/2026' },
    { 'Document Number': 'IF7264', 'Created From': 'Sales Order #SO12062', Status: 'Picked', Date: '6/29/2026' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].soNumber, 'SO12062')
})

test('computeFlags reads shortage through ATS (only while Open)', () => {
  const today = new Date('2026-07-08')
  const ats = computeFlags(
    { stage: STAGE.OPEN, isAts: true, qtyOrdered: 8, qtyAllocated: 6, qtyFulfilled: 0, fulfillments: [] },
    today,
  )
  assert.ok(ats.some((f) => f.key === 'STOCK_SHORT'))

  const nonAts = computeFlags(
    { stage: STAGE.OPEN, isAts: false, qtyOrdered: 10, qtyAllocated: 2, qtyFulfilled: 0, fulfillments: [] },
    today,
  )
  assert.ok(nonAts.some((f) => f.key === 'AWAITING_PO'))
  assert.ok(!nonAts.some((f) => f.key === 'STOCK_SHORT'))
})

test('computeFlags suppresses shortage once an IF exists (Picked+)', () => {
  // Eleanor case: order for 5, only 3 committed, but an IF is already picked
  // and shipping the 3 on hand. The "short 2" is a settled decision, not an
  // alert — so no STOCK_SHORT once the order has moved past Open.
  const flags = computeFlags(
    { stage: STAGE.PICKED, isAts: true, qtyOrdered: 5, qtyAllocated: 3, qtyFulfilled: 0, fulfillments: [{ status: 'Picked' }] },
    new Date('2026-07-08'),
  )
  assert.ok(!flags.some((f) => f.key === 'STOCK_SHORT'))
})

test('computeFlags flags an overdue ship date', () => {
  const flags = computeFlags(
    { shipDate: new Date('2026-06-01'), fulfillments: [] },
    new Date('2026-07-08'),
  )
  assert.ok(flags.some((f) => f.key === 'OVERDUE'))
})

test('computeFlags flags a partially-fulfilled order with open units', () => {
  // SO12074 case: shipped 26 of 38 with an invoice, so it reads as Approved —
  // the flag must surface that 12 units still need a 2nd IF or disposition.
  const flags = computeFlags(
    { stage: STAGE.APPROVED, soStatus: 'Partially Fulfilled', qtyOrdered: 38, qtyFulfilled: 26, fulfillments: [] },
    new Date('2026-07-09'),
  )
  const partial = flags.find((f) => f.key === 'PARTIAL')
  assert.ok(partial, 'PARTIAL flag should fire')
  assert.match(partial.label, /12 units/)
})

test('deriveSource classifies EDI partners', () => {
  assert.equal(deriveSource('599 Nordstrom - Cedar Rapids'), 'edi')
  assert.equal(deriveSource('166 ShopBop'), 'edi')
  assert.equal(deriveSource('Bloomingdale’s'), 'edi')
  assert.equal(deriveSource('509 Kapok'), 'boutique')
})

test('fromOpenSalesOrders gates on Approval Status and reads invoice', () => {
  const rows = fromOpenSalesOrders([
    { 'Document Number': 'SO1', 'Maximum of Approval Status': 'On Hold' },
    { 'Document Number': 'SO2', 'Maximum of Approval Status': 'Approved' },
    { 'Document Number': 'SO3' }, // no column at all — must default to OPEN, not hidden
    // has an invoice → INVOICED (its invoice columns come from the Billing join)
    {
      'Document Number': 'SO4', 'Maximum of Approval Status': 'Approved',
      'Maximum of Document Number': 'INV999', 'Maximum of Status (2)': 'Open',
      'Maximum of Invoice Status': 'Approved For Shipping',
    },
  ])
  assert.equal(rows.find((r) => r.soNumber === 'SO1').stage, STAGE.ON_HOLD)
  assert.equal(rows.find((r) => r.soNumber === 'SO2').stage, STAGE.OPEN)
  assert.equal(rows.find((r) => r.soNumber === 'SO3').stage, STAGE.OPEN)
  const so4 = rows.find((r) => r.soNumber === 'SO4')
  assert.equal(so4.stage, STAGE.INVOICED) // buildPipeline promotes to APPROVED via shippingStatus
  assert.equal(so4.invoice, 'INV999')
  assert.equal(so4.shippingStatus, 'Approved For Shipping')
})

test('fromFulfillmentPipeline maps Picked/Packed and drops Transfer Orders', () => {
  const rows = fromFulfillmentPipeline([
    { 'Document Number': 'IF1', 'Maximum of Created From': 'Sales Order #SO1', 'Maximum of Status': 'Picked', 'Maximum of Date': '7/8/2026', 'Maximum of Name': 'Eleanor' },
    { 'Document Number': 'IF2', 'Maximum of Created From': 'Sales Order #SO2', 'Maximum of Status': 'Packed', 'Maximum of Date': '7/2/2026' },
    { 'Document Number': 'IF3', 'Maximum of Created From': 'Transfer Order #TO9', 'Maximum of Status': 'Picked' },
  ])
  assert.equal(rows.length, 2) // TO dropped
  assert.equal(rows.find((r) => r.ifNumber === 'IF1').stage, STAGE.PICKED)
  assert.equal(rows.find((r) => r.ifNumber === 'IF1').soNumber, 'SO1')
  assert.equal(rows.find((r) => r.ifNumber === 'IF2').stage, STAGE.PACKED)
})

test('fromPoReceiving maps line-level PO rows and drops header/total rows with no Item', () => {
  const rows = fromPoReceiving([
    {
      'Internal ID': '677045', 'Document Number': 'PO1310', Name: 'Guangzhou Fantasy Leather Factory (Chelly)',
      'Ship To': '166 Shop Bop LLC : ShopBop', 'Final Naghedi Destination': 'Warehouse Bulk : Shopbop',
      Status: 'Partially Received', Item: 'SN04023LD-CASHMERE', Quantity: '90',
      'Quantity Fulfilled/Received': '76', 'Quantity Remaining': '14', 'Due Date/Receive By': '9/14/2024',
    },
    // header/total row for a PO — no Item, must be dropped (nothing to match on)
    {
      'Internal ID': '1152067', 'Document Number': 'PO1397', Name: 'Guangzhou Fantasy Leather Factory (Chelly)',
      'Ship To': '323 Yagi Tsusho LTD.  DEPT-ST', 'Final Naghedi Destination': '',
      Status: 'Partially Received', Item: '', Quantity: '', 'Quantity Fulfilled/Received': '',
      'Quantity Remaining': '0', 'Due Date/Receive By': '2/15/2025',
    },
  ])
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.poNumber, 'PO1310')
  assert.equal(r.item, 'SN04023LD-CASHMERE')
  assert.equal(r.vendor, 'Guangzhou Fantasy Leather Factory (Chelly)')
  assert.equal(r.shipTo, 'Shop Bop LLC : ShopBop') // entity-id prefix stripped like other Name fields
  assert.equal(r.destination, 'Warehouse Bulk : Shopbop')
  assert.equal(r.qtyOrdered, 90)
  assert.equal(r.qtyReceived, 76)
  assert.equal(r.qtyRemaining, 14)
})

test('computeOcPoMatches surfaces an unambiguous 1:1 fully-covered match as a suggestion (not committed)', () => {
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [{ ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse Bulk : Nordstrom', qty: 10, status: 'Open', dismissed: false }],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse Bulk : Nordstrom', qtyRemaining: 15, dismissed: false }],
    links: [],
  })
  assert.equal(candidates.length, 0)
  assert.equal(suggestedMatches.length, 1)
  assert.deepEqual(suggestedMatches[0], { ocNumber: 'OC1', poNumber: 'PO1', item: 'SKU1', allocatedQty: 10, reason: 'UNAMBIGUOUS_1TO1' })
})

test('computeOcPoMatches flags contention instead of guessing which OC wins', () => {
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [
      { ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 10, status: 'Open', dismissed: false },
      { ocNumber: 'OC2', item: 'SKU1', location: 'Warehouse', qty: 5, status: 'Open', dismissed: false },
    ],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 20, dismissed: false }],
    links: [],
  })
  assert.equal(suggestedMatches.length, 0)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason, 'CONTENTION')
  assert.equal(candidates[0].ocs.length, 2)
})

test('computeOcPoMatches flags a shortage instead of partially matching', () => {
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [{ ocNumber: 'OC1', item: 'SKU1', location: 'China', qty: 10, status: 'Open', dismissed: false }],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'China', qtyRemaining: 4, dismissed: false }],
    links: [],
  })
  assert.equal(suggestedMatches.length, 0)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason, 'SHORTAGE')
})

test('computeOcPoMatches nets out existing links and skips Expired/dismissed rows', () => {
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [
      { ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 10, status: 'Open', dismissed: false },
      { ocNumber: 'OC2', item: 'SKU1', location: 'Warehouse', qty: 99, status: 'Expired', dismissed: false },
      { ocNumber: 'OC3', item: 'SKU1', location: 'Warehouse', qty: 99, status: 'Open', dismissed: true },
    ],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 10, dismissed: false }],
    links: [{ ocNumber: 'OC1', poNumber: 'PO1', item: 'SKU1', allocatedQty: 6 }], // 4 remaining on both sides
  })
  assert.equal(candidates.length, 0)
  assert.equal(suggestedMatches.length, 1)
  assert.equal(suggestedMatches[0].allocatedQty, 4)
})

test('computeOcPoMatches surfaces demand/supply with no counterpart as unmatched, not silently dropped', () => {
  const { suggestedMatches, candidates, unmatchedOcs, unmatchedPos } = computeOcPoMatches({
    ocs: [{ ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 10, status: 'Open', dismissed: false }],
    pos: [{ poNumber: 'PO1', item: 'SKU2', destination: 'Warehouse', qtyRemaining: 10, dismissed: false }],
    links: [],
  })
  assert.equal(suggestedMatches.length, 0)
  assert.equal(candidates.length, 0)
  assert.equal(unmatchedOcs.length, 1)
  assert.equal(unmatchedOcs[0].ocNumber, 'OC1')
  assert.equal(unmatchedPos.length, 1)
  assert.equal(unmatchedPos[0].poNumber, 'PO1')
})

test('fromOcPipeline drops Memorized template rows and rows with no Item', () => {
  const rows = fromOcPipeline([
    // Memorized: a recurring-transaction template, not a real dated OC
    {
      'Document Number': 'Memorized', Name: "258 Macy's Inc.", 'Ship To': '', Location: '',
      Status: '', Item: 'NS09100GC-MYKONOS-365', Quantity: '1',
      'PO/Check Number': 'BLOOM SUMMER SHOE 2025', 'Order Start Date': '3/19/2025',
    },
    {
      'Document Number': 'OC1174', Name: "258 Macy's Inc.", 'Ship To': '',
      Location: "Warehouse Bulk : Bloomingdale's", Status: 'Expired',
      Item: 'NS03090FH-TORTOISESHELL-360', Quantity: '1',
      'PO/Check Number': 'Bloom Fall Shoe 2025', 'Order Start Date': '6/24/2025',
    },
    // no Item — nothing to match on
    {
      'Document Number': 'OC1200', Name: 'Someone', Location: 'Warehouse', Status: 'Open',
      Item: '', Quantity: '',
    },
  ])
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.ocNumber, 'OC1174')
  assert.equal(r.item, 'NS03090FH-TORTOISESHELL-360')
  assert.equal(r.location, "Warehouse Bulk : Bloomingdale's")
  assert.equal(r.status, 'Expired')
  assert.equal(r.qty, 1)
  assert.equal(r.poCheckNumber, 'Bloom Fall Shoe 2025')
})

test('fromUnpackedFulfillments branches Picked vs Shipped per row', () => {
  const rows = fromUnpackedFulfillments([
    { 'Document Number': 'IF1', 'Created From': 'SO1', Status: 'Picked', Date: '7/1/2026' },
    { 'Document Number': 'IF2', 'Created From': 'SO2', Status: 'Shipped', Date: '7/2/2026' },
  ])
  const picked = rows.find((r) => r.ifNumber === 'IF1')
  const shipped = rows.find((r) => r.ifNumber === 'IF2')
  assert.equal(picked.stage, STAGE.PICKED)
  assert.equal(picked.actualShipDate, null)
  assert.equal(shipped.stage, STAGE.SHIPPED)
  assert.ok(shipped.actualShipDate instanceof Date)
})

test('buildPipeline computes Picked staleness from date and flags it', () => {
  const recs = [
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', customer: 'X', date: new Date('2026-07-01') },
  ]
  const orders = buildPipeline(recs, { today: new Date('2026-07-08') })
  assert.equal(orders[0].daysPending, 7)
  assert.ok(orders[0].flags.some((f) => f.key === 'PICK_STALLED'))
})

test('computeFlags suppresses shortage noise while On Hold', () => {
  const flags = computeFlags(
    { stage: STAGE.ON_HOLD, isAts: true, qtyOrdered: 8, qtyAllocated: 6, qtyFulfilled: 0, fulfillments: [] },
    new Date('2026-07-08'),
  )
  assert.ok(!flags.some((f) => f.key === 'STOCK_SHORT'))
})

test('resolveCharacterForSender reuses a remembered preference for that sender', () => {
  const id = resolveCharacterForSender('vendor@example.com', { 'vendor@example.com': 'yoda' })
  assert.equal(id, 'yoda')
})

test('resolveCharacterForSender ignores a stale/unknown preference id and falls back to random', () => {
  const id = resolveCharacterForSender('vendor@example.com', { 'vendor@example.com': 'not-a-real-character' }, () => 0)
  assert.equal(id, CHARACTERS[0].id)
})

test('resolveCharacterForSender picks randomly (via injected rng) for a sender with no preference', () => {
  assert.equal(resolveCharacterForSender('new@example.com', {}, () => 0), CHARACTERS[0].id)
  assert.equal(resolveCharacterForSender('new@example.com', {}, () => 0.999999), CHARACTERS[CHARACTERS.length - 1].id)
})

test('resolveShipForKey is deterministic — same order key always maps to the same ship', () => {
  const a = resolveShipForKey('IF7228')
  const b = resolveShipForKey('IF7228')
  assert.equal(a, b)
  assert.ok(SHIPS.some((s) => s.id === a))
})

test('resolveShipForKey spreads different keys across the roster and never divides by zero on an empty roster', () => {
  const ids = new Set(['IF1', 'IF2', 'IF3', 'SO9', 'SO10'].map((k) => resolveShipForKey(k)))
  assert.ok(ids.size > 1) // not all collapsing to one ship
  assert.equal(resolveShipForKey('IF1', []), null)
})

// ── EDI work layer ───────────────────────────────────────────────────────────
const T0 = new Date('2026-07-18T12:00:00Z').getTime()
const DAY_MS = 86400000
const edi850 = (daysAgo, extra = {}) => ({
  businessNumber: 'PO1', tradingPartner: 'Nordstrom', stageRank: 1, hasIssue: false,
  bucket: 'NEEDS_IMPORT', linkGaps: [], netsuiteOrder: null, cancelAfter: null,
  transactions: [{ id: 't1', type: '850_PURCHASE_ORDER', createdAt: new Date(T0 - daysAgo * DAY_MS).toISOString() }],
  ...extra,
})

test('ediWork: an old 850 with no NetSuite order and no resolution is flagged MISSED', () => {
  const w = deriveWork(edi850(30), null, T0)
  assert.equal(w.missed850, true)
  assert.match(w.needed, /Enter in NetSuite — 850 arrived 30d ago/)
  const fresh = deriveWork(edi850(MISSED_AFTER_DAYS - 1), null, T0)
  assert.equal(fresh.missed850, false)
})

test('ediWork: a manual resolution suppresses the missed flag and can close a PO outright', () => {
  const linked = deriveWork(edi850(30), { businessNumber: 'PO1', closed: false, netsuiteRef: 'SO9999' }, T0)
  assert.equal(linked.missed850, false)
  assert.match(linked.needed, /SO9999/)
  const closed = deriveWork(edi850(30), { businessNumber: 'PO1', closed: true, note: 'shipped pre-Orderful' }, T0)
  assert.equal(closed.closed, true)
  assert.equal(closed.closedBy, 'manual')
  assert.equal(closed.needed, null)
})

test('ediWork: a cancelled PO closes with its own closedBy so it can never read as completed work', () => {
  const w = deriveWork(edi850(30), { businessNumber: 'PO1', cancelled: true, note: 'buyer cancelled 6/12' }, T0)
  assert.equal(w.closed, true)
  assert.equal(w.closedBy, 'cancelled')
  assert.equal(w.missed850, false)
})

test('ediWork: shipped-in-NetSuite needs the ASN', () => {
  const needsAsn = deriveWork(
    edi850(10, { stageRank: 1, netsuiteOrder: { soNumber: 'SO1', stage: 'SHIPPED' } }), null, T0)
  assert.match(needsAsn.needed, /856 ASN/)
})

// ── verify-&-close (Phase C, Nima 2026-07-28) ────────────────────────────────
const doc = (type, delivery, ack, extra = {}) => ({
  id: `${type}-${delivery}-${ack}`, type, direction: 'OUT',
  deliveryStatus: delivery, acknowledgmentStatus: ack, ack: null, ...extra,
})
const complete850 = (docs) => edi850(10, { stageRank: 4, transactions: [
  { id: 't1', type: '850_PURCHASE_ORDER', createdAt: new Date(T0 - 10 * DAY_MS).toISOString() }, ...docs,
] })

test('ediWork: an 810-complete PO no longer auto-closes — it parks in Ready-to-close (Nima, 2026-07-28)', () => {
  const w = deriveWork(complete850([
    doc('856_SHIP_NOTICE_MANIFEST', 'DELIVERED', 'ACCEPTED'),
    doc('810_INVOICE', 'DELIVERED', 'ACCEPTED'),
  ]), null, T0)
  assert.equal(w.closed, false)              // nothing closes silently anymore
  assert.equal(w.readyToClose, true)
  assert.equal(w.verify.canClose, true)
  assert.equal(w.verify.blockers.length, 0)
  assert.match(w.needed, /Verify & close/)
})

test('ediWork: Verify surfaces exactly what is missing when 856/810 are not both delivered+accepted', () => {
  // 856 delivered but never acknowledged, 810 not sent at all
  const w = deriveWork(complete850([
    doc('856_SHIP_NOTICE_MANIFEST', 'DELIVERED', 'NOT_ACKNOWLEDGED'),
  ]), null, T0)
  assert.equal(w.readyToClose, true)
  assert.equal(w.verify.canClose, false)
  assert.equal(w.verify.ship.confirmed, false)
  assert.equal(w.verify.invoice.sent, false)
  assert.match(w.verify.blockers.join(' '), /856 delivered but acknowledgment/)
  assert.match(w.verify.blockers.join(' '), /no 810 sent/)
  assert.match(w.needed, /Verify before closing/)
})

test('ediWork: ACCEPTED_WITH_ERRORS still counts as confirmed; a manual close is the only way to terminal (closedBy manual)', () => {
  const ready = deriveWork(complete850([
    doc('856_SHIP_NOTICE_MANIFEST', 'DELIVERED', 'ACCEPTED_WITH_ERRORS'),
    doc('810_INVOICE', 'DELIVERED', 'ACCEPTED'),
  ]), null, T0)
  assert.equal(ready.verify.canClose, true)
  const closed = deriveWork(complete850([]), { businessNumber: 'PO1', closed: true, note: 'Verified & closed' }, T0)
  assert.equal(closed.closed, true)
  assert.equal(closed.closedBy, 'manual')
  assert.equal(closed.readyToClose, false)
})

test('ediWork: passed cancel date on an unshipped PO screams in the needed line', () => {
  const w = deriveWork(edi850(20, { cancelAfter: new Date(T0 - 3 * DAY_MS).toISOString() }), null, T0)
  assert.equal(w.cancelState, 'passed')
  assert.match(w.needed, /Cancel date passed 3d ago/)
})

test('ediWork: an in-review PO is parked — 856/810 chase is suppressed until validated (Nima, 2026-07-28)', () => {
  // shipped in NetSuite → would normally scream "send the 856", but it's parked
  const base = edi850(10, { stageRank: 1, netsuiteOrder: { soNumber: 'SO1', stage: 'SHIPPED' } })
  const parked = deriveWork(base, { businessNumber: 'PO1', reviewState: 'in_review' }, T0)
  assert.equal(parked.underReview, true)
  assert.equal(parked.needs856, false)             // gate holds the 856 back
  assert.match(parked.needed, /Validate this PO/)

  // validate it (confirm the NS order) → the normal 856 need resumes
  const validated = deriveWork(base, { businessNumber: 'PO1', reviewState: 'validated' }, T0)
  assert.equal(validated.underReview, false)
  assert.equal(validated.validated, true)
  assert.equal(validated.needs856, true)
  assert.match(validated.needed, /856 ASN/)
})

test('computeEdiWork: rollup counts in-review and needs-856/810 per partner (Nima, 2026-07-28)', () => {
  const shipped = { stageRank: 1, netsuiteOrder: { soNumber: 'SO1', stage: 'SHIPPED' } }
  const orders = [
    edi850(2, { businessNumber: 'PO1', ...shipped }),                 // needs 856
    edi850(2, { businessNumber: 'PO2', stageRank: 3 }),               // needs 810
    edi850(2, { businessNumber: 'PO3', ...shipped }),                 // in review → suppressed
  ]
  const res = [{ businessNumber: 'PO3', reviewState: 'in_review' }]
  const { partners, totals } = computeEdiWork(orders, res, T0)
  assert.equal(partners[0].needs856, 1)   // PO3's 856 is NOT counted (parked)
  assert.equal(partners[0].needs810, 1)
  assert.equal(partners[0].inReview, 1)
  assert.equal(totals.inReview, 1)
})

test('computeEdiWork: partner rollup counts open/closed and the ratio', () => {
  const orders = [
    edi850(30),                                              // open + missed
    edi850(2, { businessNumber: 'PO2', stageRank: 4 }),      // ready to close (open, no longer auto-closed)
    edi850(2, { businessNumber: 'PO3' }),                    // open
  ]
  // PO2 is only terminal once explicitly closed
  const resolutions = [{ businessNumber: 'PO2', closed: true, note: 'Verified & closed' }]
  const { partners, totals } = computeEdiWork(orders, resolutions, T0)
  assert.equal(partners.length, 1)
  assert.equal(partners[0].open, 2)
  assert.equal(partners[0].closed, 1)
  assert.equal(partners[0].missed, 1)
  assert.ok(Math.abs(partners[0].closedRatio - 1 / 3) < 1e-9)
  assert.deepEqual({ open: totals.open, closed: totals.closed }, { open: 2, closed: 1 })

  // and without the manual close, PO2 sits in Ready-to-close (open, not closed)
  const auto = computeEdiWork(orders, [], T0)
  assert.equal(auto.totals.readyToClose, 1)
  assert.equal(auto.totals.closed, 0)
})

test('every roster character has a dialogue voice (catches drift when adding characters)', () => {
  for (const c of CHARACTERS) {
    assert.ok(DIALOGUE[c.id], `no DIALOGUE entry for ${c.id}`)
    assert.ok(DIALOGUE[c.id].greeting?.length, `no greeting lines for ${c.id}`)
  }
})

test('speakLine is deterministic per (character, context, seed) and varies across seeds', () => {
  const a = speakLine('yoda', 'greeting', 42)
  assert.equal(a, speakLine('yoda', 'greeting', 42))
  assert.ok(typeof a === 'string' && a.length > 0)
  // with 3 greeting lines, some pair of these seeds must differ
  const picks = new Set([1, 2, 3, 4, 5, 6].map((s) => speakLine('yoda', 'greeting', s)))
  assert.ok(picks.size > 1)
})

test('speakLine falls back: unknown context → greeting, unknown character → default voice', () => {
  assert.ok(speakLine('yoda', 'not-a-context', 1))
  assert.ok(speakLine('not-a-character', 'greeting', 1))
})

test('taskContext ranks done > urgent > recurring > greeting', () => {
  assert.equal(taskContext({ status: 'done', urgency: 'hi', recurringKey: 'x' }), 'done')
  assert.equal(taskContext({ status: 'open', urgency: 'hi', recurringKey: 'x' }), 'urgent')
  assert.equal(taskContext({ status: 'open', recurringKey: 'x' }), 'reminder')
  assert.equal(taskContext({ status: 'open' }), 'greeting')
})

test('normalizeDocNumber prepends the prefix only when missing', () => {
  assert.equal(normalizeDocNumber('SO', '1213'), 'SO1213')
  assert.equal(normalizeDocNumber('SO', 'SO1213'), 'SO1213')
  assert.equal(normalizeDocNumber('SO', 'so1213'), 'SO1213') // case-insensitive match on the prefix too
  assert.equal(normalizeDocNumber('PO', ''), '')
})

// ── Custody flags (QR label scans — Nima, 2026-07-17) ───────────────────────
// The IF-created → packed gap: OUT scan = handed to warehouse, IN scan = back.

test('custody: IF scanned OUT recently shows an informational with-warehouse flag', () => {
  const flags = computeFlags(
    {
      stage: STAGE.PICKED,
      fulfillments: [{ ifNumber: 'IF1', custodyOut: '2026-07-07T10:00:00Z', custodyIn: null }],
    },
    new Date('2026-07-08'),
  )
  const f = flags.find((x) => x.key === 'WITH_WAREHOUSE')
  assert.ok(f)
  assert.equal(f.severity, 0)
})

test('custody: IF with warehouse 3+ days escalates to WAREHOUSE_HOLDS (act now)', () => {
  const flags = computeFlags(
    {
      stage: STAGE.PICKED,
      fulfillments: [{ ifNumber: 'IF1', custodyOut: '2026-07-01T10:00:00Z', custodyIn: null }],
    },
    new Date('2026-07-08'),
  )
  const f = flags.find((x) => x.key === 'WAREHOUSE_HOLDS')
  assert.ok(f)
  assert.equal(f.severity, 3)
})

test('custody: IN scan newer than OUT means back-but-not-packed — our move', () => {
  const flags = computeFlags(
    {
      stage: STAGE.PICKED,
      fulfillments: [
        { ifNumber: 'IF1', custodyOut: '2026-07-05T10:00:00Z', custodyIn: '2026-07-07T15:00:00Z' },
      ],
    },
    new Date('2026-07-08'),
  )
  assert.ok(flags.some((x) => x.key === 'BACK_NOT_PACKED'))
  assert.ok(!flags.some((x) => x.key === 'WITH_WAREHOUSE' || x.key === 'WAREHOUSE_HOLDS'))
})

test('custody: re-handoff (OUT newer than IN) reads as with-warehouse again', () => {
  const flags = computeFlags(
    {
      stage: STAGE.PICKED,
      fulfillments: [
        { ifNumber: 'IF1', custodyOut: '2026-07-07T10:00:00Z', custodyIn: '2026-07-06T15:00:00Z' },
      ],
    },
    new Date('2026-07-08'),
  )
  assert.ok(flags.some((x) => x.key === 'WITH_WAREHOUSE'))
  assert.ok(!flags.some((x) => x.key === 'BACK_NOT_PACKED'))
})

test('custody: unscanned IF a day+ old asks for a handoff scan', () => {
  const flags = computeFlags(
    { stage: STAGE.PICKED, fulfillments: [{ ifNumber: 'IF1', ifDate: '2026-07-05' }] },
    new Date('2026-07-08'),
  )
  assert.ok(flags.some((x) => x.key === 'NEEDS_HANDOFF_SCAN'))
})

test('custody: scans suppress the generic PICK_STALLED guess', () => {
  const base = { stage: STAGE.PICKED, daysPending: 5 }
  const without = computeFlags({ ...base, fulfillments: [{ ifNumber: 'IF1' }] }, new Date('2026-07-08'))
  assert.ok(without.some((x) => x.key === 'PICK_STALLED'))
  const withScans = computeFlags(
    { ...base, fulfillments: [{ ifNumber: 'IF1', custodyOut: '2026-07-06T10:00:00Z' }] },
    new Date('2026-07-08'),
  )
  assert.ok(!withScans.some((x) => x.key === 'PICK_STALLED'))
})

test('custody: no custody flags once the order is past PICKED', () => {
  const flags = computeFlags(
    {
      stage: STAGE.PACKED,
      fulfillments: [{ ifNumber: 'IF1', custodyOut: '2026-07-01T10:00:00Z' }],
    },
    new Date('2026-07-08'),
  )
  assert.ok(!flags.some((x) => ['WITH_WAREHOUSE', 'WAREHOUSE_HOLDS', 'BACK_NOT_PACKED', 'NEEDS_HANDOFF_SCAN'].includes(x.key)))
})

// ── detectSource: the in-app Import button's router ──────────────────────────
// PO Receiving / OC Pipeline became importable in-app (2026-07-17, so they can
// live in Bugs' CSV-freshness task). Each keys on a column unique to its
// export; the order-pipeline search must NOT match either (it has plain
// "Start Date", not "Order Start Date", and no "Final Naghedi Destination").
test('detectSource routes PO Receiving and OC Pipeline exports without stealing the order pipeline', () => {
  assert.equal(
    detectSource(['Document Number', 'Name', 'Ship To', 'Final Naghedi Destination', 'Status', 'Item', 'Quantity', 'Quantity Fulfilled/Received', 'Quantity Remaining', 'Due Date/Receive By']),
    'poReceiving',
  )
  assert.equal(
    detectSource(['Document Number', 'Name', 'Ship To', 'Location', 'Status', 'Item', 'Quantity', 'PO/Check Number', 'Order Start Date']),
    'ocPipeline',
  )
  // consolidated SO-based order pipeline still routes to openSalesOrders
  assert.equal(
    detectSource(['Document Number', 'Maximum of Name', 'Maximum of Location', 'Maximum of Status', 'Sum of Quantity', 'Maximum of Start Date']),
    'openSalesOrders',
  )
  // consolidated IF-based fulfillment search unaffected
  assert.equal(
    detectSource(['Document Number', 'Maximum of Created From', 'Maximum of Status']),
    'fulfillmentPipeline',
  )
})

// ── affection (relationship tracker) ─────────────────────────────────────────
test('computeAffection: affection + RPG stats per completed quest, ignores open', () => {
  const mk = (id, char, status, createdAt, completedAt, urgency) => ({ id, characterId: char, status, createdAt, completedAt, urgency })
  const tasks = [
    mk(1, 'yoda', 'done', '2026-07-01T00:00:00Z', '2026-07-01T02:00:00Z', 'hi'), // <4h → affection 10+5, agi 5, str 5
    mk(2, 'yoda', 'done', '2026-07-01T00:00:00Z', '2026-07-05T00:00:00Z', 'lo'), // 4d  → affection 10+1, agi 1, str 1
    mk(3, 'yoda', 'open', '2026-07-01T00:00:00Z', null, 'hi'),                   // open → ignored
    mk(4, 'rey', 'done', '2026-07-01T00:00:00Z', '2026-07-01T10:00:00Z', 'mid'), // <24h → affection 10+3
  ]
  const res = computeAffection(tasks)
  const yoda = res.find((r) => r.characterId === 'yoda')
  const rey = res.find((r) => r.characterId === 'rey')
  assert.equal(yoda.points, 26) // (10+5) + (10+1)
  assert.equal(yoda.questsDone, 2)
  assert.equal(yoda.stats.agility, 6)      // 5 + 1
  assert.equal(yoda.stats.strength, 6)     // hi(5) + lo(1)
  assert.equal(yoda.stats.intelligence, 8) // 4 per mission × 2
  assert.equal(yoda.missions.length, 2)
  assert.equal(rey.points, 13)
  assert.equal(res[0].characterId, 'yoda') // sorted by points desc
  assert.ok(yoda.level.name)
})

// ── poGroups: collapse the buyer-PO fan-out ──────────────────────────────────
test('groupOrdersByPo rolls same-PO SOs into one group, leaves blank-PO orders alone', () => {
  const o = (so, po, cust, stage, sev, days) => ({
    soNumber: so, poNumber: po, customer: cust, stage, stageRank: 0, severity: sev, daysPending: days,
    nextAction: 'x', flags: [], fulfillments: [{ ifNumber: 'IF' + so }], invoices: [],
  })
  const orders = [
    o('SO1', '7590875', "Bloomingdale's - 0001 NY", 'PICKED_NEEDS_PACK', 2, 5),
    o('SO2', '7590875', "Bloomingdale's - 0002 Boca", 'APPROVED_FOR_SHIPPING', 3, 9),
    o('SO3', '', 'Some Boutique', 'OPEN_NEEDS_FULFILLMENT', 1, 2),
    o('SO4', '80126', 'Robertson Madison', 'OPEN_NEEDS_FULFILLMENT', 0, 1), // lone PO → stays single
  ]
  const rows = groupOrdersByPo(orders)
  const grp = rows.find((r) => r.isGroup)
  assert.ok(grp, 'a group is produced for the shared PO')
  assert.equal(grp.poNumber, '7590875')
  assert.equal(grp.memberCount, 2)
  assert.equal(grp.customer, "Bloomingdale's") // common base before the store suffix
  assert.equal(grp.severity, 3) // max of members
  assert.equal(grp.daysPending, 9) // max of members
  assert.equal(grp.fulfillments.length, 2) // both IFs kept (fan-out not hidden)
  assert.equal(rows.filter((r) => r.isGroup).length, 1)
  assert.ok(rows.some((r) => r.soNumber === 'SO3' && !r.isGroup)) // blank PO stays single
  assert.ok(rows.some((r) => r.soNumber === 'SO4' && !r.isGroup)) // lone PO stays single
})

// ── routePlan: the hyperspace task route (EDF) ───────────────────────────────
test('computeRoute orders by deadline (EDF), then priority, then shorter first', () => {
  const T0 = new Date('2026-07-21T09:00:00').getTime()
  const at = (h, m = 0) => { const d = new Date(T0); d.setHours(h, m, 0, 0); return d.getTime() }
  const items = [
    { id: 'a', label: 'urgent ship', kind: 'ship', deadline: at(15), durationMin: 12, priority: 0 },
    { id: 'b', label: 'nordstrom route', kind: 'edi_route', deadline: at(12), durationMin: 10, priority: 1 },
    { id: 'c', label: 'planning', kind: 'planning', deadline: null, durationMin: 30, priority: 5 },
    { id: 'd', label: 'boutique invoice', kind: 'invoice', deadline: at(12), durationMin: 8, priority: 1 },
  ]
  const { route, summary } = computeRoute(items, { now: T0, dayStartHour: 9 })
  // noon deadlines first; between the two noon items the shorter (invoice 8m) leads
  assert.deepEqual(route.map((r) => r.id), ['d', 'b', 'a', 'c'])
  assert.equal(route[0].seq, 1)
  assert.equal(summary.count, 4)
  assert.equal(summary.atRisk, 0) // all fit before their cutoffs starting 9am
})

test('computeRoute flags an item that cannot make its cutoff', () => {
  const T0 = new Date('2026-07-21T11:30:00').getTime()
  const noon = (() => { const d = new Date(T0); d.setHours(12, 0, 0, 0); return d.getTime() })()
  const items = [
    { id: 'x', label: 'long job', kind: 'pack', deadline: noon, durationMin: 45, priority: 1 },
  ]
  const { route, summary } = computeRoute(items, { now: T0 })
  assert.equal(route[0].atRisk, true) // 11:30 + 45m = 12:15 > noon
  assert.ok(route[0].slackMin < 0)
  assert.equal(summary.atRisk, 1)
  assert.ok(summary.maxLatenessMin >= 15)
})

test('computeRoute preserveOrder keeps a hand-set sequence but still flags cutoffs', () => {
  const T0 = new Date('2026-07-21T09:00:00').getTime()
  const at = (h) => { const d = new Date(T0); d.setHours(h, 0, 0, 0); return d.getTime() }
  const items = [
    { id: 'long', label: 'long', kind: 'planning', deadline: null, durationMin: 240, priority: 5 },
    { id: 'tight', label: 'tight', kind: 'edi_route', deadline: at(12), durationMin: 10, priority: 1 },
  ]
  const { route } = computeRoute(items, { now: T0, preserveOrder: true })
  // order is preserved (not re-sorted by EDF), so the noon item is pushed past noon
  assert.deepEqual(route.map((r) => r.id), ['long', 'tight'])
  assert.equal(route[1].atRisk, true) // 9:00 + 240m = 13:00, then +10m > noon
})

// ── routeItems: the live-data → route adapter (Nima, 2026-07-28) ─────────────
test('buildRouteItems draws tasks, EDI actions and shippable orders', () => {
  const T0 = new Date('2026-07-28T09:00:00').getTime()
  const noon = (() => { const d = new Date(T0); d.setHours(12, 0, 0, 0); return d.getTime() })()
  const tasks = [
    { id: 1, subject: 'reply to buyer', status: 'open', urgency: 'hi' },
    { id: 2, subject: 'measured task', status: 'open', urgency: 'lo', durationMin: 25, dueAt: new Date(noon).toISOString() },
    { id: 3, subject: 'done already', status: 'done', urgency: 'hi' },
  ]
  const orders = [
    { soNumber: 'SO9', customer: 'Boutique X', stage: STAGE.APPROVED, severity: 2, cancelDate: null },
    { soNumber: 'SO8', customer: 'Shop Y', stage: STAGE.PACKED, severity: 1, location: 'Boutique' },
  ]
  const ediWork = { orders: [
    { businessNumber: 'PO7', tradingPartner: 'Nordstrom (EDI)', stageRank: 1, work: { closed: false, cancelState: 'ok' } },
  ] }
  const items = buildRouteItems(orders, tasks, ediWork, { now: T0 })
  const ids = items.map((i) => i.id)
  assert.ok(ids.includes('task-1'))
  assert.ok(!ids.includes('task-3'))            // done tasks excluded
  assert.ok(ids.includes('edi-PO7'))            // Nordstrom early-stage → routing leg
  assert.ok(ids.includes('ship-SO9'))           // approved-for-shipping → ship leg
  const measured = items.find((i) => i.id === 'task-2')
  assert.equal(measured.durationMin, 25)        // real duration_min wins
  assert.equal(measured.deadline, noon)         // real due_at wins
  assert.equal(measured.scheduled, true)
})

test('applyDayPlan merges done + switches to manual order when a sortIndex exists', () => {
  const items = [
    { id: 'edi-PO7', label: 'route', deadline: 1 },
    { id: 'task-1', label: 'reply', deadline: 2 },
    { id: 'ship-SO9', label: 'ship', deadline: 3 },
  ]
  const rows = [
    { itemId: 'ship-SO9', sortIndex: 0, done: false },
    { itemId: 'edi-PO7', sortIndex: 1, done: true },
    { itemId: 'task-1', sortIndex: 2, done: false },
  ]
  const { items: merged, manualMode } = applyDayPlan(items, rows)
  assert.equal(manualMode, true)
  assert.deepEqual(merged.map((i) => i.id), ['ship-SO9', 'edi-PO7', 'task-1'])
  assert.equal(merged.find((i) => i.id === 'edi-PO7').done, true)

  const auto = applyDayPlan(items, [])
  assert.equal(auto.manualMode, false)          // no sortIndex → EDF stays in charge
})

// ── EDI routing + BOL rollup (Nima, 2026-07-22) ────────────────────────────
const EDI_PKG_CSV =
  'PO Number - DC,Total Weight (lbs),Carton Count,Total Units,Cubic Feet (Rounded),Cubic Feet,BOL\n' +
  '7527064-CG,26,1,15,3,2.7,7527064DCCG\n' +
  '7776929-CG,15,1,5,2,1.4,7776929DCCG\n' +
  'Total,41.0,2,20,5.0,4.1,\n'

test('detectSource recognizes the EDI Packages Volume feed', () => {
  const rows = parseCsv(EDI_PKG_CSV)
  assert.equal(detectSource(Object.keys(rows[0])), 'ediPackagesVolume')
})

test('fromEdiPackagesVolume parses PO-DC and drops the Total row', () => {
  const rows = fromEdiPackagesVolume(parseCsv(EDI_PKG_CSV))
  assert.equal(rows.length, 2) // Total row skipped
  assert.deepEqual(
    { po: rows[0].poNumber, dc: rows[0].dc, w: rows[0].weight, raw: rows[0].cubicFeetRaw },
    { po: '7527064', dc: 'CG', w: 26, raw: 2.7 },
  )
})

const SHIPCENTRAL_CSV =
  'Order,Location,Status,Ship Date,Actual Ship Date\n' +
  'SO12375,7,pendingFulfillment,8/21/2026,\n' +
  'SO12388,2,pendingFulfillment,8/24/2026,\n'

test('detectSource recognizes the ShipCentral SO queue (not the order pipeline)', () => {
  const rows = parseCsv(SHIPCENTRAL_CSV)
  assert.equal(detectSource(Object.keys(rows[0])), 'shipCentralQueue')
})

test('fromShipCentralQueue normalizes SO#, status and dates; skips blank/Total', () => {
  const withTotal = SHIPCENTRAL_CSV + 'Total,,,,\n'
  const rows = fromShipCentralQueue(parseCsv(withTotal))
  assert.equal(rows.length, 2) // Total row dropped
  assert.equal(rows[0].soNumber, 'SO12375')
  assert.equal(rows[0].status, 'pendingFulfillment')
  assert.equal(rows[0].location, '7')
  assert.ok(rows[0].shipDate instanceof Date)
  assert.equal(rows[0].actualShipDate, null)
})

test('dc helpers classify partner and label by code', () => {
  assert.equal(partnerForDc('CG'), "Bloomingdale's")
  assert.equal(partnerForDc('584'), 'Nordstrom')
  assert.equal(dcLabel('CG'), 'China Grove DC')
  assert.equal(dcLabel('584'), 'DC 584')
})

test('consolidateRouting rolls up multiple POs into one DC shipment', () => {
  const rows = fromEdiPackagesVolume(parseCsv(EDI_PKG_CSV))
  const [cg] = consolidateRouting(rows)
  assert.equal(cg.partner, "Bloomingdale's")
  assert.equal(cg.dc, 'CG')
  assert.deepEqual(cg.memberPos, ['7527064', '7776929']) // both POs consolidated
  assert.equal(cg.poCount, 2)
  assert.equal(cg.cartons, 2)
  assert.equal(cg.units, 20)
  assert.equal(cg.weightLb, 41) // 26 + 15, whole pounds
  assert.equal(cg.cubicFeet, 5) // ceil(2.7 + 1.4) = ceil(4.1) = 5
  assert.equal(cg.showUnits, false) // Bloomingdale's portal doesn't need units
})

test('netsuiteShippedVerdict confirms only when every member PO is fully shipped', () => {
  const ifs = { 7527086: { shipped: 9, total: 9 }, 7590875: { shipped: 23, total: 23 } }
  const v = netsuiteShippedVerdict(['7527086', '7590875'], ifs)
  assert.equal(v.confirmed, true)
  assert.deepEqual(v.pending, [])
  assert.deepEqual(v.byPo.map((p) => p.state), ['shipped', 'shipped'])
})

test('netsuiteShippedVerdict holds back on a partially shipped PO and names it', () => {
  const ifs = { 7527086: { shipped: 9, total: 9 }, 7776940: { shipped: 4, total: 16 } }
  const v = netsuiteShippedVerdict(['7527086', '7776940'], ifs)
  assert.equal(v.confirmed, false)
  assert.deepEqual(v.pending, ['7776940'])
  // the evidence survives, per-PO — never collapsed to one flag
  assert.deepEqual(v.byPo.find((p) => p.po === '7776940'), {
    po: '7776940', shipped: 4, total: 16, state: 'partial',
  })
})

test('netsuiteShippedVerdict treats a PO with no fulfilments as unknown, not shipped', () => {
  const v = netsuiteShippedVerdict(['7527064'], {})
  assert.equal(v.confirmed, false)
  assert.equal(v.byPo[0].state, 'unknown')
  assert.deepEqual(v.pending, ['7527064'])
})

test('netsuiteShippedVerdict never confirms a shipment with no member POs', () => {
  assert.equal(netsuiteShippedVerdict([], {}).confirmed, false)
})

test('consolidateRouting always rounds cubic feet UP and never to a decimal', () => {
  const rows = [
    { poNumber: 'A', dc: 'SC', weight: 10.2, cartons: 1, units: 3, cubicFeetRaw: 1.1, cubicFeetRounded: 2 },
    { poNumber: 'B', dc: 'SC', weight: 5, cartons: 1, units: 2, cubicFeetRaw: 2.05, cubicFeetRounded: 3 },
  ]
  const [sc] = consolidateRouting(rows)
  assert.equal(sc.cubicFeet, 4) // ceil(1.1 + 2.05 = 3.15) = 4
  assert.equal(sc.weightLb, 16) // ceil(15.2) = 16
  assert.equal(Number.isInteger(sc.cubicFeet), true)
})

test('consolidateRouting shows units for Nordstrom and splits by partner', () => {
  const rows = [
    { poNumber: 'A', dc: '584', weight: 8, cartons: 2, units: 12, cubicFeetRaw: 3, cubicFeetRounded: 3 },
    { poNumber: 'B', dc: 'CG', weight: 4, cartons: 1, units: 4, cubicFeetRaw: 1, cubicFeetRounded: 1 },
  ]
  const groups = consolidateRouting(rows)
  const nord = groups.find((g) => g.partner === 'Nordstrom')
  const bloom = groups.find((g) => g.partner === "Bloomingdale's")
  assert.equal(nord.showUnits, true)
  assert.equal(nord.units, 12)
  assert.equal(bloom.showUnits, false)
  // sorted Bloomingdale's before Nordstrom
  assert.deepEqual(groups.map((g) => g.partner), ["Bloomingdale's", 'Nordstrom'])
})

// ── Order Pipeline: DC/store folded in (Nima, 2026-07-22) ──────────────────
test('fromOpenSalesOrders reads DC Code / Store Number columns when present', () => {
  const [r] = fromOpenSalesOrders([{
    'Document Number': 'SO12222', 'Maximum of Name': "Bloomingdale's - 0011 Chestnut Hill",
    'Maximum of PO/Check Number': '7527086', 'DC Code': 'SC', 'Store Number': '0011',
  }])
  assert.equal(r.dc, 'SC')
  assert.equal(r.storeNumber, '0011')
})

test('fromOpenSalesOrders derives DC from the full ship-to name when no DC Code column', () => {
  const [r] = fromOpenSalesOrders([{
    'Document Number': 'SO12223',
    'Maximum of Name': "Macy's Inc. : Bloomingdale's DC - Secaucus : Bloomingdale's - 0006 Short Hills",
    'Maximum of PO/Check Number': '7527086',
  }])
  assert.equal(r.dc, 'SC') // parsed "DC - Secaucus" → dcAbbrev → SC
})

test('fromOpenSalesOrders leaves dc null when neither column nor DC in name', () => {
  const [r] = fromOpenSalesOrders([{ 'Document Number': 'SO1', 'Maximum of Name': 'Level Shoes' }])
  assert.equal(r.dc, null)
})

// ── Master BOL manual pallet count + tare weight (Nima, 2026-07-28/29) ───────
// The real pallet count isn't known until the shipment is physically built, so
// a master BOL uses a MANUALLY-assigned count and adds 43 lb tare per pallet to
// the freight weight (411 freight + 1 pallet = 454). Pallets are counted ONLY
// on the master (Nima, 2026-07-29): per-DC child BOLs — and a master before its
// count is entered — show NO pallet count and plain freight weight.
import { palletWeight } from '../server/bolPdf.js'

test('palletWeight: master BOL uses the manual count and adds 43 lb tare per pallet', () => {
  assert.deepEqual(palletWeight({ isMaster: true, palletCount: 1, weightLb: 411 }),
    { hu: '1', weight: 454, manual: true })
  assert.deepEqual(palletWeight({ isMaster: true, palletCount: 3, weightLb: 411 }),
    { hu: '3', weight: 411 + 129, manual: true })
})

test('palletWeight: master with count 0 adds no tare (freight weight unchanged)', () => {
  assert.deepEqual(palletWeight({ isMaster: true, palletCount: 0, weightLb: 411 }),
    { hu: '0', weight: 411, manual: true })
})

test('palletWeight: master with no manual count shows NO pallets (blank) + plain freight', () => {
  assert.deepEqual(palletWeight({ isMaster: true, palletCount: null, weightLb: 411 }),
    { hu: '', weight: 411, manual: false })
})

test('palletWeight: a per-DC child BOL never shows pallets — blank H.U. + plain freight weight', () => {
  // Even a stray palletCount off the master is ignored — pallets are master-only.
  assert.deepEqual(palletWeight({ isMaster: false, palletCount: 5, weightLb: 90 }),
    { hu: '', weight: 90, manual: false })
})

// ── EDI 850 ship-window date extraction (Phase D, 2026-07-28) ────────────────
// Real qualifiers verified against live Orderful 850 bodies (2+ each partner):
// which X12 DTM code carries start/cancel is partner-dependent, all at the same
// header dateTimeReference. extractPoDates picks the first present per family.
const msg850 = (dtms) => ({ transactionSets: [{ dateTimeReference: dtms }] })
const dtm = (q, date) => ({ dateTimeQualifier: q, date })

test('extractPoDates: Bloomingdale\'s 064/001 (the original defaults still work)', () => {
  const r = extractPoDates(msg850([dtm('001', '20260817'), dtm('064', '20260722')]))
  assert.deepEqual(r, { shipNotBefore: '2026-07-22', cancelAfter: '2026-08-17' })
})

test('extractPoDates: Nordstrom carries start under 037 (Ship-Not-Before), not 064', () => {
  const r = extractPoDates(msg850([dtm('001', '20260527'), dtm('037', '20260520')]))
  assert.deepEqual(r, { shipNotBefore: '2026-05-20', cancelAfter: '2026-05-27' })
})

test('extractPoDates: Shopbop carries cancel under 063 (Do-Not-Deliver-After), not 001', () => {
  const r = extractPoDates(msg850([dtm('064', '20260828'), dtm('063', '20260910')]))
  assert.deepEqual(r, { shipNotBefore: '2026-08-28', cancelAfter: '2026-09-10' })
})

test('extractPoDates: Saks 010/001 and Neiman 037/063 both resolve via the families', () => {
  assert.deepEqual(extractPoDates(msg850([dtm('010', '20260603'), dtm('001', '20260620')])),
    { shipNotBefore: '2026-06-03', cancelAfter: '2026-06-20' })
  assert.deepEqual(extractPoDates(msg850([dtm('037', '20250515'), dtm('063', '20250615')])),
    { shipNotBefore: '2025-05-15', cancelAfter: '2025-06-15' })
})

test('extractPoDates: a partial 850 (only a cancel qualifier) fills one date, leaves the other null', () => {
  const r = extractPoDates(msg850([dtm('001', '20260527')]))
  assert.deepEqual(r, { shipNotBefore: null, cancelAfter: '2026-05-27' })
})

test('extractPoDates: no DTM segments → both null, no throw', () => {
  assert.deepEqual(extractPoDates({}), { shipNotBefore: null, cancelAfter: null })
})

test('resolveLabelChips: drops noise, names system + user labels, sorts', () => {
  const nameById = { Label_7: 'Bloomingdale’s', Label_3: 'Nordstrom' }
  const chips = resolveLabelChips(
    ['INBOX', 'UNREAD', 'CATEGORY_UPDATES', 'IMPORTANT', 'Label_7', 'Label_3'],
    nameById,
  )
  assert.deepEqual(chips, [
    { id: 'Label_7', name: 'Bloomingdale’s' },
    { id: 'IMPORTANT', name: 'Important' },
    { id: 'Label_3', name: 'Nordstrom' },
  ])
})

test('resolveLabelChips: skips an unresolvable user label, tolerates empty input', () => {
  assert.deepEqual(resolveLabelChips(['Label_99'], {}), []) // unknown Label_* dropped, not shown as gibberish
  assert.deepEqual(resolveLabelChips(), [])
  assert.deepEqual(resolveLabelChips(['STARRED'], {}), [{ id: 'STARRED', name: 'Starred' }])
})

// ── the live EDI carton feed ─────────────────────────────────────────────────
// Field names and the rounding rule were validated against saved search
// customsearch3947 on all six live PO-DCs; these lock the parts that are pure.

test('parseBoxDims reads a box type name, whatever the case of the x', () => {
  assert.deepEqual(parseBoxDims('24x16x17'), [24, 16, 17])
  assert.deepEqual(parseBoxDims('24X14X4'), [24, 14, 4])
  assert.deepEqual(parseBoxDims(' 18 x 12 x 5 '), [18, 12, 5])
  assert.equal(parseBoxDims('Custom Mailer'), null) // not dimensional → reportable
  assert.equal(parseBoxDims(''), null)
})

test('splitPoDc rejects the junk identifiers the live data contains', () => {
  assert.deepEqual(splitPoDc('7242978-SC'), { poNumber: '7242978', dc: 'SC' })
  assert.equal(splitPoDc('-'), null)      // no PO, no DC
  assert.equal(splitPoDc('KSA-'), null)   // PO but no DC
  assert.equal(splitPoDc('-CG'), null)    // DC but no PO
  assert.equal(splitPoDc(null), null)
})

test('mapEdiPackageRows groups cartons per PO-DC and matches the saved search', () => {
  // IF7402 / PO 7817926-CG: the real 9 cartons, whose search row is
  // 9 cartons · 292 lb · 215 units · 33.5 cu ft · 36 rounded.
  const boxes = [
    ['24x16x17', 45, 15], ['24x16x17', 37, 27], ['24x16x17', 23, 18],
    ['24x16x17', 30, 24], ['24x16x17', 34, 26], ['24x16x17', 33, 25],
    ['24x16x17', 32, 24], ['24x16x17', 29, 28], ['24x16x17', 29, 28],
  ]
  const { rows } = mapEdiPackageRows({
    ifs: [{ id: '2803458', po_dc: '7817926-CG' }],
    packages: boxes.map(([box, weight, units]) => ({ if_id: '2803458', box, weight, units })),
  })
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.poNumber, '7817926')
  assert.equal(r.dc, 'CG')
  assert.equal(r.cartons, 9)
  assert.equal(r.weight, 292)
  assert.equal(r.units, 215)
  // 24×16×17/1728 = 3.7777… → 3.8 per carton × 9 = 34.2, NOT ceil-per-carton (36)
  assert.equal(r.cubicFeetRaw, 34.2)
  assert.equal(r.cubicFeetRounded, 36) // sum of per-carton ceilings
  assert.equal(r.suggestedBol, '7817926DCCG') // the search's own BOL formula
})

test('mapEdiPackageRows rounds cubic feet PER CARTON, not once on the total', () => {
  // The distinction is why summing raw came out light on every group: 3.7777×3
  // = 11.33 → 11.3, but 3.8×3 = 11.4. Per-carton rounding is the search's rule.
  const pkgs = Array.from({ length: 3 }, () => ({ if_id: '1', box: '24x16x17', weight: 10, units: 5 }))
  const { rows } = mapEdiPackageRows({ ifs: [{ id: '1', po_dc: '9-SC' }], packages: pkgs })
  assert.equal(rows[0].cubicFeetRaw, 11.4)
})

test('mapEdiPackageRows counts a carton but reports an unusable box type', () => {
  const { rows, unparseableBoxes } = mapEdiPackageRows({
    ifs: [{ id: '1', po_dc: '77-CG' }],
    packages: [{ if_id: '1', box: 'Loose', weight: 5, units: 2 }],
  })
  assert.equal(rows[0].cartons, 1)      // the carton still counts
  assert.equal(rows[0].weight, 5)
  assert.equal(rows[0].cubicFeetRaw, 0) // but contributes no volume
  assert.deepEqual(unparseableBoxes, ['Loose']) // and says so
})

test('mapEdiPackageRows drops cartons whose fulfilment has a junk PO-DC', () => {
  const { rows, orphanCartons } = mapEdiPackageRows({
    ifs: [{ id: '1', po_dc: '7242978-SC' }, { id: '2', po_dc: 'KSA-' }],
    packages: [
      { if_id: '1', box: '18x12x5', weight: 10, units: 3 },
      { if_id: '2', box: '18x12x5', weight: 99, units: 99 },
      { if_id: '3', box: '18x12x5', weight: 99, units: 99 }, // unknown fulfilment
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].weight, 10) // the junk rows never inflate a real group
  assert.equal(orphanCartons, 2)
})
