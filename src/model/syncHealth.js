// src/model/syncHealth.js — is the live data actually still arriving?
//
// Distinct from getFreshness(), which asks how old the SOURCE data is (a
// CSV-era question about export age). This asks a different one: when did each
// live sync last complete? A sync that stops running looks identical to a quiet
// day — the app keeps serving whatever Neon last received, confidently and
// without complaint.
//
// This repo has been bitten by that shape twice:
//   • The NetSuite live sync shipped in PR #16 with NO CALLER for a week; Neon
//     drifted from NetSuite and seven BOLs were stranded ([[netsuite-sync-wiring]]).
//   • 2026-07-30: the scheduled check kept returning 200 while `netsuiteLive`
//     recorded no snapshot for hours — the cron fires, the sync inside it
//     silently does nothing (almost certainly missing creds on the deploy, since
//     netsuiteConfigured() gates it and a false there is not an error).
//
// Thresholds account for reality, not intent. The workflow asks for every 10
// minutes; GitHub actually fires it roughly every 90 (scheduled workflows are
// best-effort and heavily throttled — measured gaps 2026-07-30: 1h00m–2h10m).
// Warning at 10 minutes would therefore be permanently on, which is the same as
// being off. 3h means "later than any normal throttle"; 6h means "stopped".
export const SYNC_WARN_HOURS = 3
export const SYNC_STALE_HOURS = 6

// The syncs that are supposed to run on their own. A source absent from
// import_snapshots entirely is 'never' — worse than stale, because it means the
// path has never once completed here.
export const LIVE_SYNCS = [
  { key: 'netsuiteLive', label: 'NetSuite orders & fulfilments' },
  { key: 'ediPackagesLive', label: 'EDI cartons (routing feed)' },
]

// Syncs that only exist once their integration is configured — the warehouse
// Supabase mirrors. Deliberately NOT in LIVE_SYNCS: a deploy without the
// WAREHOUSE_* vars would sit permanently red on 'never'. Each joins the health
// picture only after its first completed push; from then on going quiet is a
// real signal, exactly like the always-on syncs.
export const CONDITIONAL_SYNCS = [
  { key: 'warehousePoFeed', label: 'Warehouse PO feed (Supabase)' },
  { key: 'warehouseInventoryFeed', label: 'Warehouse inventory feed (Supabase)' },
]

const RANK = { never: 4, stale: 3, warn: 2, ok: 0 }

export function syncStatus(ageHours) {
  if (ageHours == null) return 'never'
  if (ageHours > SYNC_STALE_HOURS) return 'stale'
  if (ageHours > SYNC_WARN_HOURS) return 'warn'
  return 'ok'
}

// lastBySource: { [key]: Date|string|null } — the newest imported_at per source.
export function computeSyncHealth(lastBySource = {}, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime()

  const row = ({ key, label }) => {
    const last = lastBySource[key] ? new Date(lastBySource[key]) : null
    const ageHours = last ? (t - last.getTime()) / 3.6e6 : null
    return { key, label, lastAt: last ? last.toISOString() : null, ageHours, status: syncStatus(ageHours) }
  }
  const syncs = [
    ...LIVE_SYNCS.map(row),
    ...CONDITIONAL_SYNCS.filter(({ key }) => lastBySource[key]).map(row),
  ]

  // Worst single sync wins — one dead feed makes the whole picture untrustworthy,
  // and averaging would hide exactly the case this exists to catch.
  const status = syncs.reduce((worst, s) => (RANK[s.status] > RANK[worst] ? s.status : worst), 'ok')
  return { status, ok: status === 'ok', syncs, warnHours: SYNC_WARN_HOURS, staleHours: SYNC_STALE_HOURS }
}

// One line for the banner. Names the specific sync — "data may be stale" with no
// subject is the kind of warning people learn to ignore.
export function syncHealthLine(health) {
  if (!health || health.ok) return ''
  const bad = health.syncs.filter((s) => s.status !== 'ok')
  const worst = bad.slice().sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity))[0]
  if (!worst) return ''
  if (worst.status === 'never') return `${worst.label} has never completed a sync here.`
  const hrs = worst.ageHours >= 24
    ? `${Math.floor(worst.ageHours / 24)}d ${Math.round(worst.ageHours % 24)}h`
    : `${Math.round(worst.ageHours)}h`
  const others = bad.length > 1 ? ` (and ${bad.length - 1} other)` : ''
  return `${worst.label} last synced ${hrs} ago${others} — what you're seeing may be behind NetSuite.`
}
