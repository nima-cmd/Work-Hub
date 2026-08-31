// test/bulkPick.test.js — the bulk pick ticket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bulkPick, parsePoInput, storeOf, isGoodsLine, pickLines } from '../src/model/bulkPick.js'

// A sales order line as SuiteQL returns it. ⚠️ quantity NEGATIVE — that is what the real
// query gives for a sales order, 1,884 of 1,884 open lines.
const line = (o) => ({ po: 'P1', tranid: 'SO1', customer: 'Nordstrom : Store A', sku: 'SN01', itemtype: 'InvtPart', quantity: -1, isclosed: 'F', soStatus: 'Sales Order : Pending Fulfillment', ...o })

test('⚠️ QUANTITIES ARE ABS\'d — SuiteQL returns them negative for sales orders', () => {
  // Porting the Suitelet's saved-search logic straight across would print a pick ticket
  // of negative numbers.
  const t = bulkPick([line({ quantity: -3 }), line({ tranid: 'SO2', quantity: -2 })], ['P1'])
  assert.equal(t.totalUnits, 5)
  assert.equal(t.skus[0].total, 5)
})

test('⚠️ CLOSED LINES ARE DROPPED, and counted as cancelled rather than discarded', () => {
  // 332 closed goods lines carrying 1,745 units exist across the POs since May. Counting
  // them would put cancelled goods on a pick sheet. But the number is KEPT, because it is
  // what explains a PO that reports zero.
  const t = bulkPick([
    line({ quantity: -4 }),
    line({ tranid: 'SO2', quantity: -6, isclosed: 'T' }),
  ], ['P1'])
  assert.equal(t.totalUnits, 4)
  assert.equal(t.pos[0].cancelledUnits, 6)
  assert.equal(t.pos[0].verdict, 'ok')
})

test('⚠️ A PO WHOSE UNITS ARE ALL CANCELLED REPORTS ZERO AND SAYS WHY', () => {
  // PO 40847685 is the live case: 3 sales orders, all "Sales Order : Closed", 650 units.
  // A blank sheet and "this PO is cancelled" look identical on paper — only one of them
  // tells you that you typed a dead number.
  const t = bulkPick([
    line({ po: 'DEAD', quantity: -650, isclosed: 'T', soStatus: 'Sales Order : Closed' }),
  ], ['DEAD'])
  assert.equal(t.totalUnits, 0)
  assert.deepEqual(t.allClosed.map((p) => [p.po, p.cancelledUnits]), [['DEAD', 650]])
  assert.equal(t.pos[0].verdict, 'allClosed')
  assert.deepEqual(t.pos[0].statuses, ['Sales Order : Closed'])
})

test('⚠️ THREE WAYS OF CONTRIBUTING NOTHING ARE NAMED APART', () => {
  // missing = no sales order carries this PO · allClosed = all cancelled · empty = open
  // orders with no goods lines. Lumping them into one blank row is the never-lump bug.
  const t = bulkPick([
    line({ po: 'CLOSEDPO', quantity: -5, isclosed: 'T' }),
    line({ po: 'FREIGHTONLY', sku: 'SHIP', itemtype: 'ShipItem', quantity: -1 }),
  ], ['CLOSEDPO', 'FREIGHTONLY', 'TYPO'])
  const v = Object.fromEntries(t.pos.map((p) => [p.po, p.verdict]))
  assert.deepEqual(v, { CLOSEDPO: 'allClosed', FREIGHTONLY: 'empty', TYPO: 'missing' })
  assert.deepEqual(t.missing, ['TYPO'])
})

test('freight, tax and discount lines are not goods', () => {
  // The same deny list the order roll-up uses — the fix for the 87% phantom shortage.
  for (const t of ['ShipItem', 'TaxItem', 'Discount', 'Subtotal', 'Markup']) {
    assert.equal(isGoodsLine({ itemtype: t }), false, t)
  }
  const t = bulkPick([
    line({ quantity: -3 }),
    line({ sku: 'FREIGHT', itemtype: 'ShipItem', quantity: -1 }),
    line({ sku: 'TAX', itemtype: 'TaxItem', quantity: -1 }),
  ], ['P1'])
  assert.equal(t.totalUnits, 3)
  assert.equal(t.skuCount, 1)
})

test('⚠️ AN UNKNOWN ITEM TYPE COUNTS AS GOODS — a deny list, not an allow list', () => {
  // The Suitelet filters to InvtPart only, so an Assembly or Kit line would silently
  // VANISH from the pick ticket. An overcount announces itself on the floor; an
  // undercount does not. (Zero such lines exist today — this is insurance.)
  assert.equal(isGoodsLine({ itemtype: 'Assembly' }), true)
  assert.equal(isGoodsLine({ itemtype: 'Kit' }), true)
  const t = bulkPick([line({ sku: 'KIT-1', itemtype: 'Kit', quantity: -9 })], ['P1'])
  assert.equal(t.totalUnits, 9)
})

test('one row per SKU, totalled across every PO, with a column per PO', () => {
  const t = bulkPick([
    line({ po: 'A', sku: 'SN01', quantity: -3 }),
    line({ po: 'B', sku: 'SN01', quantity: -2, tranid: 'SO2' }),
    line({ po: 'B', sku: 'SN02', quantity: -5, tranid: 'SO2' }),
  ], ['A', 'B'])
  assert.deepEqual(t.skus, [
    { sku: 'SN01', total: 5, byPo: { A: 3, B: 2 } },
    { sku: 'SN02', total: 5, byPo: { B: 5 } },
  ])
  assert.deepEqual(t.poColumns, ['A', 'B'])
  assert.equal(t.totalUnits, 10)
})

test('SKUs come back sorted, so the sheet reads the same way twice', () => {
  const t = bulkPick([
    line({ sku: 'SN99', quantity: -1 }), line({ sku: 'SN01', quantity: -1 }),
    line({ sku: 'SN50', quantity: -1 }),
  ], ['P1'])
  assert.deepEqual(t.skus.map((s) => s.sku), ['SN01', 'SN50', 'SN99'])
  assert.deepEqual(pickLines(t), [{ sku: 'SN01', qty: 1 }, { sku: 'SN50', qty: 1 }, { sku: 'SN99', qty: 1 }])
})

test('the store is the last child of the customer hierarchy', () => {
  // How Nordstrom and Bloomingdale's store customers are actually named.
  assert.equal(storeOf('Nordstrom (US) : 0031 Stanford'), '0031 Stanford')
  assert.equal(storeOf("Bloomingdale's : 0002 Boca"), '0002 Boca')
  // A customer with no hierarchy is its own store, not an error.
  assert.equal(storeOf('Rescue Spa New York LLC'), 'Rescue Spa New York LLC')
  assert.equal(storeOf(null), '')
})

test('stores and sales orders are counted per PO', () => {
  // PO 7242978 is 23 sales orders across 23 stores — the multi-store case this exists for.
  const t = bulkPick([
    line({ po: 'A', tranid: 'SO1', customer: 'N : S1', quantity: -1 }),
    line({ po: 'A', tranid: 'SO2', customer: 'N : S2', quantity: -1 }),
    line({ po: 'A', tranid: 'SO2', customer: 'N : S2', sku: 'SN02', quantity: -1 }),
  ], ['A'])
  assert.equal(t.pos[0].salesOrders, 2)
  assert.equal(t.pos[0].stores, 2)
  assert.equal(t.stores, 2)
})

test('pasted PO lists are split on commas, newlines and tabs, and deduped', () => {
  assert.deepEqual(parsePoInput(' 40314306, 40314318 \n40314306 '), ['40314306', '40314318'])
  assert.deepEqual(parsePoInput('A\tB\nC,,D'), ['A', 'B', 'C', 'D'])
  assert.deepEqual(parsePoInput(''), [])
  assert.deepEqual(parsePoInput(null), [])
})

test('⚠️ a PO annotated in NetSuite is NOT silently matched to its clean twin', () => {
  // Someone marks superseded orders by editing otherrefnum: `50106214|CLOSED` exists
  // alongside `50106214`, same three quantities. Nima's call (2026-08-31) was to leave
  // that alone — so asking for one must not quietly pull in the other.
  const t = bulkPick([
    line({ po: '50106214', quantity: -39 }),
    line({ po: '50106214|CLOSED', quantity: -39, isclosed: 'T' }),
  ], ['50106214'])
  assert.equal(t.totalUnits, 39)
  assert.deepEqual(t.pos.map((p) => p.po), ['50106214'])
})

test('matching a PO ignores case and surrounding space', () => {
  const t = bulkPick([line({ po: 'poj00384244', quantity: -4 })], [' POJ00384244 '])
  assert.equal(t.totalUnits, 4)
})

test('⚠️ THE SUITELET\'S STORE RULE IS A NO-OP ON THIS ACCOUNT — this handles the real format', () => {
  // Measured across three real multi-store POs: 0 of 51 distinct customers contain " : ".
  // They all look like "425 Nordstrom - 425 - Valley Fair", so `split(' : ').pop()`
  // returns the whole string. Not wrong — every store is a distinct customer either way —
  // but the code claimed to parse a hierarchy that is not there.
  assert.equal(storeOf('425 Nordstrom - 425 - Valley Fair'), 'Valley Fair')
  assert.equal(storeOf('584 Nordstrom - 584 - West Coast Omni Center'), 'West Coast Omni Center')
  // Still handles the hierarchy form, if the account ever starts using it.
  assert.equal(storeOf('Nordstrom (US) : 0031 Stanford'), '0031 Stanford')
  // ⚠️ An unrecognised format is its OWN STORE, never an error and never blank.
  assert.equal(storeOf('Rescue Spa New York LLC'), 'Rescue Spa New York LLC')
  assert.equal(storeOf('A - B'), 'A - B')
})

test('⚠️ THE HEADLINE COUNTS WHAT IS BEING PICKED, not what was asked about', () => {
  // Caught on live data: a ticket for 684 pickable units headlined "26 sales orders ·
  // 26 stores" — 23 real ones plus the 3 fully-cancelled orders on a dead PO that
  // contribute nothing. The counts-something-other-than-its-label shape, on the number a
  // person reads before walking the floor.
  const t = bulkPick([
    line({ po: 'LIVE', tranid: 'SO1', customer: 'N - 1 - Alpha', quantity: -10 }),
    line({ po: 'LIVE', tranid: 'SO2', customer: 'N - 2 - Beta', quantity: -5 }),
    line({ po: 'DEAD', tranid: 'SO9', customer: 'N - 9 - Gamma', quantity: -650, isclosed: 'T' }),
  ], ['LIVE', 'DEAD'])
  assert.equal(t.totalUnits, 15)
  assert.equal(t.salesOrders, 2, 'the cancelled order does not inflate the pick')
  assert.equal(t.stores, 2, 'nor its store')
  // But the dead PO is still fully accounted for in its own row.
  const dead = t.pos.find((p) => p.po === 'DEAD')
  assert.equal(dead.salesOrders, 1)
  assert.equal(dead.cancelledUnits, 650)
})
