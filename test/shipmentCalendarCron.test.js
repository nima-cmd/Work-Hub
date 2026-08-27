// test/shipmentCalendarCron.test.js — the hourly calendar leg.
import test from 'node:test'
import assert from 'node:assert/strict'
import { syncCalendarIncremental, WATERMARK } from '../src/ingest/shipmentCalendarCron.js'

const NOW = new Date('2026-08-27T18:00:00Z')

function rig({ meta = {}, failed = 0, changed = [], held = [] } = {}) {
  const calls = { candidates: [], sync: [], set: [] }
  const store = { ...meta }
  return {
    calls, store,
    deps: {
      loadCalendarCandidates: async (a) => { calls.candidates.push(a); return changed },
      loadHeldCandidates: async () => held,
      getSyncMeta: async (k) => store[k] ?? null,
      setSyncMeta: async (k, v) => { calls.set.push([k, v]); store[k] = v },
      isConfigured: () => true,
      sync: async (a) => { calls.sync.push(a); return { wrote: 3, failed, plan: { summary: {} }, held: { summary: {} } } },
      now: NOW,
    },
  }
}

test('it asks only for what CHANGED — never a full sweep', async () => {
  // ⚠️ The full backfill is 293 shipments at ~0.9s = 263 SECONDS, on a one-vCPU box
  // already running four other syncs in the same request.
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' } })
  await syncCalendarIncremental(r.deps)
  const arg = r.calls.candidates[0]
  assert.ok(arg.since instanceof Date, 'a window is always passed')
  assert.equal(arg.poNumbers ?? null, null)
  assert.equal(arg.max ?? null, null)
})

test('the window OVERLAPS the last watermark', async () => {
  // ⚠️ A transition committed just after the previous run read the clock, but visible
  // just after, falls in the gap between two exact windows and is never seen again.
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' } })
  await syncCalendarIncremental(r.deps)
  const since = r.calls.candidates[0].since
  assert.ok(since < new Date('2026-08-27T17:00:00.000Z'), 'reaches back before the watermark')
  assert.equal(since.toISOString(), '2026-08-27T16:50:00.000Z')
})

test('the watermark is the START of the run, not the end', async () => {
  // ⚠️ Recording the FINISH time swallows every transition that landed during the run.
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' } })
  await syncCalendarIncremental(r.deps)
  assert.deepEqual(r.calls.set, [[WATERMARK, NOW.toISOString()]])
})

test('a run with ANY failure does NOT advance the watermark', async () => {
  // ⚠️ Advancing past a window whose writes partly failed means those shipments are
  // never revisited: a wrong entry stays wrong forever and nothing looks again.
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' }, failed: 1 })
  const out = await syncCalendarIncremental(r.deps)
  assert.equal(out.watermarkAdvanced, false)
  assert.deepEqual(r.calls.set, [], 'nothing written')
  assert.equal(r.store[WATERMARK], '2026-08-27T17:00:00.000Z', 'left where it was')
})

test('the FIRST run uses a bounded window, and says so', async () => {
  // ⚠️ No watermark must not mean "everything" — that is the 263s sweep, in the cron,
  // on the box's first hour.
  const r = rig({ meta: {} })
  const out = await syncCalendarIncremental(r.deps)
  assert.equal(out.firstRun, true)
  const since = r.calls.candidates[0].since
  const hours = (NOW - since) / 3600000
  assert.ok(hours > 24 && hours < 25, `bounded to ~24h, got ${hours}`)
})

test('the held calendar is synced on EVERY run, regardless of the window', async () => {
  // ⚠️ It is dated TODAY and rolls forward. Gating it on "did anything change" would
  // leave 30-odd entries sitting on yesterday, each claiming to be current.
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:59:00.000Z' }, changed: [], held: [{ so: 'SO1' }] })
  await syncCalendarIncremental(r.deps)
  assert.equal(r.calls.sync[0].held.length, 1)
  assert.equal(r.calls.sync[0].candidates.length, 0, 'nothing shipped changed — and held still ran')
})

test('todayIso is the warehouse day, and is passed in — never read from a clock below', async () => {
  const r = rig({ meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' } })
  await syncCalendarIncremental(r.deps)
  // 18:00Z on the 27th is 11:00 in Glendale, still the 27th.
  assert.equal(r.calls.sync[0].todayIso, '2026-08-27')
  assert.equal(r.calls.sync[0].dryRun, false)
})

test('a candidate that failed to load is not published, and is counted', async () => {
  const r = rig({
    meta: { [WATERMARK]: '2026-08-27T17:00:00.000Z' },
    changed: [{ po: 'A' }, { po: 'B', loadError: 'NetSuite timed out' }],
  })
  const out = await syncCalendarIncremental(r.deps)
  assert.equal(r.calls.sync[0].candidates.length, 1)
  assert.equal(out.loadErrors, 1)
})

test('Google unconfigured is a clean skip, not a throw', async () => {
  const r = rig()
  r.deps.isConfigured = () => false
  const out = await syncCalendarIncremental(r.deps)
  assert.equal(out.configured, false)
  assert.deepEqual(r.calls.sync, [])
})

test('startCalendarIncremental returns immediately and refuses re-entry', async () => {
  const { startCalendarIncremental, calendarSyncInFlight } = await import('../src/ingest/shipmentCalendarCron.js')
  let release
  const gate = new Promise((r) => { release = r })
  const deps = {
    loadCalendarCandidates: async () => { await gate; return [] },
    loadHeldCandidates: async () => [],
    getSyncMeta: async () => '2026-08-27T17:00:00.000Z',
    setSyncMeta: async () => {},
    isConfigured: () => true,
    sync: async () => ({ wrote: 0, failed: 0, plan: { summary: {} }, held: { summary: {} } }),
    now: NOW,
  }
  const first = startCalendarIncremental(deps)
  assert.deepEqual(first, { started: true })
  assert.equal(calendarSyncInFlight(), true)

  // ⚠️ The next hour's cron must not re-enter a run still in progress — two syncs
  // writing the same calendars concurrently is duplicated work at best.
  assert.deepEqual(startCalendarIncremental(deps), { skipped: 'already running' })

  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calendarSyncInFlight(), false, 'the flag clears when the run finishes')
})
