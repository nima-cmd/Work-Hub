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
import { fromEdiPackagesVolume } from '../src/ingest/savedSearches.js'
import { consolidateRouting } from '../src/model/routing.js'
import { partnerForDc, dcLabel } from '../src/model/dc.js'

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

test('ediWork: 810-complete auto-closes; shipped-in-NetSuite needs the ASN', () => {
  const done = deriveWork(edi850(10, { stageRank: 4 }), null, T0)
  assert.equal(done.closed, true)
  assert.equal(done.closedBy, 'docs')
  const needsAsn = deriveWork(
    edi850(10, { stageRank: 1, netsuiteOrder: { soNumber: 'SO1', stage: 'SHIPPED' } }), null, T0)
  assert.match(needsAsn.needed, /856 ASN/)
})

test('ediWork: passed cancel date on an unshipped PO screams in the needed line', () => {
  const w = deriveWork(edi850(20, { cancelAfter: new Date(T0 - 3 * DAY_MS).toISOString() }), null, T0)
  assert.equal(w.cancelState, 'passed')
  assert.match(w.needed, /Cancel date passed 3d ago/)
})

test('computeEdiWork: partner rollup counts open/closed and the ratio', () => {
  const orders = [
    edi850(30),                                              // open + missed
    edi850(2, { businessNumber: 'PO2', stageRank: 4 }),      // auto-closed
    edi850(2, { businessNumber: 'PO3' }),                    // open
  ]
  const { partners, totals } = computeEdiWork(orders, [], T0)
  assert.equal(partners.length, 1)
  assert.equal(partners[0].open, 2)
  assert.equal(partners[0].closed, 1)
  assert.equal(partners[0].missed, 1)
  assert.ok(Math.abs(partners[0].closedRatio - 1 / 3) < 1e-9)
  assert.deepEqual({ open: totals.open, closed: totals.closed }, { open: 2, closed: 1 })
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
