// src/model/bolSequence.js — is the BOL sequence ahead of every number ever minted?
//
// A BOL number must NEVER be reused (bol_registry exists for that single purpose, and
// voiding a shipment deliberately leaves its number behind). The generator is
// `'NB' || nextval('bol_number_seq')`, so the guarantee holds only while the sequence
// is strictly ahead of the registry.
//
// It stopped being ahead. The DigitalOcean cutover copied bol_registry and left the
// sequence at 1731240 while the registry held up to NB1731267 — 27 collisions queued
// up, one per BOL attempt. Neither copy tool advanced it, because both discover
// sequences with pg_get_serial_sequence(), which only returns COLUMN-OWNED sequences
// and this one is standalone.
//
// ⚠️ Pure, so the verdict can be tested and reused by the fixer and the health check
// without either re-deriving "behind" in SQL and drifting from the other.

/**
 * @param lastValue  bol_number_seq.last_value (pg returns bigint as a STRING)
 * @param isCalled   bol_number_seq.is_called
 * @param maxUsed    highest numeric BOL in bol_registry, or null when empty
 */
export function bolSequenceVerdict({ lastValue, isCalled, maxUsed } = {}) {
  // ⚠️ Coerce. pg hands bigint back as text and '1731240' + 1 === '17312401'.
  const last = Number(lastValue)
  const max = maxUsed == null ? null : Number(maxUsed)
  // is_called=false means last_value has NOT been handed out yet, so it is next.
  const next = isCalled ? last + 1 : last
  const behind = max != null && next <= max
  return {
    next,
    maxUsed: max,
    behind,
    // How many attempts would collide before the sequence climbs clear.
    collisions: behind ? max - next + 1 : 0,
    // What last_value must become so the NEXT number is above everything minted.
    shouldBe: behind ? max : last,
  }
}
