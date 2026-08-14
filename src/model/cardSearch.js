// src/model/cardSearch.js — find a card on the Mission Quests board.
//
// Nima, 2026-08-14: "how hard would it be to have a filter and search on the kanban to
// search for certain things."
//
// ── What it searches, and why that list ─────────────────────────────────────
//
// The board is keyed on a sales order, but almost nothing arriving from the outside
// world is. A carrier asks about a tracking number, Bloomingdale's asks about a PO, a
// store asks about an invoice, and the warehouse asks about the IF on the paperwork in
// their hand. Searching only the SO number would answer none of those.
//
// So every identifier a human might arrive holding is matched, including the ones on
// the card's CHILD documents — fulfilments and invoices — because "IF7511" is the most
// likely thing to be typed and it is not a property of the order at all.
//
// ⚠️ Prefixes are optional and noise is stripped: NetSuite prints `IF7511`, people
// write `if 7511`, and a PO arrives as `PO 8298615`. All three must find the card, or
// the box is a puzzle rather than a tool.

/** Normalise for comparison: lowercase, and strip anything that is not alphanumeric. */
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Every string on a card worth matching against. Flattened once per card so a
 * keystroke does not re-walk the object graph.
 */
export function searchableText(o = {}) {
  const parts = [
    o.soNumber, o.poNumber, o.customer, o.dc, o.storeNumber, o.location,
    o.stage, o.stageLabel, o.source, o.notes,
  ]
  // ⚠️ EDI orders are GROUPED BY PO on this board, so a group card's own `soNumber` is
  // the PO and the real sales orders live in `soNumbers` / `members`. Without these,
  // typing SO12440 — a genuine order, on screen — answered "nothing matches", because
  // the card standing in for it is called 8298615.
  for (const n of o.soNumbers || []) parts.push(n)
  for (const m of o.members || []) parts.push(m.soNumber, m.customer, m.poNumber)
  for (const f of o.fulfillments || []) parts.push(f.ifNumber, f.invoice, f.trackingNumber)
  for (const i of o.invoices || []) parts.push(i.invNumber)
  // Flags carry the words a human actually remembers ("short", "stale", "label"), so
  // "label" finding every card that needs one is a genuinely useful search.
  for (const f of o.flags || []) parts.push(f.key, f.label)
  return parts.filter(Boolean).map(String)
}

// Document prefixes people type but the stored value may not repeat.
// ⚠️ `PO 8298615` is the case that caught this out: split into words and ANDed, the
// bare token "po" appears NOWHERE in the data (the column holds `8298615`), so the
// most natural way to type a PO found nothing. A search box that fails on the obvious
// input is worse than none, because it teaches you the record is missing.
const DOC_PREFIX = /^(inv|if|so|po|nb|dc)(?=\d)/

/**
 * Does this card match the query?
 *
 * Three ways to match, in order of how people actually type:
 *   · every word matches something — "bloomingdale secaucus" NARROWS, which is what
 *     typing two things means, and each word may hit a different field;
 *   · the whole query as one token, so "SO-12440" survives its punctuation;
 *   · that token with a leading document prefix stripped, so "PO 8298615" finds a
 *     column that stores only the digits.
 */
export function matchesQuery(o, query) {
  const q = String(query ?? '').trim()
  if (!q) return true
  const words = q.split(/\s+/).map(norm).filter(Boolean)
  if (!words.length) return true
  const hay = (o.__search || searchableText(o)).map(norm)
  const hit = (w) => hay.some((h) => h.includes(w))

  if (words.every(hit)) return true
  const joined = norm(q)
  if (joined && hit(joined)) return true
  const stripped = joined.replace(DOC_PREFIX, '')
  return !!stripped && stripped !== joined && hit(stripped)
}

/**
 * Attach the flattened text once, so filtering a large board while typing does not
 * rebuild it per keystroke per card.
 */
export function indexCards(orders = []) {
  return orders.map((o) => (o.__search ? o : Object.assign(o, { __search: searchableText(o) })))
}

/** A one-line summary for the UI — never just a shorter list with no explanation. */
export function describeMatch({ shown, total, query }) {
  if (!String(query ?? '').trim()) return null
  if (!shown) return `nothing matches “${query}”`
  return `${shown} of ${total} match “${query}”`
}
