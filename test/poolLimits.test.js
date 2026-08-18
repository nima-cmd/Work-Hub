import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKEND_CONNECTIONS_1GB, DEFAULT_MAX, DEPLOY_MAX, poolSettings, worstCaseConcurrent,
} from '../src/model/poolLimits.js'

// ⚠️ THE BUG THIS PREVENTS. `new Pool({ connectionString })` with no `max` is node-pg's
// default of 10 per process. Neon's limit was TRANSFER, so this never surfaced. DO's
// 1 GiB plan allows 22 backend connections, and deploy + dev server + one script at the
// default would want 30.

test('the worst plausible case fits inside the plan, with headroom', () => {
  assert.equal(worstCaseConcurrent(), DEPLOY_MAX + DEFAULT_MAX + DEFAULT_MAX)
  assert.ok(worstCaseConcurrent() < BACKEND_CONNECTIONS_1GB,
    `${worstCaseConcurrent()} must be under ${BACKEND_CONNECTIONS_1GB}`)
  // Room for DO's own maintenance connections, not merely "fits".
  assert.ok(BACKEND_CONNECTIONS_1GB - worstCaseConcurrent() >= 4)
})

test('the old default would NOT have fitted — this is why the module exists', () => {
  const nodePgDefault = 10
  assert.ok(nodePgDefault * 3 > BACKEND_CONNECTIONS_1GB)
})

test('the deploy gets the larger share; everything else the smaller', () => {
  assert.equal(poolSettings({ RENDER: 'true' }).max, DEPLOY_MAX)
  assert.equal(poolSettings({ RENDER_SERVICE_ID: 'srv-1' }).role, 'deploy')
  assert.equal(poolSettings({}).max, DEFAULT_MAX)
  assert.equal(poolSettings({}).role, 'local')
})

test('an explicit override wins, for a bigger plan', () => {
  assert.equal(poolSettings({ WORKHUB_POOL_MAX: '40' }).max, 40)
  assert.equal(poolSettings({ RENDER: '1', WORKHUB_POOL_MAX: '2' }).max, 2)
})

// ⚠️ `max: NaN` in node-pg is an UNBOUNDED pool — the exact failure this module exists to
// prevent. So a junk override must be ignored, never coerced.
test('a junk override is ignored, not turned into NaN', () => {
  for (const bad of ['', 'lots', '0', '-5', '3.5', undefined, null]) {
    const s = poolSettings({ WORKHUB_POOL_MAX: bad })
    assert.equal(s.max, DEFAULT_MAX, `WORKHUB_POOL_MAX=${String(bad)}`)
    assert.ok(Number.isInteger(s.max) && s.max > 0)
  }
})

// ⚠️ Without a connect timeout a pool with every client checked out waits FOREVER, so an
// exhausted database presents as a page that never loads and a script that never returns.
test('a connection attempt fails rather than hanging forever', () => {
  const s = poolSettings({})
  assert.ok(s.connectionTimeoutMillis > 0)
  assert.ok(s.idleTimeoutMillis > 0)
})
