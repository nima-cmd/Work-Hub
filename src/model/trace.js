// The TRACE model — "looking at an item, get its full history" (Nima, 2026-08-20).
//
// One shape for every kind of thing the app knows: what happened to it, what the
// data says it relates to, what a human attached to it, and the notes on it. The
// Datapad renders this; a drawer will render the same object over any other view.
//
// This file is PURE. The SQL lives in server/queries.js and hands the raw rows
// here, because the rules below are the part that can be wrong in a way no
// screenshot reveals — and pure logic in a .jsx is untested logic (PR #64).
//
// ── The two rules this file exists to hold ──────────────────────────────────
//
// 1. RELATED and LINKED ARE NOT THE SAME KIND OF FACT, and they never merge.
//    RELATED is derived from the data (SO→IF→invoice→tracking) — free, always
//    right, and nobody's claim. LINKED is what a person attached by hand. Nima
//    was explicit that a link someone made must never read as one the data
//    implies, so they are assembled from different inputs into different arrays
//    and are labelled with their provenance on screen.
//
// 2. A REFERENCE IS NOT A RECORD. `fulfillments.invoice_number` is a string
//    written on the IF; it is not proof that invoice exists here. Minting a
//    hoppable card from it would offer a hop that dead-ends — and would assert a
//    document we have never seen. So a named-but-absent document is carried as a
//    `missing: true` mention that states where the name came from, never as a
//    link. This is the same class as every entry in fieldAssumptions.js: the
//    field said something the data did not.

import { accountFromTracking, isWholesaleAccount, isoDate } from './upsRates.js'

// The subjects a trace can be about. OC joined them once the Estimate→SalesOrd
// edge was ingested (2026-08-20), because two of the four order lanes START at an
// OC and a lane whose anchor you cannot open is not a group, just a label.
//
// ⚠️ Our FACTORY PO is still not here: it has its own spine (getPoLedger), and the
// OC↔PO edge that would connect it to an order is unpopulated (0 of 1,436 rows).
// ⚠️ THEIR_PO — the customer's PO — is deliberately NOT a trace type either. It is a
// reference on the order, not a document we hold, so it renders as a mention.
export const TRACE_TYPES = ['SO', 'IF', 'INV', 'OC', 'EMAIL', 'TASK']

// What each subject type is called, and the accent it carries. Tone NAMES, not
// hex — the palette belongs in the stylesheet, so a colour change is one file.
//
// `view` is the route key App.jsx switches on; `viewLabel` is what that tab is
// actually CALLED there. Both, because the two differ ('kanban' is the tab named
// "Mission Quests") and a button reading "Open in kanban" names a tab the app
// does not have.
export const TRACE_META = {
  SO: { label: 'Sales Order', tone: 'arrive', view: 'table', viewLabel: 'Table' },
  OC: { label: 'Order Confirmation', tone: 'edi', view: 'allocations', viewLabel: 'Inbound' },
  IF: { label: 'Fulfilment', tone: 'hands', view: 'kanban', viewLabel: 'Mission Quests' },
  INV: { label: 'Invoice', tone: 'money', view: 'table', viewLabel: 'Table' },
  EMAIL: { label: 'Transmission', tone: 'edi', view: 'transmissions', viewLabel: 'Transmissions' },
  TASK: { label: 'Task', tone: 'go', view: 'tasks', viewLabel: 'Tasks' },
  // Not subjects you can hop TO, but things that appear as related cards.
  TRACK: { label: 'Tracking', tone: 'holo', view: null },
  // ⚠️ TWO DIFFERENT THINGS, and the labels must never blur. THEIR_PO is the
  // customer's purchase order to us; PO is ours to the factory. Zero overlapping
  // values across all 322 orders — see src/model/orderLane.js.
  THEIR_PO: { label: "Customer's PO", tone: 'edi', view: 'edi', viewLabel: 'EDI' },
  PO: { label: 'Our factory PO', tone: 'hands', view: 'allocations', viewLabel: 'Inbound' },
}

export const toneFor = (docType) => TRACE_META[docType]?.tone || 'muted'
export const labelFor = (docType) => TRACE_META[docType]?.label || docType

// A trace reference, normalized. Throws rather than guessing, because a trace of
// the wrong subject looks exactly like a trace of the right one.
export function normalizeRef(docType, docNumber) {
  const type = String(docType || '').trim().toUpperCase()
  const number = String(docNumber ?? '').trim()
  if (!TRACE_TYPES.includes(type)) {
    throw new Error(`trace: ${type || '(blank)'} is not a traceable type (${TRACE_TYPES.join(', ')})`)
  }
  if (!number) throw new Error(`trace: a ${type} trace needs a document number`)
  return { docType: type, docNumber: number }
}

// Which kind of trace does this document number address?
//
// ⚠️ This reads OUR prefix, and that is legitimate here in a way it is NOT for a
// NetSuite URL. netsuiteLinks.js refuses to derive a NetSuite page name from the
// prefix because the page name is NetSuite's fact, not ours — but `orders.so_number`
// literally IS 'SO12296' and `fulfillments.if_number` IS 'IF7486', so the prefix is
// the primary key's own shape. It answers "which of MY tables", never "what does
// NetSuite think this is".
//
// Anything we cannot place returns null, and every caller must treat that as "no
// trace", never as a default type. A PO, an item receipt or a transfer order lands
// here and must keep whatever behaviour it had.
export function traceTypeFor(docNumber) {
  const s = String(docNumber || '').trim().toUpperCase()
  // INV before SO/IF only matters if a prefix were a prefix of another; they are not,
  // but the order is kept explicit so adding one later cannot silently shadow.
  if (/^INV\d/.test(s)) return 'INV'
  if (/^SO\d/.test(s)) return 'SO'
  if (/^IF\d/.test(s)) return 'IF'
  if (/^OC\d/.test(s)) return 'OC'
  return null
}

// ── Related cards ───────────────────────────────────────────────────────────

const card = (docType, docNumber, detail, extra = {}) => ({
  docType,
  docNumber: String(docNumber),
  detail: detail || null,
  tone: toneFor(docType),
  // Hoppable only when it is a type a trace can be ABOUT and the record exists.
  // A card the UI cannot open must not look clickable.
  hoppable: TRACE_TYPES.includes(docType) && !extra.missing,
  ...extra,
})

// A document named on another document but absent from our tables. It says WHERE
// the name came from, so "we don't have it" never reads as "it doesn't exist".
const mention = (docType, docNumber, namedOn) =>
  card(docType, docNumber, `named on ${namedOn} — not in the system`, { missing: true })

const money = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// A tracking card. The UPS account is DERIVED from the 1Z prefix and shown,
// because the two accounts are not interchangeable (upsRates.js) — a wholesale
// shipment reads 1Z**C6J610**… and mislabelling it misstates a real invoice.
// A non-1Z number gets no account claim at all rather than a guessed one.
export function trackingCard(tracking) {
  const t = String(tracking || '').trim()
  if (!t) return null
  const account = accountFromTracking(t)
  const detail = account
    ? `UPS · ${account}${isWholesaleAccount(account) ? ' (wholesale)' : ''}`
    : 'carrier not derivable from this number'
  return card('TRACK', t, detail, { url: `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}` })
}

// Fulfilment cards, with the invoice they NAME handled per rule 2 above.
export function fulfillmentCards(fulfillments = [], knownInvoices = []) {
  const known = new Set(knownInvoices.map((i) => String(i.invNumber || i.inv_number)))
  const out = []
  for (const f of fulfillments) {
    const status = [f.status, f.packedStatus].filter(Boolean).join(' · ')
    out.push(card('IF', f.ifNumber, status || 'fulfilment'))
    for (const t of f.trackingNumbers || []) {
      const c = trackingCard(t)
      if (c) out.push(c)
    }
    const named = f.invoiceNumber && String(f.invoiceNumber).trim()
    if (named && !known.has(named)) out.push(mention('INV', named, f.ifNumber))
  }
  return out
}

export const invoiceCards = (invoices = []) =>
  invoices.map((i) => card('INV', i.invNumber, [i.status, money(i.amountRemaining) && `${money(i.amountRemaining)} open`]
    .filter(Boolean).join(' · ') || 'invoice'))

export const taskCards = (tasks = []) =>
  tasks.map((t) => card('TASK', t.id, [t.status === 'done' ? 'done' : 'open', isoDate(t.completedAt || t.createdAt)]
    .filter(Boolean).join(' · '), { title: t.subject || null }))

export const emailCards = (emails = []) =>
  emails.map((e) => card('EMAIL', e.id, [e.fromName || e.fromAddress, isoDate(e.receivedAt)]
    .filter(Boolean).join(' · '), { title: e.subject || null }))

// Order/SO card, used when the subject is a child of one.
export const orderCard = (order) =>
  (order ? card('SO', order.soNumber, [order.customer, order.stage].filter(Boolean).join(' · ') || 'sales order') : null)

// De-dupe by identity, keeping the FIRST occurrence — the earlier producer is
// the more specific one (a real invoice row beats a mention of the same number).
// Without this, an SO with two IFs naming the same invoice showed it twice, and
// a mention could out-rank the record.
export function dedupeCards(cards = []) {
  const seen = new Set()
  const out = []
  for (const c of cards.filter(Boolean)) {
    const key = `${c.docType}:${c.docNumber}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

// ── Linked (human-attached) ─────────────────────────────────────────────────

// doc_links rows → linked entries. `url` set means an EXTERNAL document (a Google
// Doc, a Drive file); otherwise it is a doc↔doc link inside the app, which IS
// hoppable when it names a traceable type.
export function linkedEntries({ docLinks = [], emailLinks = [] } = {}) {
  const out = []
  for (const l of docLinks) {
    const external = !!l.url
    out.push({
      kind: external ? 'external' : 'doc',
      label: l.label || l.bNumber || l.url,
      docType: external ? null : l.bType,
      docNumber: external ? null : l.bNumber,
      url: l.url || null,
      host: external ? hostOf(l.url) : null,
      hoppable: !external && TRACE_TYPES.includes(String(l.bType || '').toUpperCase()),
      id: l.id,
      createdAt: l.createdAt || null,
    })
  }
  for (const e of emailLinks) {
    out.push({
      kind: 'email',
      label: e.subject || e.fromAddr || 'linked mail',
      docType: null,
      docNumber: null,
      url: e.gmailUrl,
      // Derived, not assumed 'gmail' — some email links are a pasted URL for mail
      // that was never synced (addEmailLinkFor's third fallback), and calling that
      // Gmail names a place the link does not go.
      host: hostOf(e.gmailUrl),
      hoppable: false,
      id: `mail-${e.id}`,
      createdAt: e.createdAt || null,
    })
  }
  return out
}

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(String(url || ''))
  return m ? m[1].replace(/^www\./, '') : null
}

// ── The hop trail ───────────────────────────────────────────────────────────

// The trail is the way back (`EMAIL › TASK 58289 › SO12296`). It is a CLIENT-side
// history of where you actually walked, not a derived path — deriving it would
// show a route nobody took. This trims it and collapses a revisit, so hopping
// A→B→A leaves one A rather than growing forever.
export const TRAIL_MAX = 6

export function pushTrail(trail = [], ref) {
  const { docType, docNumber } = ref
  const at = trail.findIndex((t) => t.docType === docType && t.docNumber === docNumber)
  // Revisiting something already on the trail rewinds to it instead of appending.
  if (at >= 0) return trail.slice(0, at + 1)
  return [...trail, { docType, docNumber }].slice(-TRAIL_MAX)
}

// ── Assembly ────────────────────────────────────────────────────────────────

// Build the whole trace object from raw parts. Every caller passes the same shape
// so the five subject types share one renderer.
//
// ⚠️ `history` arrives already ordered and labelled by the ledger's own decorate/
// timeline helpers — this does not re-sort it. Two sorts on one list is how a
// timeline starts disagreeing with the view it came from.
export function buildTrace({ subject, history = [], related = [], linked = {}, notes = [], filed = [] }) {
  return {
    subject: {
      ...subject,
      tone: toneFor(subject.docType),
      typeLabel: labelFor(subject.docType),
      view: TRACE_META[subject.docType]?.view || null,
      viewLabel: TRACE_META[subject.docType]?.viewLabel || null,
    },
    history,
    related: dedupeCards(related).filter((c) => !isSelf(c, subject)),
    linked: linkedEntries(linked),
    // ⚠️ ITS OWN KEY, not folded into `related`. A filed PDF is a DOCUMENT WE HOLD,
    // not another transaction the trace inferred — this repo's rule that a reference
    // is not a record, applied to paper. Listing a scan beside an invoice would say
    // they are the same kind of thing.
    filed,
    notes,
    counts: {
      history: history.length,
      related: dedupeCards(related).filter((c) => !isSelf(c, subject)).length,
      linked: linkedEntries(linked).length,
      filed: filed.length,
      notes: notes.length,
    },
  }
}

// A trace never lists itself as related to itself.
const isSelf = (c, subject) => c.docType === subject.docType && c.docNumber === String(subject.docNumber)
