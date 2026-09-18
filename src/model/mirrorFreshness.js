// src/model/mirrorFreshness.js — is a table another repo owns still being refreshed?
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ Some tables in our database are filled in by a DIFFERENT program. The item  │
// │ catalogue — including every customs tariff code — is written by the         │
// │ `weaver` repo, not by Work-Hub.                                             │
// │                                                                             │
// │ That works fine until it stops. If the other program quietly stops running, │
// │ our data does not disappear — it just gets older, and nothing here would    │
// │ notice. We would keep printing tariff codes from whenever it last ran, on   │
// │ paperwork that goes to a carrier.                                           │
// │                                                                             │
// │ So this asks the table itself how recently it was written, rather than      │
// │ asking the other program whether it is still alive.                         │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ IT WATCHES THE DATA, NOT A SYNC RECORD, AND THAT IS THE POINT ────────────
//
// src/model/syncHealth.js answers the same question for OUR syncs, by reading
// `import_snapshots` — a record each sync writes when it finishes. That cannot work
// here: the weaver repo does not write our snapshot table and never will. Depending on
// a foreign program to report its own health is exactly the failure this guards against.
// The row timestamps are the one signal that cannot lie about itself.
//
// ── ⚠️ A STOPPED SYNC ALREADY FAILS SAFE FOR *NEW* ITEMS ────────────────────────
//
// Worth being precise about the risk, because it decides warn-vs-block. If the mirror
// stops, an item created afterwards has NO ROW, so its tariff code comes back null and
// customsInvoice.js BLOCKS the declaration outright. What staleness actually risks is a
// CHANGED code on an EXISTING item going unnoticed — real, but far less likely, since
// tariff codes are reclassified rarely.
//
// So this WARNS and never blocks. Blocking a real shipment because a data pipeline is
// late would stop the warehouse for a reason the warehouse cannot fix, and this repo's
// own rule is that a gate people cannot act on trains them to ignore gates.

/** Days before the mirror is worth mentioning, and before it reads as stopped. */
export const MIRROR_WARN_DAYS = 3
export const MIRROR_STALE_DAYS = 7

/**
 * How fresh is a mirrored table?
 *
 * @param newestAt  the newest row timestamp, or null when the table is empty
 * @param label     what to call it in the sentence
 *
 * ⚠️ AN EMPTY TABLE IS ITS OWN STATE, not "infinitely stale". A mirror that has never
 * been populated here and one that stopped last month need different sentences: the
 * first is a setup that was never finished, the second is something that broke. This
 * repo has hit the first shape four times in one session ([[tracker-current-phase]]:
 * "an empty table looks exactly like a quiet one").
 */
export function mirrorFreshness({
  newestAt, label = 'the item catalogue', owner = 'the weaver repo',
  now = Date.now(), warnDays = MIRROR_WARN_DAYS, staleDays = MIRROR_STALE_DAYS,
} = {}) {
  if (!newestAt) {
    return {
      state: 'never',
      ageDays: null,
      why: `${label} has no rows at all — it is written by ${owner}, which has never populated it here`,
    }
  }
  const ms = now - new Date(newestAt).getTime()
  if (Number.isNaN(ms)) {
    return { state: 'unknown', ageDays: null, why: `${label} has an unreadable timestamp — cannot tell how fresh it is` }
  }
  const ageDays = Math.floor(ms / 86400000)
  // ⚠️ A FUTURE TIMESTAMP IS REPORTED, NOT CLAMPED TO FRESH. Clock skew between two
  // programs writing the same database is a real thing, and "fresher than now" is a
  // symptom worth seeing rather than rounding away into a green tick.
  if (ms < 0) {
    return { state: 'unknown', ageDays: 0, why: `${label} carries a timestamp in the future — check the clock on ${owner}` }
  }
  if (ageDays >= staleDays) {
    return {
      state: 'stale', ageDays,
      why: `${label} has not been refreshed for ${ageDays} days — ${owner} may have stopped. Tariff codes and item data are from ${String(newestAt).slice(0, 10)}`,
    }
  }
  if (ageDays >= warnDays) {
    return { state: 'aging', ageDays, why: `${label} was last refreshed ${ageDays} days ago by ${owner}` }
  }
  return { state: 'fresh', ageDays, why: `${label} was refreshed ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}` }
}
