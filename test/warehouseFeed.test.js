// test/warehouseFeed.test.js — the open-PO-lines push to the Naghedi-Warehouse
// Supabase (src/ingest/warehouseFeed.js). Everything runs on injected fetches;
// nothing here touches NetSuite or Supabase.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  warehouseSupabaseCreds, warehouseFeedConfigured, warehousePoLineSql,
  mapWarehousePoLines, pushWarehousePoLines, WAREHOUSE_PO_STATUS_CODES,
} from '../src/ingest/warehouseFeed.js'

const ENV = {
  NS_ACCOUNT_ID: '1234567-sb1',
  NS_CONSUMER_KEY: 'ck',
  NS_CONSUMER_SECRET: 'cs',
  NS_TOKEN_ID: 'tk',
  NS_TOKEN_SECRET: 'ts',
  WAREHOUSE_SUPABASE_URL: 'https://wh.supabase.co/',
  WAREHOUSE_SUPABASE_KEY: 'anon-key',
}

// A realistic pull: PO 100 has a fee line at raw seq 1 (the live "dye webbing"
// shape — no item join, no itemtype) and a duplicate SKU on two lines; PO 200
// ends with the auto-added TaxItem line (the live PO1760 shape).
const NS_ROWS = [
  { po_id: '100', po_number: 'PO1410', vendor: 'Vendor A', status: 'Purchase Order : Partially Received', duedate: '2026-08-15', header_memo: 'FALL BUY', final_destination: 'Warehouse Bulk : Shopbop', po_location: 'Shopbop', line_seq: '1', itemtype: null, isclosed: 'F', item_id: null, sku: null, line_memo: 'dye webbing', qty_ordered: '1', qty_received: '0', rate: '56.74' },
  { po_id: '100', po_number: 'PO1410', vendor: 'Vendor A', status: 'Purchase Order : Partially Received', duedate: '2026-08-15', header_memo: 'FALL BUY', final_destination: 'Warehouse Bulk : Shopbop', po_location: 'Shopbop', line_seq: '2', itemtype: 'InvtPart', isclosed: 'F', item_id: '6284', sku: 'SN04023LD-CASHMERE', line_memo: 'Nomad Medium Hobo', qty_ordered: '90', qty_received: '76', rate: '52' },
  { po_id: '100', po_number: 'PO1410', vendor: 'Vendor A', status: 'Purchase Order : Partially Received', duedate: '2026-08-15', header_memo: 'FALL BUY', final_destination: 'Warehouse Bulk : Shopbop', po_location: 'Shopbop', line_seq: '3', itemtype: 'InvtPart', isclosed: 'T', item_id: '6284', sku: 'SN04023LD-CASHMERE', line_memo: 'Nomad Medium Hobo', qty_ordered: '10', qty_received: '10', rate: '52' },
  { po_id: '200', po_number: 'PO1760', vendor: 'Vendor B', status: 'Purchase Order : Pending Receipt', duedate: null, header_memo: null, final_destination: null, po_location: 'Warehouse Bulk : Retail', line_seq: '1', itemtype: 'InvtPart', isclosed: 'F', item_id: '7001', sku: 'SN02264NB-TEAK', line_memo: 'Isola Large Bag', qty_ordered: '18', qty_received: '0', rate: '61' },
  { po_id: '200', po_number: 'PO1760', vendor: 'Vendor B', status: 'Purchase Order : Pending Receipt', duedate: null, header_memo: null, final_destination: null, po_location: 'Warehouse Bulk : Retail', line_seq: '2', itemtype: 'TaxItem', isclosed: 'F', item_id: '9', sku: null, line_memo: 'CA_ZR', qty_ordered: '1', qty_received: '0', rate: '0' },
]

test('warehouseSupabaseCreds: canonical names win, VITE_ pair is the fallback, either half missing = null', () => {
  assert.deepEqual(warehouseSupabaseCreds(ENV), { url: 'https://wh.supabase.co', key: 'anon-key' })
  const vite = { VITE_SUPABASE_URL: 'https://v.supabase.co', VITE_SUPABASE_ANON_KEY: 'vk' }
  assert.deepEqual(warehouseSupabaseCreds(vite), { url: 'https://v.supabase.co', key: 'vk' })
  assert.equal(warehouseSupabaseCreds({ WAREHOUSE_SUPABASE_URL: 'https://x' }), null)
  assert.equal(warehouseFeedConfigured({}), false)
})

test('warehousePoLineSql: receiving scope is B+D only — Pending Bill (fully received) stays out', () => {
  assert.deepEqual(WAREHOUSE_PO_STATUS_CODES, ['B', 'D'])
  const sql = warehousePoLineSql()
  assert.match(sql, /t\.status IN \('B','D'\)/)
  assert.match(sql, /custbody_acs_final_destination/)
  assert.match(sql, /quantityshiprecv/)
  // fullname, never the leaf — the leaf silently mismatches NetSuite imports
  assert.match(sql, /fd\.fullname/)
  assert.match(sql, /COALESCE\(lloc\.fullname, hloc\.fullname\)/)
})

test('mapWarehousePoLines: item_line_position counts item lines only; fee and tax lines shift line_seq but not position', () => {
  const { rows, skippedNonItem, poCount } = mapWarehousePoLines(NS_ROWS)
  assert.equal(poCount, 2)
  assert.equal(skippedNonItem, 2) // the fee line and the tax line
  assert.equal(rows.length, 3)

  // PO 100: fee at raw seq 1 → first item line is seq 2 / position 1
  const [a, b] = rows.filter((r) => r.po_id === '100')
  assert.equal(a.line_seq, 2)
  assert.equal(a.item_line_position, 1)
  assert.equal(b.line_seq, 3)
  assert.equal(b.item_line_position, 2)

  // duplicate SKU stays two rows — never collapsed
  assert.equal(a.sku, b.sku)

  // per-line facts survive: closed flag, received qty, numbers as numbers
  assert.equal(a.line_closed, false)
  assert.equal(b.line_closed, true)
  assert.equal(a.qty_ordered, 90)
  assert.equal(a.qty_received, 76)
  assert.equal(a.unit_rate, 52)

  // status prefix stripped to the bare CSV-shaped value
  assert.equal(a.status, 'Partially Received')

  // PO 200: trailing tax line excluded, item keeps position 1; blank final
  // destination stays null — never guessed
  const [c] = rows.filter((r) => r.po_id === '200')
  assert.equal(c.item_line_position, 1)
  assert.equal(c.final_destination, null)
  assert.equal(c.po_location, 'Warehouse Bulk : Retail')
})

test('mapWarehousePoLines: numbers positions in line_seq order even when rows arrive shuffled', () => {
  const shuffled = [NS_ROWS[2], NS_ROWS[4], NS_ROWS[0], NS_ROWS[3], NS_ROWS[1]]
  const { rows } = mapWarehousePoLines(shuffled)
  const po100 = rows.filter((r) => r.po_id === '100')
  assert.deepEqual(po100.map((r) => [r.line_seq, r.item_line_position]), [[2, 1], [3, 2]])
})

function nsFetchReturning(items, { truncated = false } = {}) {
  return async () => ({ ok: true, status: 200, json: async () => ({ items, hasMore: truncated }), text: async () => '' })
}

test('pushWarehousePoLines: upserts stamped rows, then sweeps only older stamps', async () => {
  const calls = []
  const _fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '', headers: { get: (h) => (h === 'content-range' ? '0-11/12' : null) } }
  }
  const now = () => new Date('2026-08-03T20:00:00Z')
  const r = await pushWarehousePoLines({ env: ENV, _nsFetch: nsFetchReturning(NS_ROWS), _fetch, now })

  assert.equal(r.ok, true)
  assert.equal(r.pushed, 3)
  assert.equal(r.poCount, 2)
  assert.equal(r.skippedNonItem, 2)
  assert.equal(r.swept, 12)

  // one upsert batch + one sweep, in that order — never delete-first
  assert.equal(calls.length, 2)
  const [upsert, sweep] = calls
  assert.equal(upsert.method, 'POST')
  assert.match(upsert.url, /\/rest\/v1\/ns_open_po_lines\?on_conflict=po_id,line_seq$/)
  assert.match(upsert.headers.Prefer, /merge-duplicates/)
  assert.equal(upsert.headers.apikey, 'anon-key')
  assert.ok(upsert.body.every((row) => row.synced_at === '2026-08-03T20:00:00.000Z'))
  assert.equal(sweep.method, 'DELETE')
  assert.match(sweep.url, /synced_at=lt\.2026-08-03T20%3A00%3A00\.000Z$/)
})

test('pushWarehousePoLines: a truncated NetSuite pull never writes anything', async () => {
  let supabaseCalls = 0
  const _fetch = async () => { supabaseCalls++; return { ok: true, status: 200, text: async () => '' } }
  const r = await pushWarehousePoLines({ env: ENV, _nsFetch: nsFetchReturning(NS_ROWS, { truncated: true }), _fetch })
  assert.equal(r.ok, false)
  assert.match(r.error, /INCOMPLETE/)
  assert.equal(supabaseCalls, 0)
})

test('pushWarehousePoLines: an empty pull refuses to replace the mirror', async () => {
  let supabaseCalls = 0
  const _fetch = async () => { supabaseCalls++; return { ok: true, status: 200, text: async () => '' } }
  const r = await pushWarehousePoLines({ env: ENV, _nsFetch: nsFetchReturning([]), _fetch })
  assert.equal(r.ok, false)
  assert.match(r.error, /refusing to replace/)
  assert.equal(supabaseCalls, 0)
})

test('pushWarehousePoLines: a failed upsert batch aborts BEFORE the sweep — stale rows survive, table never empties', async () => {
  const calls = []
  const _fetch = async (url, init) => {
    calls.push(init.method)
    return { ok: false, status: 500, text: async () => 'boom' }
  }
  const r = await pushWarehousePoLines({ env: ENV, _nsFetch: nsFetchReturning(NS_ROWS), _fetch })
  assert.equal(r.ok, false)
  assert.match(r.error, /upsert batch 0: 500/)
  assert.deepEqual(calls, ['POST']) // no DELETE ever issued
})

test('pushWarehousePoLines: unconfigured (either side) is a silent skip, not an error', async () => {
  const noSupabase = { ...ENV, WAREHOUSE_SUPABASE_URL: '', WAREHOUSE_SUPABASE_KEY: '' }
  assert.deepEqual(await pushWarehousePoLines({ env: noSupabase }), { ok: false, configured: false })
  const noNetsuite = { WAREHOUSE_SUPABASE_URL: 'https://wh.supabase.co', WAREHOUSE_SUPABASE_KEY: 'k' }
  assert.deepEqual(await pushWarehousePoLines({ env: noNetsuite }), { ok: false, configured: false })
})
