// src/model/poolLimits.js — how many Postgres connections each process may hold.
//
// ── WHY THIS EXISTS (2026-08-18) ────────────────────────────────────────────
//
// `new Pool({ connectionString })` with no `max` means node-pg's default of **10
// connections per pool, per process**. Neon never made us notice: its allowance is
// generous and the limit that bit us was TRANSFER, not connections.
//
// DigitalOcean Managed Postgres meters no transfer at all — which is the whole reason
// to move — but its smallest plan (1 GiB) allows **22 backend connections**. Count what
// can be live at once against one database:
//
//     the Render deploy          10
//     a local dev server         10
//     any CLI script             10   (check:counters, a sync, …)
//                                --
//                                30   against a ceiling of 22
//
// Pools open lazily and drop idle clients, so a quiet day would survive. A sync running
// while the deploy serves a page and a check is in flight is exactly the shape that
// would not — and it would surface as connection errors, which look like a broken app
// rather than a capacity limit. So the budget is explicit, and it is documented here
// rather than being an accident of a library default.
//
// ⚠️ This is a CEILING, not a reservation: a pool holds only what it needs. The numbers
// are chosen so the plausible worst case fits inside 22 with room for DO's own
// maintenance connections.
//
// The better answer for the deploy is DO's PgBouncer pool (many app connections
// multiplexed onto few backend ones); this makes the app safe either way.

/** DO Managed Postgres, 1 GiB single node. Their published figure. */
export const BACKEND_CONNECTIONS_1GB = 22

/** The deploy serves the UI and absorbs the cron, so it gets the largest share. */
export const DEPLOY_MAX = 8
/** A dev server or a one-shot script. One human, or one sequential job. */
export const DEFAULT_MAX = 4

/**
 * Pool options from the environment.
 *
 * `WORKHUB_POOL_MAX` overrides everything — for a bigger plan, or to debug. A value
 * that is not a positive integer is IGNORED rather than silently becoming NaN, because
 * `max: NaN` in node-pg is an unbounded pool: the exact failure this module prevents.
 */
export function poolSettings(env = {}) {
  const isDeploy = !!(env.RENDER || env.RENDER_SERVICE_ID)
  const override = Number(env.WORKHUB_POOL_MAX)
  const valid = Number.isInteger(override) && override > 0
  return {
    role: isDeploy ? 'deploy' : 'local',
    max: valid ? override : (isDeploy ? DEPLOY_MAX : DEFAULT_MAX),
    // Release quickly, so a burst does not hold connections a later process needs.
    idleTimeoutMillis: 10_000,
    // ⚠️ Fail rather than hang. Without this, a pool with every client checked out waits
    // FOREVER for one to free up, so an exhausted database presents as a page that never
    // loads and a script that never returns — the hardest possible thing to diagnose.
    connectionTimeoutMillis: 10_000,
  }
}

/** The worst plausible case, for the test that pins the arithmetic. */
export function worstCaseConcurrent() {
  return DEPLOY_MAX + DEFAULT_MAX + DEFAULT_MAX  // deploy + dev server + one script
}
