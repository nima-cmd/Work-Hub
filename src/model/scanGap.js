// src/model/scanGap.js — the custody chain, and where a shipment fell out of it.
//
// ── NIMA'S WORKFLOW, 2026-08-06 — THIS IS THE SPEC ──────────────────────────
//
// > "if i make an item fullfilment i want to be scanning it as it prints. so if an item
// >  fullilment sits with no scan for a while something gone wrong. There is no need for
// >  me to make an item fullfilment and not print it out and give it to him immediately
// >  in fact this is the workflow. anytime anything goes stale in that an item
// >  fullfilment made but no scan out thats a sign that something might be out of place.
// >  after that stage im not sure what safeguards we have cause he gives it back to me
// >  and i should scan it immediately though thats not always the case"
//
// So the chain has three links, and each has its OWN expectation:
//
//   ① IF created  → scanned OUT as the slip prints, and handed to Nestor.
//                   There is no legitimate reason to make one and not hand it over,
//                   so a missing OUT is not lateness — it is a lost thread.
//   ② with Nestor → scanned back IN when returned.
//   ③ back with us → labelled, invoiced, shipped (other surfaces own this).
//
// ── ⚠️ WHY THIS COULD NOT BE SEEN BEFORE ────────────────────────────────────
//
// The custody register's query ends `HAVING bool_or(event_type IN ('CUSTODY_OUT',
// 'CUSTODY_IN'))` — at least one scan to appear. So the register is a list of things
// that ENTERED the register, and link ① is structurally invisible to it: a fulfilment
// never scanned can never show up. Nima found four by hand.
//
// That is why the threshold for ① is not "3 days like the register's stale flag". The
// scan is meant to happen at the printer, so ANY fulfilment carrying yesterday's date
// with no scan has already broken the workflow.
//
// ⚠️ Measured in dates, not hours, because `fulfillments.if_date` is a DATE. An IF
// created this afternoon and not yet scanned is not a gap — it is this afternoon. So
// the test is "dated before today", which is the earliest honest thing the data
// supports and errs toward silence.
//
// ── ⚠️ AN EDI SHIPMENT IS SCANNED ON ITS CARGO TAG, NOT ITS SLIP ────────────
//
// The FIRST version of this file looked only at `doc_type='IF'` events and reported 28
// broken threads. **All 28 were false.** Every one was a Nordstrom fulfilment whose
// per-DC cargo tag (`DC:<po>:<abbrev>`) HAD been scanned — the goods went out together
// on the tag, exactly as designed, and the IF slip was never the evidence for that lane.
// Caught only by asking why 28 of 28 hits came from one lane.
//
// This is the same shape as labelGap.js's freight lane and FOB lane: a lane-agnostic
// rule applied to a lane that keeps its evidence somewhere else. cardCustody already
// knew this (it prefers DC docs for an EDI group); this file did not.
//
// So either route counts. The IF scan wins when it exists (it is the tighter, per-
// fulfilment evidence); the DC tag stands in when it does not.

export const SCAN_GAP = {
  OK: 'OK',
  // ① made, never handed over. The invisible one.
  NEVER_SCANNED: 'NEVER_SCANNED',
  // ② out with Nestor and not returned. The register shows these; kept here so one
  // surface can narrate the whole chain rather than half of it.
  OUT_NOT_BACK: 'OUT_NOT_BACK',
  // ③ back in our hands and not moving. Named, but deliberately NOT actioned here —
  // labelGap.js and the ship desk already own what a returned shipment needs, and two
  // surfaces giving the same order different instructions is the defect this repo keeps
  // re-finding.
  BACK_WITH_US: 'BACK_WITH_US',
}

// A day is the finest unit `if_date` supports. `graceDays: 0` means "dated before
// today" — the scan belongs at the printer, so yesterday is already late.
export const NEVER_SCANNED_GRACE_DAYS = 0
// With Nestor. He packs and returns; a couple of days is normal handling, beyond that
// somebody should ask. Same 3-day instinct the register's `stale` flag already uses,
// kept identical on purpose so two surfaces cannot disagree about the same carton.
export const OUT_STALE_DAYS = 3

// `ifDate`   — the fulfilment's date (a date string; time of day is not available).
// `outAt`    — latest CUSTODY_OUT, or null.
// `inAt`     — latest CUSTODY_IN, or null.
// `today`    — injectable for tests.
export function scanGapFor({ ifNumber, ifDate, outAt = null, inAt = null, dcOutAt = null, dcInAt = null, today = new Date() } = {}) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null)
  const daysBetween = (a, b) => Math.floor((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86_400_000)
  const todayStr = day(today)

  // Whichever evidence the crew actually produced counts. The per-fulfilment IF scan is
  // preferred; the per-DC cargo tag stands in for the EDI lane, which is scanned that way.
  const hasIf = !!(outAt || inAt)
  const basis = hasIf ? 'IF' : ((dcOutAt || dcInAt) ? 'DC' : null)
  const useOut = hasIf ? outAt : dcOutAt
  const useIn = hasIf ? inAt : dcInAt
  const outT = useOut ? new Date(useOut).getTime() : 0
  const inT = useIn ? new Date(useIn).getTime() : 0

  // ③ back with us — the latest IN is at or after the latest OUT.
  if (inT && inT >= outT) {
    return { kind: SCAN_GAP.BACK_WITH_US, ok: true, basis,
      ageDays: day(useIn) ? daysBetween(day(useIn), todayStr) : 0,
      reason: basis === 'DC' ? 'scanned back in on its cargo tag' : 'scanned back in' }
  }
  // ② out and not back.
  if (outT) {
    const ageDays = daysBetween(day(useOut), todayStr)
    const stale = ageDays >= OUT_STALE_DAYS
    const on = basis === 'DC' ? ' (on its cargo tag)' : ''
    return {
      kind: SCAN_GAP.OUT_NOT_BACK, ok: !stale, ageDays, stale, basis,
      reason: stale
        ? `with Nestor ${ageDays}d${on}, never scanned back — ask for it`
        : `with Nestor ${ageDays}d${on}`,
    }
  }
  // ① never scanned at all. The one no existing surface can show.
  const d = day(ifDate)
  if (!d) {
    // No date to reason from. Silence beats a guess.
    return { kind: SCAN_GAP.OK, ok: true, ageDays: 0, reason: 'no fulfilment date to measure' }
  }
  const ageDays = daysBetween(d, todayStr)
  if (ageDays <= NEVER_SCANNED_GRACE_DAYS) {
    return { kind: SCAN_GAP.OK, ok: true, ageDays, reason: 'made today — scan it as it prints' }
  }
  return {
    kind: SCAN_GAP.NEVER_SCANNED, ok: false, ageDays, stale: true, basis: null,
    reason: `made ${ageDays}d ago and never scanned out — it was never handed over`,
  }
}

// Counts a surface can show. Separate kinds, never a total: each names a different
// action and a different person to ask.
export function summarizeScanGaps(verdicts = []) {
  const counts = { neverScanned: 0, outNotBack: 0, outStale: 0, backWithUs: 0, ok: 0 }
  for (const v of verdicts) {
    if (v.kind === SCAN_GAP.NEVER_SCANNED) counts.neverScanned++
    else if (v.kind === SCAN_GAP.OUT_NOT_BACK) { counts.outNotBack++; if (v.stale) counts.outStale++ }
    else if (v.kind === SCAN_GAP.BACK_WITH_US) counts.backWithUs++
    else counts.ok++
  }
  // ⚠️ What is genuinely a broken thread: never handed over, plus overdue at Nestor.
  // `backWithUs` is EXCLUDED — those are in our hands and other surfaces own them.
  counts.broken = counts.neverScanned + counts.outStale
  return counts
}
