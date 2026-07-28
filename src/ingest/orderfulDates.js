// src/ingest/orderfulDates.js
// Pure X12 parsing for an 850's ship-window dates — no DB, no network, so the
// model tests can import it directly. orderful.js re-exports these.
//
// The dates live in the DTM (date/time reference) segment of the 850's own
// transaction set, not on the list endpoint. But which X12 qualifier carries
// them is PARTNER-DEPENDENT — verified against real 850 bodies 2026-07-28
// (2+ each). Every partner uses the SAME header location, just a different code
// from one of two semantic families:
//   start  (window opens): 064 Do-Not-Deliver-Before · 037 Ship-Not-Before · 010 Requested-Ship
//   cancel (window closes): 001 Cancel-After · 063 Do-Not-Deliver-After
// Observed: Bloomingdale's 064/001 · Nordstrom 037/001 · Shopbop 064/063 ·
// Saks 010/001 · Neiman 037/063. So instead of one hardcoded qualifier per role
// we take the first present in each family's priority order — keeps the original
// 064/001 as the defaults, covers the others, and degrades gracefully for any
// future partner using a standard qualifier.

export const START_QUALIFIERS = ['064', '037', '010']
export const CANCEL_QUALIFIERS = ['001', '063']

const ediDate = (yyyymmdd) => (yyyymmdd ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null)

export function extractPoDates(message) {
  const dtms = message?.transactionSets?.[0]?.dateTimeReference || []
  const firstOf = (quals) => {
    for (const q of quals) {
      const hit = dtms.find((d) => d.dateTimeQualifier === q)?.date
      if (hit) return hit
    }
    return null
  }
  return { shipNotBefore: ediDate(firstOf(START_QUALIFIERS)), cancelAfter: ediDate(firstOf(CANCEL_QUALIFIERS)) }
}
