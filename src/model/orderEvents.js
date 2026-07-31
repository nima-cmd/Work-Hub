// src/model/orderEvents.js — the order-event spine.
//
// The roadmap's item A always had two halves. The QR-custody half shipped in
// July: scan an IF out to the warehouse, scan it back in, capture its cartons.
// This is the other half — the part that makes `order_events` a *ledger* rather
// than a custody log.
//
// Until now the table held four incidental event types (custody scans, a
// shipped-dollar snapshot, an approved-for-shipping marker) and not one document
// transition. So the ledger could not answer the questions it exists to answer:
// "what happened to SO12293", "what moved on Tuesday", "did this task's work
// actually occur". This module derives those transitions from the document state
// the app already syncs out of NetSuite and Orderful.
//
// ── The one rule that shapes everything here: honest timestamps ──────────────
//
// Some transitions carry a real date in the source data (an IF's ship date, an
// 856's transmission time). Others do not — nothing in NetSuite records *when* an
// invoice was raised or when a fulfilment flipped to Packed; we only ever see the
// state it is in right now. Those two are not the same fact and must not be
// stored as though they were.
//
// So every derived event is tagged:
//   • 'actual'   — occurred_at came from a real timestamp in the source row.
//   • 'observed' — occurred_at is when WE first saw the document in this state.
//
// The backfill writes 'actual' events ONLY. Backfilling 'observed' ones would
// stamp 98 invoices and 83 shipments with today's date and quietly invent a
// history that never happened — the Calendar would show a fictional Tuesday.
// Going forward, a normal sync writes both, and an 'observed' timestamp is then
// accurate to within one sync interval, which is honest and useful.
//
// Nothing here talks to a database, so all of it is unit-testable.

// Ordered spine, roughly the path a boutique order walks. `key` is the stored
// event_type; order matters only for display.
export const SPINE = [
  { key: 'SO_IMPORTED', docType: 'SO', label: 'Sales order imported' },
  { key: 'IF_CREATED', docType: 'IF', label: 'Fulfilment created' },
  { key: 'CUSTODY_OUT', docType: 'IF', label: 'Handed to the warehouse' },
  { key: 'CUSTODY_IN', docType: 'IF', label: 'Back from the warehouse' },
  { key: 'PACKED', docType: 'IF', label: 'Packed' },
  { key: 'INVOICED', docType: 'INV', label: 'Invoiced' },
  { key: 'REACHED_APPROVED', docType: 'IF', label: 'Approved for shipping' },
  { key: 'PAID', docType: 'INV', label: 'Paid in full' },
  { key: 'ROUTED', docType: 'DC', label: 'Routed (BOL generated)' },
  { key: 'DEPARTED', docType: 'IF', label: 'Departed' },
  { key: 'ASN_SENT', docType: 'PO', label: '856 transmitted' },
  { key: 'INVOICE_SENT', docType: 'PO', label: '810 transmitted' },
]

export const SPINE_ORDER = new Map(SPINE.map((s, i) => [s.key, i]))
export const SPINE_LABEL = new Map(SPINE.map((s) => [s.key, s.label]))

// Event types this module owns. CUSTODY_* and REACHED_APPROVED are in the spine
// for display but are written elsewhere (scan handlers, stampApprovedForShipping)
// — deriving them here too would double-write them.
export const DERIVED_TYPES = [
  'SO_IMPORTED', 'IF_CREATED', 'PACKED', 'INVOICED',
  'PAID', 'ROUTED', 'DEPARTED', 'ASN_SENT', 'INVOICE_SENT',
]

// Identity of an event for dedupe purposes: one of each type per document, ever.
// Deliberately excludes occurred_at — re-running a sync must not append a second
// DEPARTED because the ship date was corrected upstream.
export const eventKey = (e) => `${e.eventType}|${e.docType}|${e.docNumber}`

const isShipped = (s) => /shipped/i.test(String(s || ''))
const isPacked = (s) => /packed/i.test(String(s || ''))
const isPaid = (s) => /paid in full/i.test(String(s || ''))
const soOrNull = (so) => (so && so !== 'UNLINKED' ? so : null)

// A date that Postgres handed us as a JS Date, a string, or nothing. Returns a
// Date or null — never an Invalid Date, which would insert as NULL and silently
// lose the event's place in history.
function asDate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// One derived event. `occurredAt: null` means "no real timestamp" and forces
// tsQuality 'observed' — the caller supplies `now`.
function evt(eventType, docType, docNumber, soNumber, occurredAt, note = null) {
  const at = asDate(occurredAt)
  return {
    eventType,
    docType,
    docNumber: String(docNumber),
    soNumber: soOrNull(soNumber),
    occurredAt: at,
    tsQuality: at ? 'actual' : 'observed',
    note,
  }
}

// ── Per-table derivation ─────────────────────────────────────────────────────

// orders → SO_IMPORTED. first_seen is genuinely when the app first saw the order,
// which is the closest honest thing to "imported"; it is not the NetSuite entry
// date, and the note says so rather than letting a reader assume otherwise.
export function eventsFromOrders(orders = []) {
  const out = []
  for (const o of orders) {
    if (!o.soNumber) continue
    out.push(evt('SO_IMPORTED', 'SO', o.soNumber, o.soNumber, o.firstSeen, 'first seen by the tracker'))
  }
  return out
}

// fulfillments → IF_CREATED, PACKED, DEPARTED.
//
// PACKED is emitted only while the IF is *currently* Packed. An IF that has
// already shipped was obviously packed at some point, but nothing records when —
// inventing that date is exactly the dishonesty this module is built to avoid.
// Those IFs simply have no PACKED event, and the ledger is clear about it.
export function eventsFromFulfillments(fulfillments = []) {
  const out = []
  for (const f of fulfillments) {
    if (!f.ifNumber) continue
    out.push(evt('IF_CREATED', 'IF', f.ifNumber, f.soNumber, f.ifDate))
    if (isPacked(f.status)) out.push(evt('PACKED', 'IF', f.ifNumber, f.soNumber, null))
    if (isShipped(f.status)) {
      // actual_ship_date is the real departure. Without one we still know it
      // departed, so record it as observed rather than dropping the event.
      out.push(evt('DEPARTED', 'IF', f.ifNumber, f.soNumber, f.actualShipDate))
    }
  }
  return out
}

// invoices → INVOICED, PAID. Neither carries a creation timestamp in NetSuite's
// saved-search shape, so both are observed. ship_date is NOT used as a stand-in:
// it is the shipment's date, not the invoice's, and conflating them would put
// money events on the wrong day.
export function eventsFromInvoices(invoices = []) {
  const out = []
  for (const i of invoices) {
    if (!i.invNumber) continue
    out.push(evt('INVOICED', 'INV', i.invNumber, i.soNumber, null))
    if (isPaid(i.status)) out.push(evt('PAID', 'INV', i.invNumber, i.soNumber, null))
  }
  return out
}

// routing_shipment → ROUTED, keyed on the DC/PO key the custody scans already
// use as doc_number, so a DC's scans and its routing sit on one timeline.
//
// "Routed" is the moment the retailer's routing authorization lands, not the
// moment we print paperwork — so authorizedAt (routing_auth.created_at) is the
// preferred date, with the BOL-generation time as a fallback for shipments that
// got a BOL without an auth row. Gating on BOL generation alone would have made
// this event type permanently empty: all 12 current shipments carry a BOL
// *number* and none has ever been generated through the app.
export function eventsFromRouting(shipments = []) {
  const out = []
  for (const s of shipments) {
    if (!s.dcPoKey) continue
    const routedAt = s.authorizedAt || s.bolGeneratedAt
    if (!routedAt) continue
    const note = [s.authNumber && `auth ${s.authNumber}`, s.bolNumber && `BOL ${s.bolNumber}`]
      .filter(Boolean).join(' · ') || null
    out.push(evt('ROUTED', 'DC', s.dcPoKey, null, routedAt, note))
  }
  return out
}

// edi_transactions → ASN_SENT / INVOICE_SENT, at PO level (a business number can
// span several SOs, so the PO is the honest key — see the roadmap's item C).
//
// Outbound + LIVE only: an inbound 850's transmission is the partner's event, and
// the TEST stream must never reach the real ledger.
//
// Note "sent" here means transmitted to Orderful, which is NOT the same as
// delivered to the partner — that gap is precisely the 62-undelivered-ASN problem
// (see src/model/ediDelivery.js). The ledger records transmission; delivery is a
// separate question with its own answer.
export function eventsFromEdi(transactions = []) {
  const out = []
  for (const t of transactions) {
    if (String(t.direction || '').toUpperCase() !== 'OUT') continue
    if (String(t.stream || '').toUpperCase() !== 'LIVE') continue
    if (!t.businessNumber) continue
    const type = String(t.type || '')
    const eventType = type.startsWith('856') ? 'ASN_SENT' : type.startsWith('810') ? 'INVOICE_SENT' : null
    if (!eventType) continue
    out.push(evt(eventType, 'PO', t.businessNumber, null, t.createdAt, t.tradingPartner || null))
  }
  return out
}

// ── Assembly ─────────────────────────────────────────────────────────────────

// snapshot: { orders, fulfillments, invoices, routing, edi } — each an array of
// the rows currently in Neon, camelCased.
export function deriveEvents(snapshot = {}) {
  return [
    ...eventsFromOrders(snapshot.orders),
    ...eventsFromFulfillments(snapshot.fulfillments),
    ...eventsFromInvoices(snapshot.invoices),
    ...eventsFromRouting(snapshot.routing),
    ...eventsFromEdi(snapshot.edi),
  ]
}

// What actually needs inserting.
//
// `known` is a Set of eventKey() strings already in the table. `mode` is
// 'sync' (write everything new) or 'backfill' (write only real timestamps —
// see the honest-timestamps note at the top of this file).
//
// Also dedupes within the batch itself: two rows in one snapshot can imply the
// same event, and a plain INSERT would happily write both.
export function pendingEvents(derived = [], known = new Set(), { mode = 'sync', now = new Date() } = {}) {
  const seen = new Set()
  const out = []
  for (const e of derived) {
    if (mode === 'backfill' && e.tsQuality !== 'actual') continue
    const k = eventKey(e)
    if (known.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push({ ...e, occurredAt: e.occurredAt ?? now })
  }
  return out
}

// Counts by event type, for the dry-run report and the sync log line.
export function summarize(events = []) {
  const by = {}
  for (const e of events) by[e.eventType] = (by[e.eventType] || 0) + 1
  return by
}

// One document's history, oldest first — the shape the Ledger view wants.
// Ties break on spine position so IF_CREATED never renders below the PACKED that
// shares its date, which is what happens when the source only stores a DATE.
export function timeline(events = []) {
  return [...events].sort((a, b) => {
    const ta = asDate(a.occurredAt)?.getTime() ?? 0
    const tb = asDate(b.occurredAt)?.getTime() ?? 0
    if (ta !== tb) return ta - tb
    return (SPINE_ORDER.get(a.eventType) ?? 99) - (SPINE_ORDER.get(b.eventType) ?? 99)
  })
}
