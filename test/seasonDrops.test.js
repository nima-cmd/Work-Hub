// test/seasonDrops.test.js — the drop dates, from the real marketing calendar.
//
// ⚠️ EVERY FIXTURE IS A REAL EVENT TITLE, read from the calendar 2026-09-16. Two of them
// are the reason this file has tests at all: a typo in a load-bearing title, and a
// duplicate entry for one drop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDrop, productLaunch, dropsFrom, dropFor, dropRisk, suggestReason } from '../src/model/seasonDrops.js'

const ev = (title, start) => ({ title, start })

// The real calendar, verbatim.
const CALENDAR = [
  ev('Curated Shop Launch', '2026-01-21'),
  ev('Spring Drop 1 Launch', '2026-02-04'),
  ev('Spring Drop 2 Launch', '2026-03-03'),
  ev('Como Med Launch', '2026-04-25'),
  ev('Atlas & Small Caravan Launch', '2026-04-28'),
  ev('Summer Drop 1 Launch', '2026-05-05'),
  ev('Summer Drop 1', '2026-05-05'),
  ev('Cartolina Launch', '2026-05-14'),
  ev('Summer Drop 2 Launch', '2026-06-02'),
  ev('Charm Launch', '2026-06-16'),
  ev('Net Bag Preorder Launch', '2026-07-14'),
  ev('Fall Drop 1 Launch', '2026-08-18'),
  ev('Fall Drop 2 Launch', '2026-09-08'),
  ev('Hoilday Launch', '2026-10-13'),
  ev('Gift Guide Launch', '2026-11-05'),
  ev('Resort Launch', '2026-11-10'),
]

test('⚠️ "Hoilday Launch" — the live typo must still resolve to Holiday', () => {
  // Holiday has 366 items and the nearest launch. A parser keyed on correct spelling
  // drops the most important season entirely.
  const d = parseDrop(ev('Hoilday Launch', '2026-10-13'))
  assert.equal(d.season, 'Holiday')
  assert.equal(d.on, '2026-10-13')
  assert.equal(d.single, true)
  // The raw title is kept — the fix belongs in the calendar, not hidden here.
  assert.equal(d.title, 'Hoilday Launch')
})

test('⚠️ two drops for Spring/Summer/Fall, ONE launch for Holiday and Resort', () => {
  const drops = dropsFrom(CALENDAR)
  const bySeason = {}
  for (const d of drops) (bySeason[d.season] ||= []).push(d.drop)
  assert.deepEqual(bySeason.Spring, [1, 2])
  assert.deepEqual(bySeason.Summer, [1, 2])
  assert.deepEqual(bySeason.Fall, [1, 2])
  // ⚠️ NOT TWO. A model that hard-coded "every season has two" would invent a Holiday
  // Drop 2 with no date and no merchandise.
  assert.deepEqual(bySeason.Holiday, [1])
  assert.deepEqual(bySeason.Resort, [1])
})

test('⚠️ a duplicate entry for one drop is ONE drop', () => {
  // The calendar carries both "Summer Drop 1 Launch" and "Summer Drop 1" on 2026-05-05.
  const drops = dropsFrom(CALENDAR)
  const summer1 = drops.filter((d) => d.season === 'Summer' && d.drop === 1)
  assert.equal(summer1.length, 1, 'counting both would report four Summer drops')
  assert.equal(summer1[0].on, '2026-05-05')
})

test('a duplicate on a LATER date does not move the deadline outward', () => {
  const drops = dropsFrom([
    ev('Fall Drop 1 Launch', '2026-08-18'),
    ev('Fall Drop 1', '2026-08-25'),
  ])
  assert.equal(drops.length, 1)
  assert.equal(drops[0].on, '2026-08-18', 'earliest wins — a drop goes live once')
})

test('⚠️ product launches are NOT drops', () => {
  // Six of them in 2026. Folding them in gives Summer four drops.
  for (const t of ['Como Med Launch', 'Atlas & Small Caravan Launch', 'Cartolina Launch',
    'Charm Launch', 'Net Bag Preorder Launch', 'Curated Shop Launch', 'Gift Guide Launch']) {
    assert.equal(parseDrop(ev(t, '2026-05-01')), null, t)
  }
  assert.equal(dropsFrom(CALENDAR).length, 8, '2+2+2+1+1')
  // But they are KEPT, not discarded.
  const p = productLaunch(ev('Charm Launch', '2026-06-16'))
  assert.equal(p.kind, 'product')
  assert.equal(p.name, 'Charm')
  // And a drop is not also a product launch.
  assert.equal(productLaunch(ev('Fall Drop 1 Launch', '2026-08-18')), null)
})

test('a non-event and a titleless event produce nothing', () => {
  assert.equal(parseDrop({}), null)
  assert.equal(parseDrop(ev('Fall Drop 1 Launch', '')), null)
  assert.equal(parseDrop(ev('', '2026-08-18')), null)
  assert.equal(parseDrop(ev('The Line Core Shoot', '2026-04-06')), null)
})

test('dropFor resolves a season label to its date, and says when it assumed', () => {
  const drops = dropsFrom(CALENDAR)
  const explicit = dropFor('Fall 2026', 2, drops)
  assert.equal(explicit.on, '2026-09-08')
  assert.equal(explicit.assumed, false)

  // ⚠️ NO DROP NUMBER → the FIRST, flagged as assumed. Drop 1 is the earlier deadline
  // so it is the safe side, but reporting a PO late against a date nobody chose is
  // worse than reporting nothing.
  const guessed = dropFor('Fall 2026', null, drops)
  assert.equal(guessed.on, '2026-08-18')
  assert.equal(guessed.assumed, true)

  // Holiday has one launch, so there is nothing to assume between.
  assert.equal(dropFor('Holiday 2026', null, drops).assumed, false)
  // A drop number the calendar does not have resolves to nothing.
  assert.equal(dropFor('Holiday 2026', 2, drops), null)
  assert.equal(dropFor('Fall 2019', 1, drops), null, 'no 2019 drops on this calendar')
  assert.equal(dropFor('Core', null, drops), null, 'evergreen has no drop')
})

test('⚠️ the real case: PO1785 is Holiday 2026 on a container due Oct 8', () => {
  // 1,330 units of Holiday 2026 on the 55-carton container. Holiday Launch is Oct 13.
  const drops = dropsFrom(CALENDAR)
  const r = dropRisk({ seasonLabel: 'Holiday 2026', drop: 1, expectedOn: '2026-10-08', drops })
  assert.equal(r.state, 'tight', 'five days is inside the week')
  assert.equal(r.days, 5)
  assert.equal(r.landed, false)
  assert.match(r.why, /expected 2026-10-08, 5 days before/)
})

test('late is measured, and a real delivery beats an estimate', () => {
  const drops = dropsFrom(CALENDAR)
  const late = dropRisk({ seasonLabel: 'Fall 2026', drop: 2, expectedOn: '2026-09-20', drops })
  assert.equal(late.state, 'late')
  assert.equal(late.days, 12, '12 days after Fall Drop 2 on 09-08')
  assert.match(late.why, /12 days AFTER/)

  // ⚠️ A DELIVERY WE HAVE OUTRANKS AN ESTIMATE. Both supplied: the real one is used, and
  // it flips the verdict from late to comfortable.
  const landed = dropRisk({
    seasonLabel: 'Fall 2026', drop: 2, expectedOn: '2026-09-20', deliveredOn: '2026-08-20', drops,
  })
  assert.equal(landed.state, 'ok')
  assert.equal(landed.days, 19)
  assert.equal(landed.landed, true)
  assert.match(landed.why, /^landed 2026-08-20/)
})

test('the tight/ok boundary is a week, and it is asserted rather than assumed', () => {
  // Caught by a fixture landing exactly on it: 7 days before Fall Drop 2 is TIGHT, and
  // 8 is comfortable. A boundary nobody pins is a boundary that moves.
  const drops = dropsFrom(CALENDAR)
  const at = (on) => dropRisk({ seasonLabel: 'Fall 2026', drop: 2, deliveredOn: on, drops })
  assert.equal(at('2026-09-01').days, 7)
  assert.equal(at('2026-09-01').state, 'tight')
  assert.equal(at('2026-08-31').days, 8)
  assert.equal(at('2026-08-31').state, 'ok')
  // And the day itself is not late — it made the drop.
  assert.equal(at('2026-09-08').days, 0)
  assert.equal(at('2026-09-08').state, 'tight')
  assert.equal(at('2026-09-09').state, 'late')
})

test('⚠️ no verdict without both dates — "we cannot tell" is its own state', () => {
  const drops = dropsFrom(CALENDAR)
  // No confirmed season.
  assert.equal(dropRisk({ expectedOn: '2026-10-01', drops }).state, 'unknown')
  assert.match(dropRisk({ expectedOn: '2026-10-01', drops }).why, /no confirmed season/)
  // A season with no drop on this calendar.
  assert.match(dropRisk({ seasonLabel: 'Spring 2027', drop: 1, expectedOn: '2026-10-01', drops }).why,
    /no Spring 2027 drop on the calendar/)
  // A drop but no arrival date at all.
  const noEta = dropRisk({ seasonLabel: 'Holiday 2026', drop: 1, drops })
  assert.equal(noEta.state, 'unknown')
  assert.match(noEta.why, /needed by 2026-10-13 and nothing says when it arrives/)
})

test('⚠️ only a LAUNCH has a drop deadline — live data caught this one', () => {
  // PO1820 is 70 units of Summer 2026 arriving 2026-09-20. The first version of this
  // function reported "138 days AFTER Summer Drop 1 Launch" — arithmetically true and
  // nonsense as a finding. Summer product in September is a restock.
  const drops = dropsFrom(CALENDAR)
  const args = { seasonLabel: 'Summer 2026', drop: 1, expectedOn: '2026-09-20', drops }

  const asLaunch = dropRisk({ ...args, reason: 'launch' })
  assert.equal(asLaunch.state, 'late', 'for a launch it genuinely is late')
  assert.equal(asLaunch.days, 138)

  const asRestock = dropRisk({ ...args, reason: 'restock' })
  assert.equal(asRestock.state, 'no-deadline')
  assert.match(asRestock.why, /the season it came from is history/)

  // ⚠️ A re-order answers to the ORDER's date, which is on the SO/OC and not on this
  // calendar — so this refuses rather than inventing a deadline it cannot see.
  const asReorder = dropRisk({ ...args, reason: 'reorder' })
  assert.equal(asReorder.state, 'no-deadline')
  assert.match(asReorder.why, /check the linked SO or OC/)

  // ⚠️ AND NO REASON STILL JUDGES. Most POs are unconfirmed, and a launch is the
  // default shape of inbound stock — staying silent until somebody picks a reason would
  // hide every real deadline.
  assert.equal(dropRisk(args).state, 'late')
})

// ── Why the stock is coming, which the season alone cannot say ──────────────────

test('⚠️ THE 11 AIR: Fall 2026 stock AFTER Fall Drop 2 is a restock, not a launch', () => {
  // Nima, 2026-09-16: "in the case of the 11 air we're restocking a launch item that
  // sold well." Fall Drop 2 was 2026-09-08; the shipment lands 09-16.
  const drops = dropsFrom(CALENDAR)
  const today = new Date('2026-09-16T12:00:00Z')
  const r = suggestReason({ seasonLabel: 'Fall 2026', drop: 2, drops, today })
  assert.equal(r.reason, 'restock')
  // ⚠️ NOT CONFIDENT. Stock arriving after its drop is usually replenishment and can
  // equally be a launch that slipped — "we sold out" vs "we missed the date", and only a
  // person knows which.
  assert.equal(r.confident, false)
  assert.match(r.why, /Fall Drop 2 Launch was 8 days ago/)
  assert.match(r.why, /unless the shipment is simply late/)
})

test('⚠️ the SAME season before its drop is a launch — the season did not change', () => {
  const drops = dropsFrom(CALENDAR)
  // Holiday 2026, 27 days out from 09-16. Same shape of PO, opposite reason.
  const r = suggestReason({ seasonLabel: 'Holiday 2026', drop: 1, drops, today: new Date('2026-09-16T12:00:00Z') })
  assert.equal(r.reason, 'launch')
  assert.equal(r.confident, true)
  assert.match(r.why, /Hoilday Launch is 27 days away/)
})

test('an order link outranks the calendar — it is a fact, not a reading of dates', () => {
  const drops = dropsFrom(CALENDAR)
  const r = suggestReason({
    seasonLabel: 'Holiday 2026', drop: 1, hasOrderLink: true, drops,
    today: new Date('2026-09-16T12:00:00Z'),
  })
  assert.equal(r.reason, 'reorder')
  assert.equal(r.confident, true)
  assert.match(r.why, /linked to an order/)
})

test('Core is a restock by definition, and no drop means no guess', () => {
  const drops = dropsFrom(CALENDAR)
  const core = suggestReason({ evergreen: true, drops })
  assert.equal(core.reason, 'restock')
  assert.equal(core.confident, true)
  assert.match(core.why, /belongs to no drop/)

  // ⚠️ A reason nobody can defend is worse than an empty dropdown.
  const none = suggestReason({ seasonLabel: 'Spring 2027', drop: 1, drops })
  assert.equal(none.reason, null)
  assert.match(none.why, /no Spring 2027 drop on the calendar/)
  assert.equal(suggestReason({ drops }).reason, null)
})
