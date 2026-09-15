// src/model/containerAlias.js — one container, however it is spelled.
//
// ⚠️ NOT containerIdentity.js, WHICH ALREADY EXISTS AND IS A DIFFERENT QUESTION. That
// module MINTS the canonical label from a filename and a date, and every NetSuite
// External ID is built from it. This one takes a label as given and answers "which
// container is this name?" — the reverse direction.
//
// I wrote this file over it. Three modules import `containerLabel` from there and the
// suite caught it immediately; it is restored and this is the module that moved.
//
// Nima, 2026-09-15: "have it all container within one entity in the app as one
// container." The obstacle is that a container arrives under four names and we stored
// one of them.
//
// ⚠️ THE CANONICAL NAME IS THE PACKING SLIP'S LABEL, by his decision — aliases rather
// than a re-key. It is a filename artifact (the 59-carton container's identity contains
// "(1)" from a duplicate download) and that is accepted: it is stable, four tables
// cascade off it, and `display_name` is what anyone actually reads.

/** Where a name was observed. An alias's authority depends on this. */
export const ALIAS_SOURCES = {
  slip: 'the packing slip label — the canonical name',
  filename: 'the spreadsheet the slip was imported from',
  memo: "a NetSuite transfer order's memo",
  forwarder: "the forwarder's shipment reference",
  tracking: 'a carrier tracking number',
  entered: 'typed by a person',
}

/**
 * The structural key a container label and a TO memo both produce: count + date.
 *
 * ⚠️ THIS IS FOR DISCOVERING AN ALIAS, NOT FOR MATCHING ON EVERY SYNC. Once a name is
 * found this way it is WRITTEN DOWN as an alias, so the next sync matches on recorded
 * data rather than re-deriving a guess. A structural match is a hypothesis; an alias row
 * is a fact somebody can look at and correct.
 */
export function structuralKey(label) {
  const s = String(label ?? '').trim()
  const count = s.match(/^\s*(\d+)\b/)
  const date = s.match(/(\d{4}\.\d{1,2}\.\d{1,2})\s*$/)
  if (!count || !date) return null
  return `${Number(count[1])}|${date[1]}`
}

/**
 * A readable name, derived when nobody has entered one.
 *
 * "59 cartons LCL to LA INVOICE&PL (1) carton 2026.8.17" → "59 cartons · 17 Aug 2026"
 *
 * ⚠️ AN ENTERED NAME IS NEVER RECOMPUTED. If someone has called it something, that is
 * the name — the standing entered-beats-derived rule.
 */
export function displayNameFor(label, entered = null) {
  if (entered && String(entered).trim()) return String(entered).trim()
  const s = String(label ?? '').trim()
  if (!s) return null
  const count = s.match(/^\s*(\d+)\b/)
  const date = s.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\s*$/)
  const air = /\bair\b/i.test(s)
  const bits = []
  if (count) bits.push(`${count[1]} carton${count[1] === '1' ? '' : 's'}${air ? ' by air' : ''}`)
  if (date) {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    bits.push(`${Number(date[3])} ${MON[Number(date[2]) - 1]} ${date[1]}`)
  }
  // ⚠️ Falls back to the raw label rather than to nothing. An unparseable label is still
  // the only name that container has.
  return bits.length ? bits.join(' · ') : s
}

/**
 * Every name a container should answer to, from what we hold about it.
 *
 * ⚠️ IT RETURNS SOURCES, NOT JUST STRINGS. Two aliases can disagree — a memo saying one
 * thing and a person another — and which to trust is a question about where each came
 * from, so the origin travels with the name.
 */
export function aliasesFor({ label, filename = null, memos = [], forwarderRef = null, trackingNumber = null } = {}) {
  const out = []
  const add = (alias, source) => {
    const a = String(alias ?? '').trim()
    if (!a) return
    if (out.some((x) => x.alias === a)) return
    out.push({ alias: a, source })
  }
  add(label, 'slip')
  add(filename, 'filename')
  for (const m of memos) add(m, 'memo')
  add(forwarderRef, 'forwarder')
  add(trackingNumber, 'tracking')
  return out
}

/**
 * Resolve any name to its canonical container.
 *
 * ⚠️ RECORDED ALIASES FIRST, STRUCTURE ONLY AS A LAST RESORT — and a structural hit is
 * returned marked as such so the caller can write it down rather than rely on deriving
 * it again. A structural key shared by two containers resolves to NEITHER: attaching
 * real freight to the wrong container is worse than failing to attach it.
 */
export function resolveContainer(name, { aliases = new Map(), labels = [] } = {}) {
  const n = String(name ?? '').trim()
  if (!n) return { label: null, how: null }
  if (aliases.has(n)) return { label: aliases.get(n), how: 'alias' }

  const key = structuralKey(n)
  if (!key) return { label: null, how: null }
  const hits = labels.filter((l) => structuralKey(l) === key)
  if (hits.length === 1) return { label: hits[0], how: 'structure', key }
  if (hits.length > 1) {
    return { label: null, how: 'ambiguous', key, candidates: hits }
  }
  return { label: null, how: null }
}
