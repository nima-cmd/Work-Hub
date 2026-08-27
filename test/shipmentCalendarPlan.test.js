// test/shipmentCalendarPlan.test.js — the calendar sync's rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  laneFor, nextDay, toGoogleEvent, eventDiffers, planShipmentCalendar, summarize,
  LANE, ACTION, SKIP, CALENDAR_NAME,
} from '../src/model/shipmentCalendarPlan.js'
import { syncShipmentCalendar } from '../src/ingest/shipmentCalendarSync.js'
import { isoPlainDay, shipmentEvent } from '../src/model/shipmentCalendar.js'

// ── a proven shipment, shaped like shipmentEvidence()'s output ──────────────
const evidence = ({ proven = true, asns = [{ number: 'NB1731242', accepted: true, at: '2026-08-03T18:00:00Z' }] } = {}) => ({
  proven,
  strongest: proven ? 'ASN_ACCEPTED' : 'OUR_RECORD',
  strongestLabel: proven ? 'accepted ASN (856)' : 'our own ship date',
  counts: { asns: asns.length, asnsAccepted: asns.length, asnsDeliveredNotAccepted: 0, invoices: 0, invoicesAccepted: 0, scans: 0 },
  backTrace: { asns, invoices: [], scans: [] },
})
const noEvidence = () => ({ proven: false, strongest: null, strongestLabel: null, counts: {}, backTrace: { asns: [], invoices: [], scans: [] } })

test('laneFor: EDI partners route to the EDI calendar, everyone else to Boutique', () => {
  assert.equal(laneFor({ partner: "Bloomingdale's" }), LANE.EDI)
  assert.equal(laneFor({ partner: 'Nordstrom' }), LANE.EDI)
  assert.equal(laneFor({ partner: 'ShopBop' }), LANE.EDI)
  assert.equal(laneFor({ partner: 'Ron Herman' }), LANE.BOUTIQUE)
  assert.equal(laneFor({ customer: 'Nordstrom - 0299' }), LANE.EDI)
  assert.equal(laneFor({ location: 'Warehouse Bulk : Nordstrom' }), LANE.EDI)
})

test('laneFor: NO NAME IS NOT BOUTIQUE — an unclassifiable PO returns null', () => {
  // ⚠️ deriveSource() answers 'boutique' for anything unmatched, which cannot tell
  // "not Nordstrom" from "nothing given". Falling through would file freight on a
  // SHARED calendar under a lane nobody asserted — `default is not an answer`.
  assert.equal(laneFor({}), null)
  assert.equal(laneFor({ partner: null, customer: null, location: null }), null)
  assert.equal(laneFor({ partner: '' }), null)
})

test('nextDay: an all-day end is EXCLUSIVE, and rolls over months, years and leap days', () => {
  assert.equal(nextDay('2026-08-03'), '2026-08-04')
  assert.equal(nextDay('2026-08-31'), '2026-09-01')
  assert.equal(nextDay('2026-12-31'), '2027-01-01')
  assert.equal(nextDay('2028-02-28'), '2028-02-29') // 2028 is a leap year
  assert.equal(nextDay('2027-02-28'), '2027-03-01') // 2027 is not
  assert.equal(nextDay('garbage'), null)
  assert.equal(nextDay(null), null)
})

test('nextDay: a DST-transition day still advances by exactly one calendar day', () => {
  // ⚠️ US DST 2026: forward 03-08, back 11-01. Built in local time, one of these
  // yields the SAME day back or skips one — which is how a DATE moves backwards.
  assert.equal(nextDay('2026-03-08'), '2026-03-09')
  assert.equal(nextDay('2026-11-01'), '2026-11-02')
})

test('toGoogleEvent: all-day shape, our stable id, and never marks him busy', () => {
  const ev = { key: 'po7242978', date: '2026-08-03', summary: 'x', description: 'y' }
  const g = toGoogleEvent(ev)
  assert.equal(g.id, 'po7242978')
  assert.deepEqual(g.start, { date: '2026-08-03' })
  assert.deepEqual(g.end, { date: '2026-08-04' })
  assert.equal(g.transparency, 'transparent')
  assert.equal(g.start.date === g.end.date, false, 'a zero-length all-day event renders on no day')
})

test('eventDiffers: ignores server-owned fields, catches every field a reader sees', () => {
  const desired = toGoogleEvent({ key: 'po1', date: '2026-08-03', summary: 'S', description: 'D' })
  const live = { ...desired, etag: '"abc"', updated: '2026-08-25T00:00:00Z', iCalUID: 'x', reminders: { useDefault: true } }
  assert.equal(eventDiffers(live, desired), false, 'etag/updated churn must not rewrite the calendar hourly')
  assert.equal(eventDiffers(null, desired), true)
  assert.equal(eventDiffers({ ...live, summary: 'other' }, desired), true)
  assert.equal(eventDiffers({ ...live, description: 'other' }, desired), true)
  assert.equal(eventDiffers({ ...live, start: { date: '2026-08-04' } }, desired), true)
  assert.equal(eventDiffers({ ...live, end: { date: '2026-08-09' } }, desired), true)
})

test('plan: create when absent, unchanged on a re-run, update when the body moves', () => {
  const cand = [{ po: '7242978', partner: "Bloomingdale's", evidence: evidence(), shipDates: [] }]
  const first = planShipmentCalendar({ candidates: cand, existing: {} })
  assert.equal(first.entries[0].action, ACTION.CREATE)
  assert.equal(first.entries[0].lane, LANE.EDI)

  // feed the created event back — a second run must not duplicate it
  const live = new Map([[first.entries[0].key, first.entries[0].event]])
  const second = planShipmentCalendar({ candidates: cand, existing: { [LANE.EDI]: live } })
  assert.equal(second.entries[0].action, ACTION.UNCHANGED)

  const moved = new Map([[first.entries[0].key, { ...first.entries[0].event, start: { date: '2026-07-01' }, end: { date: '2026-07-02' } }]])
  const third = planShipmentCalendar({ candidates: cand, existing: { [LANE.EDI]: moved } })
  assert.equal(third.entries[0].action, ACTION.UPDATE)
})

test('plan: skips carry a REASON, and a PO with no evidence is never published', () => {
  const p = planShipmentCalendar({
    candidates: [
      { po: 'A', partner: 'Nordstrom', evidence: noEvidence(), shipDates: [] },   // nothing to say
      { po: 'B', partner: 'Nordstrom', evidence: evidence(), shipDates: [] },     // fine
      { po: 'C', evidence: evidence(), shipDates: [] },                            // no lane
    ],
    existing: {},
  })
  const by = Object.fromEntries(p.entries.map((e) => [e.po, e]))
  assert.equal(by.A.action, ACTION.SKIP)
  // ⚠️ NO_EVENT, not NOT_PUBLISHABLE — and asserting the wrong one here is what proved
  // NOT_PUBLISHABLE is unreachable with self-consistent input: no evidence also means
  // no date, so the date guard always fires first. Its own case is below.
  assert.equal(by.A.reason, SKIP.NO_EVENT)
  assert.equal(by.B.action, ACTION.CREATE)
  assert.equal(by.C.action, ACTION.SKIP)
  assert.equal(by.C.reason, SKIP.UNKNOWN_LANE)
})

test('plan: a lane change is REPORTED as a stale twin, never silently deleted', () => {
  const cand = [{ po: '900', partner: 'Nordstrom', evidence: evidence(), shipDates: [] }]
  const key = planShipmentCalendar({ candidates: cand, existing: {} }).entries[0].key
  const p = planShipmentCalendar({ candidates: cand, existing: { [LANE.BOUTIQUE]: new Map([[key, { summary: 'old' }]]) } })
  assert.equal(p.misfiled.length, 1)
  assert.deepEqual(
    { staleIn: p.misfiled[0].staleIn, belongsIn: p.misfiled[0].belongsIn },
    { staleIn: LANE.BOUTIQUE, belongsIn: LANE.EDI })
  assert.equal(p.entries[0].action, ACTION.CREATE, 'it still publishes into the correct lane')
})

test('summarize: proven/unproven counts the PUBLISHED events, not every candidate', () => {
  // ⚠️ A count whose population is not its label is this repo's commonest counter bug.
  const s = summarize(planShipmentCalendar({
    candidates: [
      { po: '1', partner: 'Nordstrom', evidence: evidence(), shipDates: [] },
      { po: '2', partner: 'Nordstrom', evidence: noEvidence(), shipDates: [] },  // skipped
      { po: '3', partner: 'Ron Herman', evidence: evidence({ proven: false }), shipDates: ['2026-08-01'] },
    ],
    existing: {},
  }).entries)
  assert.equal(s.total, 3)
  assert.equal(s.skip, 1)
  assert.equal(s.proven + s.unproven, 2, 'the skipped PO is in neither bucket')
  assert.equal(s.byLane[LANE.EDI], 1)
  assert.equal(s.byLane[LANE.BOUTIQUE], 1)
})

// ── the sync itself, with Google faked ──────────────────────────────────────
function fakeGoogle({ calendars = {}, events = {} } = {}) {
  const calls = { ensure: [], upsert: [], fetch: [] }
  return {
    calls,
    deps: {
      getAccessToken: async () => 'tok',
      ensureCalendar: async (_t, name, { create } = {}) => {
        calls.ensure.push({ name, create })
        const id = calendars[name]
        if (!id && !create) return { id: null, name, missing: true, created: false }
        return { id: id || `made-${name}`, name, created: !id }
      },
      fetchOwnedEvents: async (_t, id) => { calls.fetch.push(id); return events[id] || new Map() },
      upsertEvent: async (_t, id, ev, { update } = {}) => {
        calls.upsert.push({ calendarId: id, id: ev.id, update })
        return { mode: update ? 'update' : 'create', event: ev }
      },
    },
  }
}

const withEnv = async (fn) => {
  const keep = { ...process.env }
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c' })
  try { return await fn() } finally { process.env = keep }
}

test('sync: a DRY RUN writes nothing AND creates no calendars', async () => {
  await withEnv(async () => {
    const g = fakeGoogle()
    const r = await syncShipmentCalendar({
      candidates: [{ po: '7242978', partner: "Bloomingdale's", evidence: evidence(), shipDates: [] }],
      dryRun: true, deps: g.deps,
    })
    assert.equal(g.calls.upsert.length, 0, 'a dry run must not write an event')
    assert.deepEqual(g.calls.ensure.map((c) => c.create), [false, false],
      'a dry run that leaves two permanent calendars behind is not a dry run')
    assert.equal(r.plan.summary.create, 1)
    assert.equal(r.wrote, 0)
  })
})

test('sync: --write publishes, routing each PO to its own calendar', async () => {
  await withEnv(async () => {
    const g = fakeGoogle({ calendars: { [CALENDAR_NAME[LANE.EDI]]: 'cal-edi', [CALENDAR_NAME[LANE.BOUTIQUE]]: 'cal-b' } })
    const r = await syncShipmentCalendar({
      candidates: [
        { po: '111', partner: 'Nordstrom', evidence: evidence(), shipDates: [] },
        { po: '222', partner: 'Ron Herman', evidence: evidence(), shipDates: [] },
      ],
      dryRun: false, deps: g.deps,
    })
    assert.equal(r.wrote, 2)
    assert.equal(r.failed, 0)
    const byCal = Object.fromEntries(g.calls.upsert.map((u) => [u.id, u.calendarId]))
    assert.equal(byCal.po111, 'cal-edi')
    assert.equal(byCal.po222, 'cal-b')
  })
})

test('sync: one failing event does not abandon the rest, and is reported', async () => {
  await withEnv(async () => {
    const g = fakeGoogle({ calendars: { [CALENDAR_NAME[LANE.EDI]]: 'cal-edi' } })
    const good = g.deps.upsertEvent
    g.deps.upsertEvent = async (t, id, ev, o) => {
      if (ev.id === 'po222') throw new Error('Google Calendar 403: rateLimitExceeded')
      return good(t, id, ev, o)
    }
    const r = await syncShipmentCalendar({
      candidates: ['111', '222', '333'].map((po) => ({ po, partner: 'Nordstrom', evidence: evidence(), shipDates: [] })),
      dryRun: false, lanes: [LANE.EDI], deps: g.deps,
    })
    assert.equal(r.wrote, 2, 'a partial calendar you KNOW is partial is recoverable')
    assert.equal(r.failed, 1)
    assert.match(r.results.find((x) => !x.ok).error, /rateLimitExceeded/)
  })
})

test('sync: unconfigured Google is a clean skip, never a throw', async () => {
  const keep = { ...process.env }
  delete process.env.GOOGLE_REFRESH_TOKEN
  try {
    const r = await syncShipmentCalendar({ candidates: [], dryRun: true })
    assert.equal(r.configured, false)
    assert.equal(r.plan.entries.length, 0)
  } finally { process.env = keep }
})

test('sync: --lane=edi writes only EDI, but still SEES a twin in the other lane', async () => {
  await withEnv(async () => {
    const key = 'po111'
    const g = fakeGoogle({
      calendars: { [CALENDAR_NAME[LANE.EDI]]: 'cal-edi', [CALENDAR_NAME[LANE.BOUTIQUE]]: 'cal-b' },
      events: { 'cal-b': new Map([[key, { summary: 'stale' }]]) },
    })
    const r = await syncShipmentCalendar({
      candidates: [{ po: '111', partner: 'Nordstrom', evidence: evidence(), shipDates: [] }],
      dryRun: false, lanes: [LANE.EDI], deps: g.deps,
    })
    // ⚠️ Reading BOTH calendars is what makes this work; scoping the read to --lane
    // left the twin undetectable while the comment claimed otherwise.
    assert.equal(r.plan.misfiled.length, 1)
    assert.equal(r.plan.misfiled[0].staleIn, LANE.BOUTIQUE)
    assert.deepEqual(g.calls.upsert.map((u) => u.calendarId), ['cal-edi'], 'only the requested lane is written')
    assert.equal(g.calls.ensure.find((c) => c.name === CALENDAR_NAME[LANE.BOUTIQUE]).create, false,
      'a lane it only reads must never be created')
  })
})

test('plan: a date with NOTHING behind it is refused — the guard NO_EVENT cannot reach', () => {
  // ⚠️ Only reachable because `evidence` and `shipDates` are separate arguments. This
  // is the shape the guard exists for: a caller hands over a ship date while the
  // evidence carries no tier at all, and publishing "shipped" off that is the precise
  // claim shipmentCalendar.js was written to refuse.
  const p = planShipmentCalendar({
    candidates: [{ po: 'D', partner: 'Nordstrom', evidence: noEvidence(), shipDates: ['2026-08-03'] }],
    existing: {},
  })
  assert.equal(p.entries[0].action, ACTION.SKIP)
  assert.equal(p.entries[0].reason, SKIP.NOT_PUBLISHABLE)
})

test('isoPlainDay: a pg DATE is a Date object — the slice yields a WEEKDAY', () => {
  // ⚠️ The regression this exists for. node-pg returns DATE as a JS Date at LOCAL
  // midnight, so String(d).slice(0,10) is "Sat Jun 27". getShipmentEvidence shipped
  // exactly that to its callers until the calendar dry run surfaced it (2026-08-25).
  const pgDate = new Date(2026, 5, 27) // local midnight, 27 June 2026
  assert.equal(String(pgDate).slice(0, 10), 'Sat Jun 27', 'the bug, pinned')
  assert.equal(isoPlainDay(pgDate), '2026-06-27')
})

test('isoPlainDay: a dateless day is never re-zoned, in either hemisphere', () => {
  // ⚠️ toISOString() is not the fix: local midnight in a negative-offset zone is the
  // PREVIOUS day in UTC. Whatever this machine's zone, the day must round-trip.
  for (const [y, m, d] of [[2026, 0, 1], [2026, 11, 31], [2028, 1, 29]]) {
    const local = new Date(y, m, d)
    assert.equal(isoPlainDay(local), `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  assert.equal(isoPlainDay('2026-08-07T00:00:00Z'), '2026-08-07', 'a string is already a plain day')
  assert.equal(isoPlainDay(null), null)
  assert.equal(isoPlainDay(new Date('nonsense')), null)
})

test('shipmentEvent: never claims "no paperwork filed" when Drive was never searched', () => {
  // ⚠️ 184 of 235 candidates resolve no partner, so Drive is not searched for them at
  // all. Asserting an absence we never checked for, on a calendar the warehouse reads.
  const ev = {
    proven: true, strongest: 'ASN_ACCEPTED', strongestLabel: 'accepted ASN (856)',
    counts: {}, backTrace: { asns: [{ number: 'NB1', accepted: true, at: '2026-08-03T18:00:00Z' }], invoices: [], scans: [] },
  }
  const notChecked = shipmentEvent({ po: '1', partner: 'X', evidence: { ...ev, scansChecked: false } })
  assert.match(notChecked.description, /not checked/)
  assert.doesNotMatch(notChecked.description, /No signed paperwork filed/)

  const checked = shipmentEvent({ po: '1', partner: 'X', evidence: { ...ev, scansChecked: true } })
  assert.match(checked.description, /No signed paperwork filed/)

  // ⚠️ An older caller that sets no flag keeps the original wording, not a new hedge.
  const legacy = shipmentEvent({ po: '1', partner: 'X', evidence: ev })
  assert.match(legacy.description, /No signed paperwork filed/)
})

// ── a shipped order with no PO ──────────────────────────────────────────────
import { LANE as L2 } from '../src/model/shipmentCalendarPlan.js'

test('an SO is enough — a boutique order with no PO still gets an event', () => {
  // ⚠️ Splash SO12299: shipped, signed BOL on file, and it appeared on NO calendar —
  // dropped from the warehouse calendar because it had departed, and never eligible
  // for a shipped one because it had no PO. 46 shipments were in this state.
  const p = planShipmentCalendar({
    candidates: [{ po: null, so: 'SO12299', partner: 'Splash', evidence: evidence(), shipDates: ['2026-08-26'] }],
    existing: {},
  })
  assert.equal(p.entries[0].action, ACTION.CREATE)
  assert.equal(p.entries[0].key, 'so12299')
  assert.equal(p.entries[0].lane, LANE.BOUTIQUE)
})

test('a PO still wins, so every event published before this keeps its id', () => {
  // ⚠️ The migration hazard. If the key scheme changed for existing events, 240 live
  // entries would be orphaned and re-created as duplicates on a shared calendar.
  const p = planShipmentCalendar({
    candidates: [{ po: '7242978', so: 'SO999', partner: "Bloomingdale's", evidence: evidence(), shipDates: [] }],
    existing: {},
  })
  assert.equal(p.entries[0].key, 'po7242978', 'unchanged from before SO-keying existed')
})

test('neither a PO nor an SO is still no event', () => {
  const p = planShipmentCalendar({
    candidates: [{ po: null, so: null, partner: 'Splash', evidence: evidence(), shipDates: ['2026-08-26'] }],
    existing: {},
  })
  assert.equal(p.entries[0].action, ACTION.SKIP)
})
