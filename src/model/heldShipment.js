// src/model/heldShipment.js — a shipment sitting in the warehouse, as a calendar entry.
//
// Nima, 2026-08-26: "keep track of ones that haven't shipped as current to that day and
// then move them to ship when they shipped ... i think it requires a third calendar."
// And: "we will need to not look at its status in netsuite but in the app cause those 10
// must be in our possession pending payment or an invoice and sitting in the warehouse."
//
// ⚠️ THERE IS NO HONEST "EXPECTED SHIP DATE", WHICH IS WHY THIS SITS ON TODAY.
// `orders.ship_date` is `orders.start_date + 28` on 100% of 338 rows — measured by
// npm run check:fields, and already in fieldAssumptions.js as the field that drove 51
// bad flags. Dating a calendar entry with it would publish a fabricated date to the
// warehouse. Today is not a prediction, so it cannot be wrong.
//
// ⚠️ AND THE DAY COUNTER IS A FLOOR, NOT A MEASUREMENT, whenever the only evidence is
// PACKED. schema.sql says it plainly: PACKED / INVOICED / PAID have no recorded date
// anywhere in NetSuite, so their occurred_at is when the SYNC FIRST SAW that state. A
// custody scan is a real moment; "packed" is a state we noticed. The wording changes to
// match — "held at least N days" — because a precise-looking number from an imprecise
// source is exactly the shape this repo keeps paying for.

/** How possession was established, strongest first. */
export const BASIS = {
  CUSTODY_IN: 'custody-in',   // a QR scan — a physical fact, with a real timestamp
  IF_CREATED: 'if-created',   // fulfillments.if_date — a real date from NetSuite
  PACKED: 'packed',           // observed state only; the date is when we first saw it
}

export const BASIS_LABEL = {
  [BASIS.CUSTODY_IN]: 'scanned in',
  [BASIS.IF_CREATED]: 'fulfilment created',
  [BASIS.PACKED]: 'first seen packed',
}

/** ⚠️ Only a custody scan carries a moment we witnessed. The rest are approximations. */
export const BASIS_EXACT = { [BASIS.CUSTODY_IN]: true, [BASIS.IF_CREATED]: true, [BASIS.PACKED]: false }

export const REASON = {
  AWAITING_PAYMENT: 'awaiting-payment',
  AWAITING_INVOICE: 'awaiting-invoice',
  UNKNOWN: 'unknown',
}

export const REASON_LABEL = {
  [REASON.AWAITING_PAYMENT]: 'awaiting payment',
  [REASON.AWAITING_INVOICE]: 'awaiting an invoice',
  // ⚠️ NOT "ready to ship". We know it is here and not gone; we do NOT know why. Naming
  // an unknown as a status is how a default becomes a claim nobody made.
  [REASON.UNKNOWN]: 'no reason recorded',
}

const iso = (v) => {
  if (!v) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/** Whole days between two plain days. ⚠️ UTC arithmetic on dateless days — see nextDay. */
export function daysBetween(fromIso, toIso) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromIso || ''))
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toIso || ''))
  if (!a || !b) return null
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000)
}

/**
 * When did this come into our possession, and how do we know?
 * @param ev { custodyInAt, ifDate, packedAt }
 */
export function heldSince(ev = {}) {
  if (ev.custodyInAt) return { date: iso(ev.custodyInAt), basis: BASIS.CUSTODY_IN }
  if (ev.ifDate) return { date: iso(ev.ifDate), basis: BASIS.IF_CREATED }
  if (ev.packedAt) return { date: iso(ev.packedAt), basis: BASIS.PACKED }
  return { date: null, basis: null }
}

/** What is it waiting on? @param ev { invoiced, paid } */
export function holdReason(ev = {}) {
  if (!ev.invoiced) return REASON.AWAITING_INVOICE
  if (!ev.paid) return REASON.AWAITING_PAYMENT
  return REASON.UNKNOWN
}

/**
 * The stable event id.
 *
 * ⚠️ THE SAME KEY THE SHIPPED EVENT WILL USE, so the move is a fact rather than a
 * guess: one key present in the held calendar AND now publishable on a shipped one is
 * unambiguously the same shipment, and the held copy can be removed.
 *
 * ⚠️ SO-KEYED WHEN THERE IS NO PO, because 10 of 21 scanned boutique shipments carry no
 * po_number at all — a PO-only scheme cannot represent them, and they are most of this
 * calendar. Drive files boutique paperwork under the SO too, so the two agree.
 *
 * ⚠️ base32hex: a–v and 0–9 only (see shipmentCalendar.js), so 'po'/'so' are safe
 * prefixes and everything else is filtered rather than trusted.
 */
export function shipmentKey({ po, so } = {}) {
  const clean = (v) => String(v || '').toLowerCase().replace(/[^a-v0-9]/g, '')
  // ⚠️ The identifier often ALREADY carries the prefix — an SO number is literally
  // "SO12344", so a naive `so${clean(so)}` yields "soso12344". Harmless as an opaque id
  // right up until someone reads one in a URL or matches it against the shipped
  // calendar's key by eye, which is exactly what the move will be debugged with.
  const pre = (prefix, v) => {
    const c = clean(v)
    if (!c) return null
    return c.startsWith(prefix) ? c : `${prefix}${c}`
  }
  return (po && pre('po', po)) || (so && pre('so', so)) || null
}

/**
 * Build the held event. Returns null when there is nothing honest to say.
 * @param todayIso the day the entry sits on — "current to that day"
 */
export function heldEvent({ so, po, ifNumber, customer, events = {}, todayIso } = {}) {
  const key = shipmentKey({ po, so })
  if (!key || !todayIso) return null

  const since = heldSince(events)
  const reason = holdReason(events)
  const days = since.date ? daysBetween(since.date, todayIso) : null
  const exact = since.basis ? BASIS_EXACT[since.basis] : false

  // ⚠️ "at least" whenever the date is a first-observation rather than a witnessed
  // moment. A counter that looks precise and is not is worse than a vaguer true one.
  // ⚠️ "held 0 days" is technically true and reads as a bug to anyone scanning a list.
  // Same fact, said the way a person would say it.
  const counter = days === null ? null
    : days === 0 ? (exact ? 'arrived today' : 'first seen today')
    : `held ${exact ? '' : 'at least '}${days} day${days === 1 ? '' : 's'}`

  const who = customer || so || po
  const summary = `${who} ${po || so} — in the warehouse`
    + (counter ? ` (${counter})` : '')

  const lines = []
  lines.push(`Status: ${REASON_LABEL[reason]}`)
  if (since.date) {
    lines.push(`In our possession since ${since.date} (${BASIS_LABEL[since.basis]})`)
    if (!exact) {
      lines.push('⚠ That date is when the sync first SAW this state, not a recorded event —')
      lines.push('  NetSuite stores no timestamp for it, so the count is a minimum.')
    }
  } else {
    lines.push('⚠ No date recorded for when this came into our possession.')
  }
  lines.push('')
  lines.push(`Sales order: ${so || '—'}${po ? `    PO: ${po}` : ''}`)
  if (ifNumber) lines.push(`Fulfilment: ${ifNumber}`)
  lines.push('')
  // ⚠️ Says what this entry IS, because it is on a shared calendar next to two
  // calendars of real shipments. A reader must never mistake it for one.
  lines.push('This shipment has NOT shipped. The entry moves to today until it does,')
  lines.push('then moves to the EDI or Boutique calendar on its real ship date.')

  return {
    key, date: todayIso, reason, daysHeld: days, exact,
    heldSince: since.date, basis: since.basis,
    summary, description: lines.join('\n').trim(),
  }
}
