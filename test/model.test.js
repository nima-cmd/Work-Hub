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
import { shipWindow, shipWindowFlags, isoDay } from '../src/model/shipWindow.js'
import { deriveSource } from '../src/model/source.js'
import { STAGE } from '../src/model/stages.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeContainerView } from '../src/model/ocPoContainers.js'
import { computeAffection } from '../src/model/affection.js'
import { groupOrdersByPo } from '../src/model/poGroups.js'
import { CHARACTERS, resolveCharacterForSender } from '../src/model/characters.js'
import { SHIPS, resolveShipForKey } from '../src/model/ships.js'
import { DIALOGUE, speakLine, taskContext } from '../src/model/dialogue.js'
import { deriveWork, computeEdiWork, MISSED_AFTER_DAYS } from '../src/model/ediWork.js'
import { computeEdiPipeline } from '../src/model/ediPipeline.js'
import { computeEdiPartnerTabs } from '../src/model/ediPartnerTabs.js'
import { normalizeDocNumber } from '../src/model/netsuiteDocs.js'
import { computeRoute } from '../src/model/routePlan.js'
import { buildRouteItems, applyDayPlan } from '../src/model/routeItems.js'
import { fromEdiPackagesVolume, fromShipCentralQueue } from '../src/ingest/savedSearches.js'
import { consolidateRouting, netsuiteShippedVerdict } from '../src/model/routing.js'
import { parseBoxDims, splitPoDc, mapEdiPackageRows } from '../src/ingest/ediPackagesLive.js'
import { classifyEdiDelivery, computeEdiDeliveryGaps } from '../src/model/ediDelivery.js'
import { partnerForDc, dcLabel } from '../src/model/dc.js'
import { extractPoDates, extractPoLines, summarizePoLines } from '../src/ingest/orderfulDates.js'
import { diffPoVersions, poVersionInfo } from '../src/model/ediPoDiff.js'
import { extractAsnManifest } from '../src/ingest/orderfulAsn.js'
import {
  normalizeSscc, checkAsnCartons, undeclaredByFulfilment, asnSummary,
  asnCheckDue, ASN_CHECK_MIN_HOURS, findingRows,
} from '../src/model/asnCartonCheck.js'
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

  // A non-ATS shortfall gets NO sales-order flag at all — the SO can't see the
  // OC that created the demand or the PO that funds it, so it was asserting
  // "awaiting PO" without ever checking one existed. Answered in ocPoMatch.
  const nonAts = computeFlags(
    { stage: STAGE.OPEN, isAts: false, qtyOrdered: 10, qtyAllocated: 2, qtyFulfilled: 0, fulfillments: [] },
    today,
  )
  assert.ok(!nonAts.some((f) => f.key === 'AWAITING_PO'))
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

test('computeOcPoMatches covers several OCs from one incoming PO', () => {
  // The normal shape of non-ATS demand (Nima, 2026-08-02): one PO funds several
  // order confirmations. Not a decision — everyone gets their units.
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [
      { ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 10, status: 'Open', dismissed: false },
      { ocNumber: 'OC2', item: 'SKU1', location: 'Warehouse', qty: 5, status: 'Open', dismissed: false },
    ],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 20, dismissed: false }],
    links: [],
  })
  assert.equal(candidates.length, 0)
  assert.equal(suggestedMatches.length, 2)
  assert.deepEqual(suggestedMatches.map((m) => [m.ocNumber, m.poNumber, m.allocatedQty]), [
    ['OC1', 'PO1', 10],
    ['OC2', 'PO1', 5],
  ])
  assert.ok(suggestedMatches.every((m) => m.reason === 'COVERED_BY_INCOMING'))
})

test('computeOcPoMatches draws from the PO arriving soonest first', () => {
  const { suggestedMatches } = computeOcPoMatches({
    ocs: [{ ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 12, status: 'Open', dismissed: false }],
    pos: [
      { poNumber: 'LATE', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 10, expectedReceipt: '2026-10-15', dismissed: false },
      { poNumber: 'SOON', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 8, expectedReceipt: '2026-08-15', dismissed: false },
    ],
    links: [],
  })
  assert.deepEqual(suggestedMatches.map((m) => [m.poNumber, m.allocatedQty]), [
    ['SOON', 8],
    ['LATE', 4],
  ])
})

test('computeContainerView judges shortage on all supply for the key, not one PO line', () => {
  // Two containers each bringing 12 to a key claiming 20: covered. Judging each
  // line against its own openQty called BOTH short — the read that counted 527
  // shortage items where the matcher found 45.
  const args = {
    ocs: [{ ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 20, status: 'Open', dismissed: false }],
    pos: [
      { poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 12, dismissed: false },
      { poNumber: 'PO2', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 12, dismissed: false },
    ],
    links: [],
  }
  const { containers } = computeContainerView(args)
  assert.deepEqual(containers.flatMap((c) => c.items.map((i) => i.status)), ['READY', 'READY'])
  assert.equal(containers.reduce((s, c) => s + c.shortItemCount, 0), 0)
  // …and the matcher agrees, which is the whole point of keeping both lenses.
  assert.equal(computeOcPoMatches(args).candidates.length, 0)
})

test('computeContainerView calls several OCs on one PO covered, not a decision', () => {
  const { containers } = computeContainerView({
    ocs: [
      { ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 6, status: 'Open', dismissed: false },
      { ocNumber: 'OC2', item: 'SKU1', location: 'Warehouse', qty: 4, status: 'Open', dismissed: false },
    ],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 25, dismissed: false }],
    links: [],
  })
  assert.equal(containers[0].items[0].status, 'COVERED')
  assert.equal(containers[0].shortItemCount, 0)
})

test('computeOcPoMatches reports a multi-OC shortage with the gap', () => {
  // The real non-ATS shortage, previously buried inside CONTENTION.
  const { suggestedMatches, candidates } = computeOcPoMatches({
    ocs: [
      { ocNumber: 'OC1', item: 'SKU1', location: 'Warehouse', qty: 50, status: 'Open', dismissed: false },
      { ocNumber: 'OC2', item: 'SKU1', location: 'Warehouse', qty: 23, status: 'Open', dismissed: false },
    ],
    pos: [{ poNumber: 'PO1', item: 'SKU1', destination: 'Warehouse', qtyRemaining: 20, dismissed: false }],
    links: [],
  })
  assert.equal(suggestedMatches.length, 0)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason, 'SHORTAGE')
  assert.equal(candidates[0].demand, 73)
  assert.equal(candidates[0].supply, 20)
  assert.equal(candidates[0].shortBy, 53)
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
import { palletWeight, dcTag } from '../server/bolPdf.js'

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

// The big header DC callout (Nima, 2026-08-02) — on a Bloomingdale's BOL the
// ship-to ADDRESS is the merge center, so before this the destination DC only
// appeared in a small line inside the address box, and matching cartons to the
// right BOL at labelling time was error-prone.
test('dcTag: a Bloomingdale\'s DC prints its code AND its name', () => {
  assert.equal(dcTag('CG', 'final'), 'FINAL DC: CG — China Grove DC')
  assert.equal(dcTag('SC', 'final'), 'FINAL DC: SC — Secaucus')
})

test('dcTag: a numeric Nordstrom DC prints the bare code, not "DC DC 799"', () => {
  // dcLabel('799') is already "DC 799", so echoing it would read "FINAL DC: DC 799".
  assert.equal(dcTag('799', 'final'), 'FINAL DC: 799')
  assert.equal(dcTag('089', 'final'), 'FINAL DC: 089')
})

test('dcTag: a master BOL names NO single DC — it aggregates several', () => {
  // Printing one DC on a master would actively mislabel the shipment.
  assert.equal(dcTag('CG', 'master'), 'MASTER BOL — MULTIPLE DCs')
})

test('dcTag: no DC yields no callout rather than a stray "FINAL DC:" label', () => {
  assert.equal(dcTag('', 'final'), '')
  assert.equal(dcTag(null, 'final'), '')
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

// ── EDI 850 line parsing + version diff (re-sent PO detection) ───────────────
const msgWithLines = (lines, dtms = []) => ({
  transactionSets: [{
    dateTimeReference: dtms,
    PO1_loop: lines.map((l, i) => ({
      baselineItemData: [{
        assignedIdentification: String(i + 1),
        quantity: String(l.qty),
        unitPrice: l.price != null ? String(l.price) : undefined,
        productServiceIDQualifier: 'UP', productServiceID: l.upc || '000',
        productServiceIDQualifier1: 'VA', productServiceID1: l.style,
      }],
    })),
  }],
})

test('extractPoLines reads qty/style/upc/price keyed by qualifier', () => {
  const lines = extractPoLines(msgWithLines([{ style: 'SN04023LD', upc: '810077171882', qty: 65, price: 123.48 }]))
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0], { line: '1', sku: 'SN04023LD', style: 'SN04023LD', upc: '810077171882', qty: 65, unitPrice: 123.48 })
  assert.deepEqual(summarizePoLines(lines), { totalUnits: 65, lineCount: 1 })
})

test('diffPoVersions spots a SKU swap and a moved ship window', () => {
  const v1 = { shipNotBefore: '2025-08-15', cancelAfter: '2025-08-29', lineItems: extractPoLines(msgWithLines([{ style: 'SN0312FH', qty: 50 }, { style: 'SN04023LD', qty: 65 }])) }
  const v6 = { shipNotBefore: '2025-08-01', cancelAfter: '2025-08-15', lineItems: extractPoLines(msgWithLines([{ style: 'SN03012FH', qty: 50 }, { style: 'SN04023LD', qty: 65 }])) }
  const d = diffPoVersions(v1, v6)
  assert.equal(d.changed, true)
  assert.equal(d.added[0].style, 'SN03012FH')
  assert.equal(d.removed[0].style, 'SN0312FH')
  assert.ok(d.dates.shipNotBefore && d.dates.cancelAfter)
  assert.equal(d.unitsFrom, 115); assert.equal(d.unitsTo, 115) // swap, same total
})

test('diffPoVersions: quantity change on the same SKU, no false diff on reorder', () => {
  const a = { lineItems: extractPoLines(msgWithLines([{ style: 'A', qty: 10 }, { style: 'B', qty: 20 }])) }
  const b = { lineItems: extractPoLines(msgWithLines([{ style: 'B', qty: 20 }, { style: 'A', qty: 12 }])) } // reordered + A changed
  const d = diffPoVersions(a, b)
  assert.equal(d.qtyChanges.length, 1)
  assert.deepEqual({ style: d.qtyChanges[0].style, from: d.qtyChanges[0].from, to: d.qtyChanges[0].to }, { style: 'A', from: 10, to: 12 })
  assert.equal(d.added.length, 0); assert.equal(d.removed.length, 0)
})

test('poVersionInfo re-checks only after a mark when a later send differs', () => {
  const order = { transactions: [
    { type: '850_PURCHASE_ORDER', createdAt: '2026-05-29T00:00:00Z', lineItems: extractPoLines(msgWithLines([{ style: 'A', qty: 10 }])) },
    { type: '850_PURCHASE_ORDER', createdAt: '2026-07-24T00:00:00Z', lineItems: extractPoLines(msgWithLines([{ style: 'A', qty: 25 }])) },
  ] }
  // marked BEFORE the second send → re-check fires with the qty change
  const after = poVersionInfo(order, '2026-06-01T00:00:00Z', true)
  assert.equal(after.sendCount, 2)
  assert.equal(after.needsRecheck, true)
  assert.ok(after.recheckSummary.some((s) => /qty 10.*25/.test(s)))
  // marked AFTER the latest send → nothing new to re-check
  assert.equal(poVersionInfo(order, '2026-08-01T00:00:00Z', true).needsRecheck, false)
  // no resolution → never a re-check, even with multiple versions
  assert.equal(poVersionInfo(order, null, false).needsRecheck, false)
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

// ── outbound EDI delivery gaps ───────────────────────────────────────────────
// Nima's ASNs read VALID in Orderful but never delivered, while NetSuite marked
// them synced — silent on both sides. These lock the split that makes it visible.

const asn = (o) => ({
  type: '856_SHIP_NOTICE_MANIFEST', direction: 'OUT', stream: 'LIVE',
  tradingPartner: "Bloomingdale's", ...o,
})
const NOW = new Date('2026-07-30T22:11:00Z')

test('classifyEdiDelivery: undelivered past the grace window is stuck, inside it is in flight', () => {
  const fresh = asn({ deliveryStatus: 'PENDING', createdAt: '2026-07-30T21:25:00Z' })
  const old = asn({ deliveryStatus: 'PENDING', createdAt: '2025-01-08T16:24:00Z' })
  assert.equal(classifyEdiDelivery(fresh, NOW).state, 'in_flight') // 46 min — could still land
  assert.equal(classifyEdiDelivery(old, NOW).state, 'stuck')
})

test('classifyEdiDelivery: delivered-but-rejected is refused, not stuck — a re-send is the wrong fix', () => {
  const r = classifyEdiDelivery(asn({ deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'REJECTED', createdAt: '2025-02-12T00:00:00Z' }), NOW)
  assert.equal(r.state, 'refused')
  assert.match(r.reason, /REJECTED/)
  assert.equal(classifyEdiDelivery(asn({ deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'ACCEPTED' }), NOW).state, 'ok')
})

test('computeEdiDeliveryGaps keeps ASNs, invoices and the two failures unlumped', () => {
  const g = computeEdiDeliveryGaps([
    asn({ id: '1', businessNumber: 'OLD1', deliveryStatus: 'PENDING', createdAt: '2025-01-08T16:24:00Z' }),
    asn({ id: '2', businessNumber: 'NEW1', deliveryStatus: 'PENDING', createdAt: '2026-07-30T21:25:00Z' }),
    asn({ id: '3', businessNumber: 'REJ1', deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'REJECTED', createdAt: '2025-02-12T00:00:00Z' }),
    { ...asn({ id: '4', businessNumber: 'INV1', deliveryStatus: 'PENDING', createdAt: '2025-10-21T00:00:00Z' }), type: '810_INVOICE' },
  ], NOW)
  assert.deepEqual(g.counts, {
    asnStuck: 1, invoiceStuck: 1, asnRefused: 1, invoiceRefused: 0, asnInFlight: 1, invoiceInFlight: 0,
  })
  // A stuck invoice must never be counted as a stuck ASN — different urgency.
  assert.equal(g.stuck.asn[0].businessNumber, 'OLD1')
  assert.equal(g.stuck.invoice[0].businessNumber, 'INV1')
  assert.equal(g.oldestAsnStuck.businessNumber, 'OLD1')
  assert.equal(g.oldestAsnStuck.ageDays, 568)
})

test('computeEdiDeliveryGaps ignores inbound and TEST-stream documents', () => {
  const g = computeEdiDeliveryGaps([
    { ...asn({ id: '1', deliveryStatus: 'PENDING', createdAt: '2025-01-01T00:00:00Z' }), direction: 'IN' },
    { ...asn({ id: '2', deliveryStatus: 'PENDING', createdAt: '2025-01-01T00:00:00Z' }), stream: 'TEST' },
  ], NOW)
  assert.equal(g.counts.asnStuck, 0) // a test ASN must never raise a real alert
})

// ── Pack check (Nima, 2026-08-02) ────────────────────────────────────────────
// "We just need to make sure every unit on an IF is packed, and if not we need
// to go to that IF and pack them." Checked per-FULFILMENT, not per sales order:
// an IF can be legitimately short against its SO (partial fulfilment), so an
// SO-level check would cry wolf on every split shipment.
import { checkFulfilmentPack, checkGroupPack, packSummary } from '../src/model/packCheck.js'

test('packCheck: units on the IF all in cartons → ok', () => {
  const r = checkFulfilmentPack({ ifNumber: 'IF7420', ifUnits: 12, packedUnits: 12, cartons: 3 })
  assert.equal(r.status, 'ok')
  assert.equal(r.short, 0)
})

test('packCheck: a missed item shows as short, with the exact count to go pack', () => {
  // Live case 2026-08-02: IF7350 on Nordstrom DC 584.
  const r = checkFulfilmentPack({ ifNumber: 'IF7350', ifUnits: 141, packedUnits: 82, cartons: 3 })
  assert.equal(r.status, 'short')
  assert.equal(r.short, 59)
  assert.equal(r.blankCartons, false)
})

test('packCheck: cartons made but no quantities entered is flagged distinctly', () => {
  // Live case: IF7439 — one carton with a real weight but a blank qty field.
  // The fix differs from a normal shortage: fill in the box you already made.
  const r = checkFulfilmentPack({ ifNumber: 'IF7439', ifUnits: 10, packedUnits: 0, cartons: 1 })
  assert.equal(r.status, 'short')
  assert.equal(r.blankCartons, true)
})

test('packCheck: nothing packed yet is NOT an error — mid-pack that is normal', () => {
  const r = checkFulfilmentPack({ ifNumber: 'IF7351', ifUnits: 70, packedUnits: 0, cartons: 0 })
  assert.equal(r.status, 'not_started')
  assert.equal(r.short, 0, 'not_started must not report a shortage or the check becomes noise')
})

test('packCheck: packing MORE than the IF says is caught too', () => {
  const r = checkFulfilmentPack({ ifUnits: 10, packedUnits: 12, cartons: 2 })
  assert.equal(r.status, 'over')
  assert.equal(r.over, 2)
})

test('packCheck: one short IF makes the whole group not ready — the 856 is per group', () => {
  const g = checkGroupPack([
    { ifNumber: 'IF1', ifUnits: 50, packedUnits: 50, cartons: 2 },
    { ifNumber: 'IF2', ifUnits: 38, packedUnits: 0, cartons: 1 },
  ])
  assert.equal(g.status, 'short')
  assert.equal(g.ready, false)
  assert.equal(g.shortUnits, 38)
  assert.deepEqual(g.problems.map((p) => p.ifNumber), ['IF2'])
})

test('packCheck: a group whose every IF reconciles is ready to route', () => {
  const g = checkGroupPack([
    { ifNumber: 'IF1', ifUnits: 34, packedUnits: 34, cartons: 1 },
    { ifNumber: 'IF2', ifUnits: 42, packedUnits: 42, cartons: 2 },
  ])
  assert.equal(g.status, 'ok')
  assert.equal(g.ready, true)
  assert.equal(packSummary(g), '76/76 units')
})

test('packCheck: a part-packed group reads as in_progress, not short', () => {
  // Some IFs done, others untouched — real shortages must stay distinguishable
  // from work simply not begun, or the warning gets ignored.
  const g = checkGroupPack([
    { ifNumber: 'IF1', ifUnits: 20, packedUnits: 20, cartons: 1 },
    { ifNumber: 'IF2', ifUnits: 30, packedUnits: 0, cartons: 0 },
  ])
  assert.equal(g.status, 'in_progress')
  assert.equal(g.ready, false)
  assert.equal(g.problems.length, 0)
})

test('packSummary: always shows both numbers so a clean group proves it was checked', () => {
  assert.equal(packSummary(checkGroupPack([{ ifUnits: 10, packedUnits: 4, cartons: 1 }])), '4/10 units — 6 short')
  assert.equal(packSummary(checkGroupPack([{ ifUnits: 10, packedUnits: 0, cartons: 0 }])), '0/10 units — not packed yet')
})

// ── Court strip voice (Nima, 2026-08-02) ─────────────────────────────────────
// A crew member says what to pick up next instead of a "⚑ OUR COURT" label.
// It must never invent or blend numbers — the never-lump rule still governs the
// strip; this only ever repeats one count the chips already show.
import { courtLine, warehouseLine } from '../src/model/courtVoice.js'

test('courtVoice: picks the lane Nima can finish himself, not the biggest number', () => {
  // 61 stuck invoices would drown out 4 labels every single day.
  const line = courtLine([
    { key: 'invoiceStuck', n: 61, label: 'invoices never sent' },
    { key: 'needsLabel', n: 4, label: 'need a label' },
  ])
  assert.match(line, /4 parcels need a label/)
})

test('courtVoice: an item aging past a week overrides the lane order', () => {
  const line = courtLine([{ key: 'needsLabel', n: 4, label: 'need a label' }],
    { ifNumber: 'IF7228', ageDays: 41 })
  assert.match(line, /IF7228 has been sitting 41 days/)
})

test('courtVoice: a fresh oldest item does NOT override — no false alarm', () => {
  const line = courtLine([{ key: 'needsLabel', n: 4, label: 'need a label' }],
    { ifNumber: 'IF9999', ageDays: 2 })
  assert.match(line, /need a label/)
})

test('courtVoice: singular reads properly — no "1 parcels"', () => {
  assert.match(courtLine([{ key: 'needsLabel', n: 1, label: 'need a label' }]), /One parcel needs a label/)
  assert.match(courtLine([{ key: 'canShip', n: 1, label: 'can ship' }]), /One order is/)
})

test('courtVoice: an empty board says so rather than rendering nothing', () => {
  assert.equal(courtLine([]), "Board's clear. Enjoy it.")
})

test('courtVoice: the warehouse line is empty at zero so the group can hide', () => {
  assert.equal(warehouseLine(0), '')
  assert.match(warehouseLine(1), /one of ours/)
  assert.match(warehouseLine(3), /Got 3 of ours/)
})

// ── Departures are SHIPMENTS, not fulfilments (Nima, 2026-08-02) ─────────────
// 2026-07-30 rendered as 50 departures everywhere. It was 8 — seven
// Bloomingdale's BOLs plus one parcel. Every EDI DC gets its own IF, so counting
// IFs inflates departures ~6×.
import { groupDepartures, departureSummary, departureLabel } from '../src/model/departures.js'

const BOLS = [
  { id: 1, bolNumber: 'NB1731234', dc: 'SC', partner: "Bloomingdale's", memberPos: ['7527086', '7590875', '7776940'] },
  { id: 2, bolNumber: 'NB1731236', dc: 'JP', partner: "Bloomingdale's", memberPos: ['7590875', '7776940'] },
]

test('departures: many IFs across one DC collapse into a single BOL shipment', () => {
  const g = groupDepartures([
    { ifNumber: 'IF7300', poDc: '7590875-SC', actualShipDate: '2026-07-30' },
    { ifNumber: 'IF7301', poDc: '7590875-SC', actualShipDate: '2026-07-30' },
    { ifNumber: 'IF7302', poDc: '7776940-SC', actualShipDate: '2026-07-30' },
  ], BOLS)
  assert.equal(g.length, 1, 'three IFs to the same BOL are one departure')
  assert.equal(g[0].bolNumber, 'NB1731234')
  assert.equal(g[0].fulfilments.length, 3)
  assert.deepEqual(g[0].poNumbers, ['7590875', '7776940'])
})

test('departures: different DCs on the same PO stay separate shipments', () => {
  // They physically go to different places on different BOLs.
  const g = groupDepartures([
    { ifNumber: 'IF7300', poDc: '7590875-SC' },
    { ifNumber: 'IF7299', poDc: '7590875-JP' },
  ], BOLS)
  assert.equal(g.length, 2)
  assert.deepEqual(g.map((x) => x.bolNumber).sort(), ['NB1731234', 'NB1731236'])
})

test('departures: a parcel is its own shipment — never lumped by customer', () => {
  // Two boutique parcels to one customer are two consignments with two
  // tracking numbers; merging them would undercount real departures.
  const g = groupDepartures([
    { ifNumber: 'IF7409', customer: 'Turner & Co', source: 'boutique' },
    { ifNumber: 'IF7410', customer: 'Turner & Co', source: 'boutique' },
  ], BOLS)
  assert.equal(g.length, 2)
  assert.equal(g[0].kind, 'parcel')
})

test('departures: freight with no BOL yet still consolidates per PO-DC', () => {
  // Otherwise the day's count would change purely because paperwork caught up.
  const g = groupDepartures([
    { ifNumber: 'IF1', poDc: '9999999-CG' },
    { ifNumber: 'IF2', poDc: '9999999-CG' },
  ], BOLS)
  assert.equal(g.length, 1)
  assert.equal(g[0].bolNumber, null)
  assert.equal(g[0].kind, 'freight')
  assert.equal(departureLabel(g[0]), 'DC CG (no BOL yet)')
})

test('departures: the 7/30 shape — 50 fulfilments really were 8 shipments', () => {
  const ifs = []
  // 3 Bloomingdale's POs fanned across 2 DCs = 2 BOLs, 48 fulfilments.
  for (let i = 0; i < 24; i++) ifs.push({ ifNumber: `IFa${i}`, poDc: '7590875-SC' })
  for (let i = 0; i < 24; i++) ifs.push({ ifNumber: `IFb${i}`, poDc: '7776940-JP' })
  ifs.push({ ifNumber: 'IF7281', customer: 'Rustan' }) // the lone parcel
  const g = groupDepartures(ifs, BOLS)
  assert.equal(g.length, 3)
  assert.equal(departureSummary(g), '3 departures · 49 fulfilments')
})

test('departureSummary: never shows the fulfilment count alone', () => {
  // The whole failure was a big number reading as a shipment count.
  assert.equal(departureSummary([{ fulfilments: [1] }]), '1 departure')
  assert.match(departureSummary([{ fulfilments: [1, 2, 3] }]), /1 departure · 3 fulfilments/)
  assert.equal(departureSummary([]), '')
})

test('departures: a BOL leaves once even if its IFs were stamped on two days', () => {
  const g = groupDepartures([
    { ifNumber: 'IF1', poDc: '7590875-SC', actualShipDate: '2026-07-31' },
    { ifNumber: 'IF2', poDc: '7590875-SC', actualShipDate: '2026-07-30' },
  ], BOLS)
  assert.equal(g.length, 1)
  assert.equal(g[0].shipDate, '2026-07-30', 'earliest wins — the truck left once')
})

// ── PO-DC parsing (hardened 2026-08-02) ─────────────────────────────────────
// Purchase orders contain dashes, so splitting on the FIRST one invented a DC:
// Rustan's "720-0326-19551-" read as PO 720 in DC "0326-19551-", which made a
// parcel count as its own freight departure. (splitPoDc is imported at the top.)

test('splitPoDc: the normal shapes still parse', () => {
  assert.deepEqual(splitPoDc('7590875-SC'), { poNumber: '7590875', dc: 'SC' })
  assert.deepEqual(splitPoDc('50073677-799'), { poNumber: '50073677', dc: '799' })
  assert.deepEqual(splitPoDc('50073677-089'), { poNumber: '50073677', dc: '089' })
})

test('splitPoDc: a PO containing dashes splits on the LAST one', () => {
  assert.deepEqual(splitPoDc('720-0326-19551-CG'), { poNumber: '720-0326-19551', dc: 'CG' })
})

test('splitPoDc: rejects the junk the live data actually carries', () => {
  for (const junk of ['-', 'KSA-', '16844-', '720-0326-19551-', 'Pre-Fall 26 Bags-', '', null]) {
    assert.equal(splitPoDc(junk), null, `${JSON.stringify(junk)} is not a PO-DC`)
  }
})

test('splitPoDc: a trailing fragment that is not DC-shaped is rejected', () => {
  // "Pre-Fall 26 Bags" would otherwise yield DC "Fall 26 Bags".
  assert.equal(splitPoDc('Pre-Fall 26 Bags'), null)
  assert.equal(splitPoDc('EQUS100026915-'), null)
})

// ── Live-sync health (2026-07-31) ───────────────────────────────────────────
// Distinct from data freshness: a sync that STOPS looks exactly like a quiet
// day. Both of this repo's silent-drift incidents were that shape — PR #16's
// sync had no caller for a week, and the scheduled check returns 200 while the
// NetSuite pull inside it does nothing when creds are missing on the deploy.
import { computeSyncHealth, syncHealthLine, syncStatus } from '../src/model/syncHealth.js'

const SYNC_NOW = new Date('2026-07-31T03:00:00Z')
const hoursAgo = (h) => new Date(SYNC_NOW.getTime() - h * 3.6e6).toISOString()

test('syncHealth: thresholds allow for GitHub throttling, not the requested cadence', () => {
  // The workflow asks for every 10 min; GitHub really fires it ~90 min apart, so
  // warning at 10 min would be permanently on — the same as being off.
  assert.equal(syncStatus(1.5), 'ok')
  assert.equal(syncStatus(2.9), 'ok')
  assert.equal(syncStatus(4), 'warn')
  assert.equal(syncStatus(7), 'stale')
  assert.equal(syncStatus(null), 'never')
})

test('syncHealth: healthy when every live sync has run recently', () => {
  const h = computeSyncHealth({ netsuiteLive: hoursAgo(1), ediPackagesLive: hoursAgo(0.2) }, SYNC_NOW)
  assert.equal(h.status, 'ok')
  assert.equal(h.ok, true)
  assert.equal(syncHealthLine(h), '', 'a healthy app shows no bar at all')
})

test('syncHealth: the worst single sync wins — averaging would hide the dead one', () => {
  // The real 2026-07-30 shape: cartons current, NetSuite 5h behind.
  const h = computeSyncHealth({ netsuiteLive: hoursAgo(5), ediPackagesLive: hoursAgo(0.2) }, SYNC_NOW)
  assert.equal(h.status, 'warn')
  assert.match(syncHealthLine(h), /NetSuite orders & fulfilments last synced 5h ago/)
})

test('syncHealth: a sync that never ran is worse than a stale one', () => {
  const h = computeSyncHealth({ ediPackagesLive: hoursAgo(0.2) }, SYNC_NOW)
  assert.equal(h.status, 'never')
  assert.match(syncHealthLine(h), /has never completed a sync here/)
})

test('syncHealth: the line names the sync — an anonymous warning gets ignored', () => {
  const h = computeSyncHealth({ netsuiteLive: hoursAgo(50), ediPackagesLive: hoursAgo(49) }, SYNC_NOW)
  assert.equal(h.status, 'stale')
  const line = syncHealthLine(h)
  assert.match(line, /NetSuite/, 'names the worst offender')
  assert.match(line, /2d 2h/, 'days once past 24h, not "50h"')
  assert.match(line, /and 1 other/, 'says how many more are affected')
})

// ── Health: connections & data flow (2026-07-31) ─────────────────────────────
// Built after the deploy went 13h without a NetSuite sync while its cron
// returned 200 every run. The cause was five env vars missing on Render, and the
// reason nothing complained is structural: EVERY integration here is gated on an
// xConfigured() check and skips silently when unset. Right for local dev,
// dangerous in production — so absence must report as loudly as failure.
import { computeIntegrationHealth, overallHealth, INTEGRATIONS } from '../src/model/health.js'

const allSet = () => {
  const p = {}
  for (const i of INTEGRATIONS) for (const v of [...i.vars, ...(i.optional || [])]) p[v] = true
  return p
}

test('health: names the missing variables — that IS the fix', () => {
  const p = allSet()
  delete p.NS_TOKEN_ID
  delete p.NS_TOKEN_SECRET
  const ns = computeIntegrationHealth(p).find((i) => i.key === 'netsuite')
  assert.equal(ns.configured, false)
  assert.deepEqual(ns.missing, ['NS_TOKEN_ID', 'NS_TOKEN_SECRET'])
})

test('health: a missing optional key is "partial", not broken', () => {
  // No V2 key means no live rate comparison, but billed history still works.
  const p = allSet()
  delete p.SHIPSTATION_API_KEY_V2
  const ss = computeIntegrationHealth(p).find((i) => i.key === 'shipstation')
  assert.equal(ss.configured, true)
  assert.equal(ss.partial, true)
  assert.deepEqual(ss.missingOptional, ['SHIPSTATION_API_KEY_V2'])
})

test('health: a missing credential outranks a stale sync — it is usually the CAUSE', () => {
  // The exact 2026-07-31 shape: NS_* absent on the deploy, netsuiteLive 13h old.
  const p = allSet()
  for (const v of INTEGRATIONS.find((i) => i.key === 'netsuite').vars) delete p[v]
  const integrations = computeIntegrationHealth(p)
  const v = overallHealth({ integrations, syncs: { status: 'stale' } })
  assert.equal(v.status, 'broken')
  assert.match(v.headline, /NetSuite is not configured — 5 variables missing/)
  assert.match(v.detail, /why the data below is stale/, 'connects the two symptoms')
})

test('health: a stale sync with everything configured reads as its own problem', () => {
  const v = overallHealth({ integrations: computeIntegrationHealth(allSet()), syncs: { status: 'warn' } })
  assert.equal(v.status, 'stale')
  assert.equal(v.detail, null)
})

test('health: all good says so', () => {
  const v = overallHealth({ integrations: computeIntegrationHealth(allSet()), syncs: { status: 'ok' } })
  assert.equal(v.status, 'ok')
})

test('health: every integration declares what breaks without it', () => {
  // A row that just says "not configured" tells you nothing actionable.
  for (const i of INTEGRATIONS) {
    assert.ok(i.powers?.length, `${i.key} must say what it powers`)
    assert.ok(i.ifMissing?.length, `${i.key} must say what happens when it's absent`)
  }
})

// ── Carton-level ASN reconciliation ──────────────────────────────────────────
// Shapes below mirror real data checked live 2026-07-31: NetSuite stores the
// SSCC bare (18 digits), Orderful's 856 transmits it zero-padded (20).

test('asn: the 856 zero-pads the SSCC and NetSuite does not — they must still match', () => {
  // This is the whole reason normalizeSscc exists. A raw string compare here
  // reports every carton unannounced, which reads as a disaster, not a format bug.
  assert.equal(normalizeSscc('00185072747003728869'), '185072747003728869')
  assert.equal(normalizeSscc('185072747003728869'), '185072747003728869')
  const r = checkAsnCartons({
    packed: [{ sscc: '185072747003728869', ifNumber: 'IF7323' }],
    declared: [{ sscc: '00185072747003728869', businessNumber: 'NB1731234' }],
  })
  assert.equal(r.status, 'ok')
  assert.equal(r.counts.matched, 1)
  assert.equal(r.counts.undeclared, 0)
})

test('asn: only leading zeros are stripped — a wrong-length value stays a mismatch', () => {
  // Truncating significant digits would manufacture a false match, which is
  // worse than the miss it hides.
  assert.equal(normalizeSscc('99185072747003728869'), '99185072747003728869')
  assert.equal(normalizeSscc(''), null)
  assert.equal(normalizeSscc(null), null)
  // Separators and stray whitespace are stripped; the digits themselves are not.
  assert.equal(normalizeSscc('  1850-7274 7003728869 '), '185072747003728869')
})

test('asn: a carton that shipped without being announced is the chargeback finding', () => {
  const r = checkAsnCartons({
    packed: [
      { sscc: '185072747000000001', ifNumber: 'IF7323', poDc: '7527086-SC' },
      { sscc: '185072747000000002', ifNumber: 'IF7323', poDc: '7527086-SC' },
    ],
    declared: [{ sscc: '00185072747000000001', businessNumber: 'NB1731234' }],
  })
  assert.equal(r.status, 'undeclared')
  assert.equal(r.counts.undeclared, 1)
  assert.equal(r.undeclared[0].sscc, '185072747000000002')
  assert.equal(r.undeclared[0].ifNumber, 'IF7323')
  // Grouped by fulfilment, because you re-send an ASN per shipment, not per box.
  const groups = undeclaredByFulfilment(r)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].ssccs, ['185072747000000002'])
})

test('asn: an announced carton with no NetSuite record is a phantom box', () => {
  const r = checkAsnCartons({
    packed: [{ sscc: '185072747000000001', ifNumber: 'IF7323' }],
    declared: [
      { sscc: '00185072747000000001', businessNumber: 'NB1731234' },
      { sscc: '00185072747000000009', businessNumber: 'NB1731234' },
    ],
  })
  assert.equal(r.status, 'phantom')
  assert.equal(r.counts.phantom, 1)
  assert.equal(r.phantom[0].sscc, '185072747000000009')
  assert.deepEqual(r.phantom[0].declaredOn, ['NB1731234'])
})

test('asn: nothing announced yet is not a failure', () => {
  // Same reasoning as packCheck's not_started — pre-transmission there is
  // nothing to reconcile, and crying wolf there is what gets a check ignored.
  const r = checkAsnCartons({ packed: [{ sscc: '185072747000000001', ifNumber: 'IF7323' }], declared: [] })
  assert.equal(r.status, 'no_asn')
  assert.equal(r.counts.undeclared, 0)
  assert.match(asnSummary(r), /no ASN yet/)
  assert.equal(checkAsnCartons({}).status, 'empty')
  assert.equal(asnSummary(checkAsnCartons({})), '')
})

test('asn: a carton with a blank SSCC is reported apart from a real miss', () => {
  // The box exists and a field was left empty — same human error as the pack
  // check's blank-quantity cartons, and a different fix from "send the ASN".
  const r = checkAsnCartons({
    packed: [{ sscc: '', ifNumber: 'IF7439' }, { sscc: null, ifNumber: 'IF7439' }],
    declared: [{ sscc: '00185072747000000001' }],
  })
  assert.equal(r.counts.blankSscc, 2)
  assert.equal(r.counts.packed, 0)
})

test('asn: a duplicated SSCC is its own defect', () => {
  const r = checkAsnCartons({
    packed: [
      { sscc: '185072747000000001', ifNumber: 'IF7323' },
      { sscc: '185072747000000001', ifNumber: 'IF7324' },
    ],
    declared: [{ sscc: '00185072747000000001' }],
  })
  assert.equal(r.counts.duplicated, 1)
  assert.deepEqual(r.duplicated[0].ifNumbers, ['IF7323', 'IF7324'])
})

test('asn: the manifest reads pack-level SSCCs and order-level POs, ignoring other marks', () => {
  // Structure copied from the real Bloomingdale's ASN (txn 996376235).
  const message = {
    transactionSets: [{
      HL_loop: [
        { hierarchicalLevel: [{ hierarchicalLevelCode: 'S' }] },
        { hierarchicalLevel: [{ hierarchicalLevelCode: 'O' }], purchaseOrderReference: [{ purchaseOrderNumber: '7527086' }] },
        { hierarchicalLevel: [{ hierarchicalLevelCode: 'O' }], purchaseOrderReference: [{ purchaseOrderNumber: '7776940' }] },
        {
          hierarchicalLevel: [{ hierarchicalLevelCode: 'P' }],
          marksAndNumbersInformation: [{ marksAndNumbersQualifier: 'GM', marksAndNumbers: '00185072747003728869' }],
        },
        {
          // A non-GM mark must not be mistaken for a license plate.
          hierarchicalLevel: [{ hierarchicalLevelCode: 'P' }],
          marksAndNumbersInformation: [{ marksAndNumbersQualifier: 'CA', marksAndNumbers: 'CARTON-2' }],
        },
        { hierarchicalLevel: [{ hierarchicalLevelCode: 'I' }] },
      ],
    }],
  }
  const m = extractAsnManifest(message)
  assert.deepEqual(m.poNumbers, ['7527086', '7776940'])
  assert.deepEqual(m.ssccs, ['00185072747003728869'])
  assert.equal(m.packCount, 2)
  // The second pack declared a carton with no SSCC — visible, not silently dropped.
  assert.equal(m.packsWithoutSscc, 1)
  assert.deepEqual(extractAsnManifest({}).ssccs, [])
  assert.deepEqual(extractAsnManifest(null).poNumbers, [])
})

test('asn: a carton announced on two ASNs explains the declared-count gap', () => {
  // Without this, a raw declared count of 3 against 2 unique cartons looks like
  // an unexplained discrepancy, which is what makes a check stop being trusted.
  const r = checkAsnCartons({
    packed: [{ sscc: '185072747000000001', ifNumber: 'IF6941' }, { sscc: '185072747000000002', ifNumber: 'IF6941' }],
    declared: [
      { sscc: '00185072747000000001', businessNumber: '6592086SC' },
      { sscc: '00185072747000000001', businessNumber: '6592086ST' },
      { sscc: '00185072747000000002', businessNumber: '6592086SC' },
    ],
  })
  assert.equal(r.status, 'ok')
  assert.equal(r.counts.declared, 2)
  assert.equal(r.counts.reDeclared, 1)
  assert.deepEqual(r.reDeclared[0].declaredOn, ['6592086SC', '6592086ST'])
})

test('asn: a check that has never run is always due — that is the failure mode here', () => {
  // This repo has twice shipped a module with no caller, which looks exactly
  // like a working feature. "Never ran" must never read as "nothing to do".
  assert.equal(asnCheckDue(null), true)
  assert.equal(asnCheckDue(undefined), true)
})

test('asn: the cadence skips a fresh run and allows a stale one', () => {
  const now = new Date('2026-07-31T18:00:00Z')
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600000)
  assert.equal(asnCheckDue(hoursAgo(1), now), false)
  assert.equal(asnCheckDue(hoursAgo(ASN_CHECK_MIN_HOURS - 0.1), now), false)
  assert.equal(asnCheckDue(hoursAgo(ASN_CHECK_MIN_HOURS), now), true)
  assert.equal(asnCheckDue(hoursAgo(30), now), true)
  // A timestamp in the future (clock skew between the deploy and Neon) must not
  // wedge the check off forever — it reads as due.
  assert.equal(asnCheckDue(new Date(now.getTime() + 3600000), now), true)
})

test('asn: findingRows keeps the matched cartons, not just the failures', () => {
  // The headline is "710/710 announced". Storing only failures would leave the
  // UI able to say no problems found, which is also what never-looked says.
  const r = checkAsnCartons({
    packed: [
      { sscc: '185072747000000001', ifNumber: 'IF6941', poDc: '6592086-CG' },
      { sscc: '185072747000000002', ifNumber: 'IF6941', poDc: '6592086-CG' },
    ],
    declared: [{ sscc: '00185072747000000001', businessNumber: '6592086SC' }],
  })
  const rows = findingRows(r)
  const matched = rows.filter((x) => x.finding === 'matched')
  const undeclared = rows.filter((x) => x.finding === 'undeclared')
  assert.equal(matched.length, 1)
  assert.deepEqual(matched[0].declaredOn, ['6592086SC'])
  assert.equal(undeclared.length, 1)
  assert.equal(undeclared[0].ifNumber, 'IF6941')
  assert.equal(undeclared[0].poDc, '6592086-CG')
})

test('asn: a duplicated SSCC becomes one row per fulfilment — which boxes clash is the point', () => {
  const r = checkAsnCartons({
    packed: [
      { sscc: '185072747000000009', ifNumber: 'IF7001' },
      { sscc: '185072747000000009', ifNumber: 'IF7002' },
    ],
    declared: [{ sscc: '00185072747000000009', businessNumber: '6592086SC' }],
  })
  const dup = findingRows(r).filter((x) => x.finding === 'duplicated')
  assert.deepEqual(dup.map((d) => d.ifNumber), ['IF7001', 'IF7002'])
  // Also still matched — the counts come off the run row, never off these rows,
  // precisely because one carton can carry two findings.
  assert.equal(findingRows(r).filter((x) => x.finding === 'matched').length, 1)
})

test('asn: a blank-SSCC carton still records WHICH fulfilment to go fix', () => {
  const r = checkAsnCartons({
    packed: [{ sscc: '', ifNumber: 'IF7439', poDc: '6592086-799' }],
    declared: [{ sscc: '00185072747000000001', businessNumber: '6592086SC' }],
  })
  const blank = findingRows(r).filter((x) => x.finding === 'blank_sscc')
  assert.equal(blank.length, 1)
  assert.equal(blank[0].sscc, null)
  assert.equal(blank[0].ifNumber, 'IF7439')
})

// ── Ship windows (src/model/shipWindow.js) ───────────────────────────────────
// The measured case that motivated the module: on 12 of 12 open EDI POs the
// sales order's ship date disagreed with the partner's 850, and on 8 of them it
// promised a date the partner had already cancelled on. PO 8040313 is real —
// 13 SOs, SO says Aug 21, Bloomingdale's cancels Aug 10.

const AUG2 = new Date(2026, 7, 2) // 2026-08-02, local midnight

test('shipWindow: the partner 850 sets the deadline, not the sales order', () => {
  const w = shipWindow({
    customer: "Bloomingdale's - 059", shipDate: '2026-08-21',
    ediWindow: { shipNotBefore: '2026-07-27', cancelAfter: '2026-08-10' },
  }, AUG2)
  assert.equal(w.source, 'edi')
  assert.equal(isoDay(w.mustShipBy), '2026-08-10')  // NOT the SO's 8/21
  assert.equal(w.daysToShip, 8)
  assert.equal(w.soPastCancel, true)
})

test('shipWindow: a boutique order still runs on its own ship date', () => {
  const w = shipWindow({ customer: 'Some Boutique', shipDate: '2026-08-05' }, AUG2)
  assert.equal(w.source, 'so')
  assert.equal(w.daysToShip, 3)
  assert.equal(w.soPastCancel, false)  // no 850 → nothing to disagree with
})

test("shipWindow: Bloomingdale's may start a week before its DC start date", () => {
  const bloomies = {
    customer: "Bloomingdale's - 059",
    ediWindow: { shipNotBefore: '2026-08-06', cancelAfter: '2026-08-20' },
  }
  const w = shipWindow(bloomies, AUG2)
  assert.equal(w.headstartDays, 7)
  assert.equal(isoDay(w.opens), '2026-07-30')
  assert.equal(w.notOpenYet, false)   // already workable on 8/2

  // Nordstrom is rigid: the same dates, no headstart, so it is NOT workable yet.
  const nord = shipWindow({ ...bloomies, customer: 'Nordstrom - 599' }, AUG2)
  assert.equal(nord.headstartDays, 0)
  assert.equal(isoDay(nord.opens), '2026-08-06')
  assert.equal(nord.notOpenYet, true)
})

test('shipWindow: a headstart never drags the cancel date earlier', () => {
  // Only the OPEN side moves — inferring an earlier deadline would invent
  // urgency the partner never asked for.
  const w = shipWindow({
    customer: "Bloomingdale's", ediWindow: { shipNotBefore: '2026-08-06', cancelAfter: '2026-08-20' },
  }, AUG2)
  assert.equal(isoDay(w.mustShipBy), '2026-08-20')
})

test('shipWindow: no honest date anywhere → no window, never a guessed one', () => {
  assert.equal(shipWindow({ customer: 'X' }, AUG2), null)
  assert.equal(shipWindow({ customer: 'X', ediWindow: {} }, AUG2), null)
})

test('shipWindowFlags: graduated by how much runway is left', () => {
  const at = (shipDate) => shipWindowFlags({ customer: 'B', shipDate }, AUG2).map((f) => f.key)
  assert.deepEqual(at('2026-07-30'), ['OVERDUE'])    // 3d past
  assert.deepEqual(at('2026-08-02'), ['DUE_TODAY'])
  assert.deepEqual(at('2026-08-04'), ['PACK_NOW'])   // inside the 2d pack lead
  assert.deepEqual(at('2026-08-08'), ['DUE_SOON'])   // within the 7d watch
  assert.deepEqual(at('2026-08-28'), [])             // far out — stays quiet
})

test('shipWindowFlags: severities match the legend (3 act now / 2 caution / 1 watch)', () => {
  const sev = (shipDate, key) =>
    shipWindowFlags({ customer: 'B', shipDate }, AUG2).find((f) => f.key === key).severity
  assert.equal(sev('2026-07-30', 'OVERDUE'), 3)
  assert.equal(sev('2026-08-02', 'DUE_TODAY'), 2)
  assert.equal(sev('2026-08-04', 'PACK_NOW'), 2)
  assert.equal(sev('2026-08-08', 'DUE_SOON'), 1)
})

test('shipWindowFlags: the SO promising a date past the partner cancel is its own flag', () => {
  // The bug this whole module exists for: SO 8/21 reads as comfortably future,
  // so before this the board showed NOTHING while the cancel date was 8/10.
  const flags = shipWindowFlags({
    customer: "Bloomingdale's", shipDate: '2026-08-21',
    ediWindow: { shipNotBefore: '2026-07-27', cancelAfter: '2026-08-10' },
  }, AUG2)
  // 8/10 is 8 days out — one day past the watch tier, so no urgency flag fires
  // yet. SO_PAST_CANCEL is what surfaces it anyway, and that's the point: the
  // disagreement is worth naming BEFORE the real date gets close, because the
  // fix is in NetSuite and takes a human.
  assert.deepEqual(flags.map((f) => f.key), ['SO_PAST_CANCEL'])
  // Ranked off the SO date alone it would have raised nothing at all.
  assert.deepEqual(shipWindowFlags({ customer: "Bloomingdale's", shipDate: '2026-08-21' }, AUG2), [])
})

test('shipWindowFlags: a window that has not opened says so at severity 0', () => {
  const f = shipWindowFlags({
    customer: 'Nordstrom', ediWindow: { shipNotBefore: '2026-08-20', cancelAfter: '2026-08-30' },
  }, AUG2).find((x) => x.key === 'WINDOW_NOT_OPEN')
  assert.equal(f.severity, 0)   // not a problem — the reason not to pull it forward
})

test('computeFlags: an EDI order inherits the window flags through the pipeline', () => {
  const keys = computeFlags({
    customer: "Bloomingdale's", shipDate: '2026-08-21', fulfillments: [],
    ediWindow: { shipNotBefore: '2026-07-27', cancelAfter: '2026-08-10' },
  }, AUG2).map((f) => f.key)
  assert.ok(keys.includes('SO_PAST_CANCEL'))
})

test('poGroups: a PO group takes the TIGHTEST deadline of its members', () => {
  const mk = (soNumber, shipDate) => ({
    soNumber, poNumber: '8040313', customer: "Bloomingdale's", source: 'edi',
    stage: 'OPEN_NEEDS_FULFILLMENT', shipDate, fulfillments: [], invoices: [],
    shipWindow: shipWindow({ customer: "Bloomingdale's", shipDate }, AUG2),
  })
  const [g] = groupOrdersByPo([mk('SO1', '2026-08-21'), mk('SO2', '2026-08-09')])
  assert.equal(g.isGroup, true)
  assert.equal(isoDay(g.shipWindow.mustShipBy), '2026-08-09')
})

test('shipWindow: a shipped order has no deadline left to miss', () => {
  const late = { customer: 'Boutique', shipDate: '2026-06-10' }
  // Still open → 53 days overdue, correctly loud.
  assert.equal(shipWindowFlags(late, AUG2)[0].key, 'OVERDUE')
  // Shipped → silent. The window was met; it is not a window missed.
  assert.equal(shipWindow({ ...late, stage: 'SHIPPED' }, AUG2).shipped, true)
  assert.deepEqual(shipWindowFlags({ ...late, stage: 'SHIPPED' }, AUG2), [])
  // An actual ship date on any fulfilment counts too, whatever the stage says.
  assert.deepEqual(
    shipWindowFlags({ ...late, fulfillments: [{ actualShipDate: '2026-06-09' }] }, AUG2), [])
})

// ── EDI per-partner flow tabs (Nima, 2026-08-02) ─────────────────────────────
// The four questions: 850-with-no-SO · SO-with-no-IF · IF-not-shipped ·
// shipped-but-no-856. Built 2026-08-02 alongside the fan-out fix below.

test('computeEdiPipeline: an EDI PO keeps ALL its sales orders, one per store', () => {
  // The regression this guards: netsuiteByPoNumber used to be po -> order, so
  // the LAST sales order won and the other 24 vanished. Live, PO 50073677 has
  // 25 SOs and the board showed 1 — 111 of 129 EDI sales orders invisible.
  const txns = [{ id: 't1', type: '850_PURCHASE_ORDER', businessNumber: 'PO1', tradingPartner: 'Nordstrom', createdAt: '2026-07-01', lastUpdatedAt: '2026-07-01', direction: 'IN' }]
  const nsOrders = [
    { poNumber: 'PO1', soNumber: 'SO3', stage: 'OPEN_NEEDS_FULFILLMENT', itemFulfillments: [], invoices: [] },
    { poNumber: 'PO1', soNumber: 'SO1', stage: 'SHIPPED', itemFulfillments: [{ ifNumber: 'IF1', actualShipDate: '2026-07-10' }], invoices: [] },
    { poNumber: 'PO1', soNumber: 'SO2', stage: 'PICKED_NEEDS_PACK', itemFulfillments: [{ ifNumber: 'IF2', actualShipDate: null }], invoices: [] },
  ]
  const { orders } = computeEdiPipeline(txns, [], nsOrders, [], [], [])
  const po = orders.find((o) => o.businessNumber === 'PO1')
  assert.equal(po.netsuiteOrders.length, 3)
  assert.equal(po.netsuiteOrder.soNumber, 'SO1')   // sorted, and still the singular
  // ANY sales order having shipped makes an ASN due — a shipped DC is an
  // unannounced shipment whether or not its siblings have moved.
  assert.equal(po.bucket, 'NEEDS_ASN')
})

test('ediPartnerTabs: the four lists split by the right unit — PO, SO, IF, PO', () => {
  const txns = [{ id: 't1', type: '850_PURCHASE_ORDER', businessNumber: 'PO1', tradingPartner: 'Nordstrom', createdAt: new Date(T0 - 30 * DAY_MS).toISOString(), lastUpdatedAt: '2026-07-01', direction: 'IN' }]
  const nsOrders = [
    { poNumber: 'PO1', soNumber: 'SO1', stage: 'OPEN_NEEDS_FULFILLMENT', itemFulfillments: [], invoices: [] },
    { poNumber: 'PO1', soNumber: 'SO2', stage: 'OPEN_NEEDS_FULFILLMENT', itemFulfillments: [], invoices: [] },
    { poNumber: 'PO1', soNumber: 'SO3', stage: 'PICKED_NEEDS_PACK', itemFulfillments: [{ ifNumber: 'IF1', status: 'Picked', actualShipDate: null }], invoices: [] },
  ]
  const { orders } = computeEdiPipeline(txns, [], nsOrders, [], [], [])
  const work = computeEdiWork(orders, [], T0)
  const tabs = computeEdiPartnerTabs(work.orders, { today: T0 })
  assert.equal(tabs.noSalesOrder.length, 0)     // it HAS sales orders
  assert.equal(tabs.noFulfillment.length, 2)    // per SO, not per PO
  assert.equal(tabs.notShipped.length, 1)       // per IF
  assert.equal(tabs.noAsn.length, 0)            // nothing shipped yet
})

test('ediPartnerTabs: an 850 with no SO only counts while no 856/810 was ever sent', () => {
  const mk = (extra) => ({
    businessNumber: 'PO1', tradingPartner: 'Saks', bucket: 'NEEDS_IMPORT',
    transactions: [], netsuiteOrders: [], cancelAfter: null, shipNotBefore: null,
    work: { age850: 40, closed: false, parked: false }, ...extra,
  })
  // never announced, never invoiced → genuinely nobody entered it
  assert.equal(computeEdiPartnerTabs([mk({ stageRank: 1 })], { today: T0 }).noSalesOrder.length, 1)
  assert.equal(computeEdiPartnerTabs([mk({ stageRank: 1 })], { today: T0 }).noSalesOrder[0].missed, true)
  // an 856 exists → an order plainly existed; it has just aged out of the sync
  // window, so this is NOT a missing sales order.
  assert.equal(computeEdiPartnerTabs([mk({ stageRank: 3 })], { today: T0 }).noSalesOrder.length, 0)
  // closed and parked POs are out of scope entirely
  assert.equal(computeEdiPartnerTabs([mk({ stageRank: 1, work: { age850: 40, closed: true } })], { today: T0 }).noSalesOrder.length, 0)
  assert.equal(computeEdiPartnerTabs([mk({ stageRank: 1, work: { age850: 40, parked: true } })], { today: T0 }).noSalesOrder.length, 0)
})

test('ediPartnerTabs: a re-sent ASN does not make a delivered PO look unannounced', () => {
  // The false positive this guards: "any 856 not DELIVERED" counts a PO that
  // ALSO has a good delivered copy. Live that read 14 gaps against a true 0.
  const shipped = { poNumber: 'PO1', soNumber: 'SO1', stage: 'SHIPPED', itemFulfillments: [{ ifNumber: 'IF1', actualShipDate: '2026-07-10' }], invoices: [] }
  const base = (asns) => {
    const txns = [
      { id: 't1', type: '850_PURCHASE_ORDER', businessNumber: 'PO1', tradingPartner: 'Bloomies', createdAt: '2026-07-01', lastUpdatedAt: '2026-07-01', direction: 'IN' },
      ...asns,
    ]
    const { orders } = computeEdiPipeline(txns, [], [shipped], [], [], [])
    return computeEdiPartnerTabs(computeEdiWork(orders, [], T0).orders, { today: T0 })
  }
  const asn = (id, delivery, ack) => ({ id, type: '856_SHIP_NOTICE_MANIFEST', businessNumber: 'PO1', direction: 'OUT', deliveryStatus: delivery, acknowledgmentStatus: ack, createdAt: '2026-07-11', lastUpdatedAt: '2026-07-11' })

  assert.equal(base([asn('a1', 'PENDING', 'NOT_ACKNOWLEDGED'), asn('a2', 'DELIVERED', 'ACCEPTED')]).noAsn.length, 0)
  assert.equal(base([]).noAsn[0].state, 'none')
  assert.equal(base([asn('a1', 'PENDING', 'NOT_ACKNOWLEDGED')]).noAsn[0].state, 'undelivered')
  // delivered then rejected needs READING, not a re-send — its own state
  assert.equal(base([asn('a1', 'DELIVERED', 'REJECTED')]).noAsn[0].state, 'refused')
})

test('ediPartnerTabs: an undelivered ASN counts even when its sales orders aged out', () => {
  // An 856 is itself proof we shipped. Gating on a visible shipped fulfilment
  // would hide exactly the shipments whose orders left the sync window.
  const txns = [
    { id: 't1', type: '850_PURCHASE_ORDER', businessNumber: 'PO1', tradingPartner: 'Bloomies', createdAt: '2026-07-01', lastUpdatedAt: '2026-07-01', direction: 'IN' },
    { id: 'a1', type: '856_SHIP_NOTICE_MANIFEST', businessNumber: 'PO1', direction: 'OUT', deliveryStatus: 'PENDING', acknowledgmentStatus: 'NOT_ACKNOWLEDGED', createdAt: '2026-07-11', lastUpdatedAt: '2026-07-11' },
  ]
  const { orders } = computeEdiPipeline(txns, [], [], [], [], [])   // no NetSuite orders at all
  const tabs = computeEdiPartnerTabs(computeEdiWork(orders, [], T0).orders, { today: T0 })
  assert.equal(tabs.noAsn.length, 1)
  assert.equal(tabs.noAsn[0].evidence, 'asn')
  assert.equal(tabs.noAsn[0].shippedCount, 0)
  // and it must NOT also be filed as a missing sales order — we shipped it
  assert.equal(tabs.noSalesOrder.length, 0)
})
