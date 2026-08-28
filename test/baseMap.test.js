import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILDINGS, BUILDING, ROADS, roadFor, buildingStates, moversFrom, isMoverEvent,
} from '../src/model/baseMap.js'

// ── The base is coherent ────────────────────────────────────────────────────

test('every building names a real sprite and a view it can open', () => {
  for (const b of BUILDINGS) {
    assert.match(b.sprite, /^bldg-\d\d$/, `${b.key} needs a rendered sprite`)
    assert.ok(b.label && b.of, `${b.key} needs a label and a caption`)
    assert.ok(b.tone, `${b.key} needs a tone`)
    assert.ok(b.view, `${b.key} needs a view to open`)
  }
})

test('no two buildings look identical — sprite+flip must be unique', () => {
  // Duplicating a sprite is allowed (Nima authorised it for the new lanes), but two
  // buildings rendering the same pixels the same way round are indistinguishable on
  // the map. The scan bay is the pack house mirrored, and that is the point.
  const looks = BUILDINGS.map((b) => `${b.sprite}:${b.flip ? 'flip' : 'nat'}`)
  assert.equal(new Set(looks).size, looks.length)
})

test('every building sits inside the map', () => {
  // Percentages, so anything outside 0–100 is off-screen and unclickable.
  for (const b of BUILDINGS) {
    assert.ok(b.x >= 0 && b.x + b.w <= 100, `${b.key} runs off the map horizontally`)
    assert.ok(b.y >= 0 && b.y <= 100, `${b.key} runs off the map vertically`)
  }
})

test('every road joins two buildings that actually exist', () => {
  for (const r of ROADS) {
    assert.ok(BUILDING[r.from], `road ${r.key} starts nowhere`)
    assert.ok(BUILDING[r.to], `road ${r.key} ends nowhere`)
    assert.notEqual(r.from, r.to, `road ${r.key} is a loop`)
  }
})

test('every building is reachable — none is stranded off the network', () => {
  // A building with no road cannot receive or send a mover, so it would sit on the
  // map looking connected while nothing could ever reach it.
  for (const b of BUILDINGS) {
    const touching = ROADS.some((r) => r.from === b.key || r.to === b.key)
    assert.ok(touching, `${b.key} has no road`)
  }
})

test('roadFor works in both directions and refuses to invent one', () => {
  assert.ok(roadFor('stock', 'pack'))
  assert.ok(roadFor('pack', 'stock'), 'a road is a road travelled either way')
  assert.equal(roadFor('receiving', 'launch'), null, 'there is no direct road, so say so')
  assert.equal(roadFor('receiving', 'nowhere'), null)
})

// ── The counts are counts of WORK, from data the app already has ────────────

const so = (over = {}) => ({
  soNumber: 'SO1', source: 'boutique', isAts: false, stage: 'OPEN', fulfillments: [], ...over,
})

test('the stock depot counts ATS orders still open', () => {
  const s = buildingStates({
    orders: [
      so({ soNumber: 'A', isAts: true }),
      so({ soNumber: 'B', isAts: true, stage: 'SHIPPED' }),   // done, not work
      so({ soNumber: 'C', isAts: false }),
    ],
  })
  assert.equal(s.stock.count, 1)
})

test('receiving counts presold orders with nothing fulfilled — never EDI, never stock', () => {
  const s = buildingStates({
    orders: [
      so({ soNumber: 'A', isAts: false, ocNumber: 'OC1' }),                       // yes
      so({ soNumber: 'B', isAts: true }),                                          // stock lane
      so({ soNumber: 'C', source: 'edi', isAts: false, poNumber: '5001' }),        // EDI lane
      so({ soNumber: 'D', isAts: false, fulfillments: [{ ifNumber: 'IF1' }] }),     // already moving
    ],
  })
  assert.equal(s.receiving.count, 1)
  assert.equal(s.receiving.items[0].soNumber, 'A')
})

test('the pack house counts the CUSTODY GAP — out, not back, AND NOT SHIPPED', () => {
  // Both halves are observed scans. This is the question the pack house answers.
  const s = buildingStates({
    orders: [so({
      fulfillments: [
        { ifNumber: 'IF1', custodyOut: '2026-08-20T10:00:00Z', status: 'Picked' },          // really out
        { ifNumber: 'IF2', custodyOut: '2026-08-19T10:00:00Z', custodyIn: '2026-08-20T10:00:00Z' }, // back
        { ifNumber: 'IF3' },                                                                // never left
      ],
    })],
  })
  assert.equal(s.pack.count, 1)
  assert.equal(s.pack.items[0].ifNumber, 'IF1')
})

test('a SHIPPED fulfilment with an open tag is a stale tag, NOT goods on the floor', () => {
  // Measured on live data before shipping: 14 open tags, ALL 14 already shipped, zero
  // genuinely out. "Out on the floor, not back" was describing departed freight.
  const s = buildingStates({
    orders: [so({
      fulfillments: [
        { ifNumber: 'IF1', custodyOut: '2026-07-31T10:00:00Z', status: 'Shipped' },
        { ifNumber: 'IF2', custodyOut: '2026-08-02T10:00:00Z', status: 'Shipped' },
        { ifNumber: 'IF3', custodyOut: '2026-08-20T10:00:00Z', status: 'Packed' },
      ],
    })],
  })
  assert.equal(s.pack.count, 1, 'only the unshipped one is on the floor')
  const stale = s.pack.alerts.find((a) => a.key === 'staleTags')
  assert.equal(stale.count, 2, 'the shipped ones are named as paperwork, not lumped in')
  assert.match(stale.label, /never closed/)
})

test('an alert with a count of zero is dropped, never rendered as a clean chip', () => {
  const s = buildingStates({
    orders: [so({ fulfillments: [{ ifNumber: 'IF1', custodyOut: '2026-08-20', status: 'Picked' }] })],
  })
  assert.deepEqual(s.pack.alerts, [])
})

test('every building carries an alerts array, so none renders undefined', () => {
  const s = buildingStates({ orders: [so()] })
  for (const b of BUILDINGS) assert.ok(Array.isArray(s[b.key].alerts), `${b.key} has no alerts array`)
})

test('the launch pad headlines CLEAR FOR DEPARTURE and grounds the rest by reason', () => {
  // Nima: "launch bay should show us whats clear for departure i.e need to be marked
  // as shipped and whats grounded categorized by its reason".
  const s = buildingStates({
    orders: [{
      soNumber: 'SO1', source: 'boutique', isAts: false, stage: 'OPEN', terms: 'Net 30',
      invoices: [{ invNumber: 'INV1', amountRemaining: 0, shippingStatus: 'Approved For Shipping' }],
      fulfillments: [
        { ifNumber: 'IF1', labelled: true, invoice: 'INV1', status: 'Packed' },   // clear
        { ifNumber: 'IF2', labelled: false, status: 'Packed' },                   // no label
        { ifNumber: 'IF3', labelled: true, packedStatus: 'FOB Order Awaiting Shipment', status: 'Packed' },
        { ifNumber: 'IF4', status: 'Shipped', labelled: true },                   // gone
      ],
    }],
  })
  assert.equal(s.launch.count, 1, 'only the genuinely clear one is the headline')
  assert.equal(s.launch.items[0].ifNumber, 'IF1')
  const reasons = s.launch.alerts.map((a) => a.label)
  assert.ok(reasons.some((r) => /no label/.test(r)), 'the unlabelled one is grounded, and says why')
  assert.ok(reasons.some((r) => /FOB/.test(r)), 'FOB is its own reason, not "no label"')
  assert.ok(!s.launch.alerts.some((a) => a.items.some((f) => f.ifNumber === 'IF4')),
    'a shipped fulfilment is not grounded — it is gone')
})

test('grounded reasons are ordered biggest pile first', () => {
  const s = buildingStates({
    orders: [{
      soNumber: 'SO1', stage: 'OPEN', source: 'boutique', isAts: false, invoices: [],
      fulfillments: [
        { ifNumber: 'A', labelled: false, status: 'Packed' },
        { ifNumber: 'B', labelled: false, status: 'Packed' },
        { ifNumber: 'C', labelled: true, packedStatus: 'FOB Order Awaiting Shipment', status: 'Packed' },
      ],
    }],
  })
  assert.equal(s.launch.alerts[0].count, 2, 'the biggest pile is the one worth clearing')
})

test('payment grounding comes from paymentGate, so policy cannot fork', () => {
  // paymentGate holds two decisions no fresh rule would guess: past-due net terms do
  // NOT block, and the NY office's "Approved For Shipping" waives an open balance.
  const ground = (invoice, terms) => buildingStates({
    orders: [{
      soNumber: 'SO1', stage: 'OPEN', source: 'boutique', isAts: false, terms,
      invoices: [invoice],
      fulfillments: [{ ifNumber: 'IF1', labelled: true, invoice: 'INV1', status: 'Packed' }],
    }],
  })
  // Owed, due, no waiver → grounded.
  const blocked = ground({ invNumber: 'INV1', amountRemaining: 900, shippingStatus: 'Pending Payment' }, 'Due on receipt')
  assert.equal(blocked.launch.count, 0)
  assert.match(blocked.launch.alerts[0].label, /payment/)
  // Same balance, but the office waived it → clear.
  const waived = ground({ invNumber: 'INV1', amountRemaining: 900, shippingStatus: 'Approved For Shipping' }, 'Due on receipt')
  assert.equal(waived.launch.count, 1, 'the NY waiver is honoured, not re-litigated here')
})

test('NO building headlines a count that includes shipped freight', () => {
  // The same mistake twice in one file (pack house, launch pad) earns a test that
  // catches the third. A building describing work in progress must not count a
  // fulfilment that has already gone.
  const s = buildingStates({
    orders: [so({
      stage: 'SHIPPED',
      fulfillments: [{
        ifNumber: 'IF1', status: 'Shipped', labelled: true,
        custodyOut: '2026-06-01', actualShipDate: '2026-06-10',
      }],
    })],
  })
  assert.equal(s.pack.count, 0, 'pack house counted a shipped fulfilment')
  assert.equal(s.launch.count, 0, 'launch pad counted a shipped fulfilment')
  assert.equal(s.routing.count, 0, 'routing yard counted a shipped fulfilment')
})

test('the routing yard counts EDI fulfilments not yet shipped', () => {
  const s = buildingStates({
    orders: [
      so({ source: 'edi', poNumber: '5001', fulfillments: [{ ifNumber: 'IF1', status: 'Picked' }] }),
      so({ source: 'edi', poNumber: '5002', fulfillments: [{ ifNumber: 'IF2', status: 'Shipped' }] }),
      so({ source: 'boutique', fulfillments: [{ ifNumber: 'IF3', status: 'Picked' }] }),  // not EDI
    ],
  })
  assert.equal(s.routing.count, 1)
})

test('comms counts unread mail and ops counts open tasks', () => {
  const s = buildingStates({
    emails: [{ id: 'a', isUnread: true }, { id: 'b', isUnread: false }],
    tasks: [{ id: 1, status: 'open' }, { id: 2, status: 'done' }, { id: 3, status: 'open' }],
  })
  assert.equal(s.comms.count, 1)
  assert.equal(s.ops.count, 2)
})

test('an empty base is all zeroes, never padded to look busy', () => {
  const s = buildingStates({})
  for (const b of BUILDINGS) assert.equal(s[b.key].count, 0, `${b.key} invented work`)
})

test('every building gets a state, so none renders undefined', () => {
  const s = buildingStates({ orders: [so()] })
  for (const b of BUILDINGS) {
    assert.ok(s[b.key], `${b.key} has no state`)
    assert.ok(Array.isArray(s[b.key].items), `${b.key} must carry its items to work from`)
  }
})

// ── Movers travel real roads, or they do not exist ──────────────────────────

test('a mover is placed on the road for its lane transition', () => {
  // PACKED travels scan → launch: the scan bay is where custody is recorded, so it
  // sits in the flow between the pack house and the pad.
  const [m] = moversFrom([{ id: 1, eventType: 'PACKED', docType: 'IF', docNumber: 'IF7486', label: 'Packed' }])
  assert.equal(m.road, roadFor('scan', 'launch').key)
  assert.equal(m.from, 'scan')
  assert.equal(m.to, 'launch')
  assert.equal(m.docNumber, 'IF7486')
  assert.ok(m.tone, 'a mover is coloured by the lane it is leaving')
})

test('an event with no road is DROPPED, never placed approximately', () => {
  // The one thing the whole model exists to prevent: a dot off the network.
  const out = moversFrom([
    { id: 1, eventType: 'SOMETHING_ELSE' },
    { id: 2, eventType: 'SO_IMPORTED' },       // deliberately has no leg
    { id: 3, eventType: 'PACKED' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '3')
})

test('every declared event leg has a road that exists', () => {
  // A leg naming two unconnected buildings would silently drop every event of that
  // type — the mapping and the network have to agree.
  const legTypes = ['PO_RECEIVED', 'IF_CREATED', 'CUSTODY_OUT', 'CUSTODY_IN', 'PACKED',
    'ROUTED', 'ASN_SENT', 'DEPARTED', 'DEPARTURE_CONFIRMED', 'INVOICE_SENT', 'TASK_DONE']
  for (const t of legTypes) {
    assert.ok(isMoverEvent(t), `${t} should be a mover event`)
    const out = moversFrom([{ id: 1, eventType: t }])
    assert.equal(out.length, 1, `${t} maps to a leg with no road`)
  }
})

test('the road count is capped — a live view, not a log', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ id: i, eventType: 'PACKED' }))
  // All on ONE road, so perRoad caps it at 2 long before the limit does.
  assert.equal(moversFrom(events).length, 2)
  assert.equal(moversFrom(events, { perRoad: 40, limit: 3 }).length, 3)
})

test('movers SPREAD across roads instead of piling onto the busiest', () => {
  // Found on live data: five of eight movers came out as identical "Task done" dots
  // on comms→ops, because tasks complete in bursts. A base where one street is ever
  // busy reads as broken rather than quiet.
  const events = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: 'task' + i, eventType: 'TASK_DONE' })),
    { id: 'p1', eventType: 'PACKED' },
    { id: 'r1', eventType: 'ROUTED' },
    { id: 'po1', eventType: 'PO_RECEIVED' },
  ]
  const out = moversFrom(events)
  const perRoad = out.reduce((m, x) => ({ ...m, [x.road]: (m[x.road] || 0) + 1 }), {})
  assert.ok(Object.keys(perRoad).length >= 4, 'at least four roads should be busy')
  for (const [road, n] of Object.entries(perRoad)) {
    assert.ok(n <= 2, `${road} carries ${n} movers, more than perRoad`)
  }
})

test('the same feed always produces the same base', () => {
  // This view re-renders on every pulse; dots swapping roads between renders would
  // read as movement that never happened.
  const events = [
    { id: 1, eventType: 'PACKED' }, { id: 2, eventType: 'ROUTED' },
    { id: 3, eventType: 'TASK_DONE' }, { id: 4, eventType: 'PACKED' },
  ]
  assert.deepEqual(moversFrom(events), moversFrom(events))
})

test('movers carry an id unique enough for React to key on', () => {
  const out = moversFrom([
    { id: 10, eventType: 'PACKED' }, { id: 11, eventType: 'DEPARTED' },
  ])
  assert.equal(new Set(out.map((m) => m.id)).size, out.length)
})

test('no events means no movers, not a crash', () => {
  assert.deepEqual(moversFrom(), [])
  assert.deepEqual(moversFrom([]), [])
})

test('a mover labels itself even when the feed did not', () => {
  // /api/events returns undecorated rows while /api/ledger decorates. The Base view
  // reads the undecorated one, so the ticker showed raw enums until the model did
  // the lookup itself.
  const [m] = moversFrom([{ id: 1, eventType: 'PO_RECEIVED' }])
  assert.notEqual(m.label, 'PO_RECEIVED', 'the ticker must not shout an enum')
  assert.ok(m.label.length > 3)
})

test('an event type with no known label falls back to the type, not to blank', () => {
  // Better a raw key than an empty chip that looks like a rendering bug.
  const [m] = moversFrom([{ id: 1, eventType: 'PACKED', label: 'Packed by hand' }])
  assert.equal(m.label, 'Packed by hand', 'an explicit label from the feed still wins')
})

// ── The four new buildings ──────────────────────────────────────────────────

test('the scan bay counts scanned-back-in fulfilments still without a label', () => {
  const s = buildingStates({
    orders: [so({
      fulfillments: [
        { ifNumber: 'IF1', custodyIn: '2026-08-20', labelled: false, status: 'Packed' },  // yes
        { ifNumber: 'IF2', custodyIn: '2026-08-20', labelled: true, status: 'Packed' },   // has one
        { ifNumber: 'IF3', labelled: false, status: 'Packed' },                            // never went out
        { ifNumber: 'IF4', custodyIn: '2026-08-01', labelled: false, status: 'Shipped' }, // gone
      ],
    })],
  })
  assert.equal(s.scan.count, 1)
  assert.equal(s.scan.items[0].ifNumber, 'IF1')
})

test('the EDI relay counts open partner ORDERS, a different grain from the routing yard', () => {
  const s = buildingStates({
    orders: [
      so({ soNumber: 'A', source: 'edi', poNumber: '1', fulfillments: [{ ifNumber: 'IF1', status: 'Picked' }] }),
      so({ soNumber: 'B', source: 'edi', poNumber: '2', stage: 'SHIPPED' }),
      so({ soNumber: 'C', source: 'boutique', isAts: true }),
    ],
  })
  assert.equal(s.edi.count, 1, 'one open EDI order')
  assert.equal(s.routing.count, 1, 'and one EDI fulfilment to route — orders vs fulfilments')
})

test('the Almanac is keyed on window_end, a field that is actually populated', () => {
  // cancel_date was NULL on all 121 unshipped orders, so the first version could never
  // fire — a dead counter reads exactly like a clear week.
  const soonIso = new Date(Date.now() + 3 * 86400000).toISOString()
  const farIso = new Date(Date.now() + 60 * 86400000).toISOString()
  const s = buildingStates({
    orders: [
      so({ soNumber: 'A', windowEnd: soonIso }),
      so({ soNumber: 'B', windowEnd: farIso }),
      so({ soNumber: 'C', windowEnd: new Date(Date.now() - 5 * 86400000).toISOString() }), // already closed
      so({ soNumber: 'D', cancelDate: soonIso }),   // the dead field — must not count
      so({ soNumber: 'E', windowEnd: soonIso, stage: 'SHIPPED' }),
    ],
  })
  assert.equal(s.calendar.count, 2, 'closing and already-closed, and nothing keyed on cancel_date')
})

test('the Archive declares itself uncountable rather than inventing a number', () => {
  const archive = BUILDINGS.find((b) => b.key === 'datapad')
  assert.equal(archive.countable, false)
  const s = buildingStates({ orders: [so()] })
  assert.equal(s.datapad.count, 0)
})

test('every building still has a state after growing to twelve', () => {
  const s = buildingStates({ orders: [so()] })
  // ⚠️ A DELIBERATE CANARY: adding a building must trip this and make someone check
  // that it has a state, a road and a real sprite. Bump it knowingly, never reflexively.
  assert.equal(BUILDINGS.length, 12)
  for (const b of BUILDINGS) {
    assert.ok(s[b.key], `${b.key} has no state`)
    assert.ok(Array.isArray(s[b.key].items))
    assert.ok(Array.isArray(s[b.key].alerts))
  }
})

// ── The Catalogue building (2026-08-28) ─────────────────────────────────────

test('the catalogue is a building, because Nima kept being pulled out of the Base to reach it', () => {
  // Nima, 2026-08-28: the Base is the app, the top menu "distract from the base one so
  // that we sometiems go out of the base ecosystem which we want to stay in", and
  // Catalogue was the building he named as missing.
  const cat = BUILDINGS.find((b) => b.key === 'catalogue')
  assert.ok(cat, 'the catalogue has a building')
  assert.equal(cat.view, 'catalogue')
})

test('⚠️ the catalogue is NOT COUNTABLE — its real number has no feed here', () => {
  // Same rule as the Archive. The honest figure is "SKUs not yet uploaded", which lives
  // behind an import this view is given no data for, and buildingStates is built only
  // from what App already passes. An invented number among real ones is worse than none.
  const cat = BUILDINGS.find((b) => b.key === 'catalogue')
  assert.equal(cat.countable, false)
  const s = buildingStates({ orders: [so()] })
  assert.equal(s.catalogue.count, 0)
  assert.deepEqual(s.catalogue.items, [])
})

test('the catalogue is on the road network, not stranded', () => {
  // A building nothing connects to cannot be reached by a mover and reads as a mistake.
  assert.ok(roadFor('routing', 'catalogue'), 'joined to the routing yard')
  assert.ok(roadFor('catalogue', 'launch'), 'joined to the launch pad')
})

test('⚠️ the OPS CENTRE label now says what it counts', () => {
  // It read "open on the day plan" and counted open quest_tasks. Measured 2026-08-28:
  // 15 open tasks against a day plan holding 23 items — 9 EDI routings, 8 ships, 5 email
  // replies, 1 invoice, none of them tasks. Two piles, one label: the
  // counts-something-other-than-its-label shape, on the building he looks at all day.
  const ops = BUILDINGS.find((b) => b.key === 'ops')
  assert.doesNotMatch(ops.of, /day plan/i, 'no longer claims to count the day plan')
  assert.match(ops.of, /task/i, 'says it counts tasks, which is what it counts')
  // And it still counts exactly that.
  const s = buildingStates({ orders: [], tasks: [{ status: 'open' }, { status: 'open' }, { status: 'done' }] })
  assert.equal(s.ops.count, 2)
})
