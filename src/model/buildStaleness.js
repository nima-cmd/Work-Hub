// src/model/buildStaleness.js — is the bundle on :3001 older than the code?
//
// Nima, 2026-09-11: "crew still only shows the old crew but im on localhol 3001
// which can sometimes lag behind i think" — then "why are there two seperate
// servers is this soemthing we can fix do we need both".
//
// He was right, and it was worse than lag. client/dist was built 2026-09-09 14:31
// and the :3001 process started 09-10, so it had been serving a two-day-old bundle
// while the source moved on. Nothing said so. He reported the feature as missing,
// I could have "fixed" a working feature, and the only reason I did not is that
// I checked the file timestamps.
//
// ── ⚠️ WHY THIS IS NOT "JUST REBUILD" ───────────────────────────────────────
//
// Two servers is not the bug. :3001 IS the API and also serves the built client;
// :5173 is Vite serving SOURCE with hot reload and proxying /api to :3001. Both are
// wanted. The bug is that the two URLs look identical and one is silently frozen
// at whenever someone last ran `npm run client:build`.
//
// This is the same shape as the mirror's staleness banner, and for the same reason:
// a stale source that ANNOUNCES itself is fine, a stale source that looks live is
// how you lose an afternoon. See src/model/fieldAssumptions.js for the register of
// what "a number that looks calm" has cost in this repo.
//
// ⚠️ IT REPORTS, IT NEVER BLOCKS. Refusing to boot on a stale build would take the
// API down over a cosmetic mismatch, and the API is the half that is never stale.

/** A build older than its source by less than this is treated as concurrent. */
export const GRACE_MS = 60 * 1000

const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : v ? new Date(v).getTime() : NaN)

/**
 * @param builtAt    when the bundle was written (client/dist/index.html mtime)
 * @param newestSrc  the newest mtime across the client + shared model sources
 * @param newestFile which file that was, so the message can name it
 */
export function buildStaleness({ builtAt, newestSrc, newestFile = null, now = Date.now() } = {}) {
  const b = ms(builtAt)
  const s = ms(newestSrc)

  // ⚠️ NO BUILD AT ALL IS ITS OWN STATE, not "infinitely stale". :3001 serves
  // nothing in that case, which is a different problem with a different fix, and
  // reporting it as a stale build would send someone looking for the wrong thing.
  if (!Number.isFinite(b)) {
    return {
      state: 'missing', stale: true, behindMs: null, behindLabel: null, newestFile,
      message: 'No built client — :3001 has nothing to serve. Run `npm run client:build`, or use :5173.',
    }
  }
  // Source mtimes unreadable: say so rather than declaring the build fresh.
  if (!Number.isFinite(s)) {
    return {
      state: 'unknown', stale: false, behindMs: null, behindLabel: null, newestFile,
      message: 'Could not read source timestamps, so build freshness is unverified.',
    }
  }

  const behindMs = s - b
  if (behindMs <= GRACE_MS) {
    return {
      state: 'fresh', stale: false, behindMs: Math.max(0, behindMs), behindLabel: null,
      newestFile, builtAgeLabel: ago(now - b),
      message: `Built client is current (built ${ago(now - b)} ago).`,
    }
  }
  const label = ago(behindMs)
  return {
    state: 'stale', stale: true, behindMs, behindLabel: label, newestFile,
    builtAgeLabel: ago(now - b),
    message: `⚠ The built client on :3001 is ${label} behind the source`
      + (newestFile ? ` (newest: ${newestFile})` : '')
      + '. Run `npm run client:build`, or use the dev server on :5173 which reads source directly.',
  }
}

/**
 * Whole units only — "3 days", never "3.07 days".
 *
 * ⚠️ UNDER A WEEK IT CARRIES THE REMAINDER HOURS, and that is not decoration. The
 * real case was 44 hours behind, which floors to "1 day" — a warning that reads as
 * half of what it is. "1 day 20 hours" is the same precision, honestly rounded down,
 * without becoming a decimal.
 */
export function ago(msSpan) {
  const n = Math.max(0, Number(msSpan) || 0)
  const mins = Math.floor(n / 60000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'}`
  const days = Math.floor(hrs / 24)
  const rem = hrs % 24
  const d = `${days} day${days === 1 ? '' : 's'}`
  if (days >= 7 || rem === 0) return d
  return `${d} ${rem} hour${rem === 1 ? '' : 's'}`
}

/**
 * Which trees can change what :3001 serves.
 *
 * ⚠️ `src/model` IS IN HERE, and leaving it out was the trap worth naming: the
 * client imports the shared model directly (`../../../src/model/characters.js`),
 * so editing a model file alone changes the UI while nothing under client/ moves.
 * Exactly the case that just happened — characters.js and dialogue.js.
 */
export const WATCHED = ['client/src', 'client/index.html', 'src/model']
