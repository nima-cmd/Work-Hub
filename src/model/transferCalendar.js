// src/model/transferCalendar.js — a transfer as a calendar entry.
//
// Nima, 2026-08-27: "we want them on the calendar." A transfer to the Office or to
// Consignment is freight leaving the building; it just has no customer.
//
// ⚠️ ONE LANE OWNS THE WHOLE LIFE. A transfer is deliberately excluded from the
// warehouse calendar (see loadHeldCandidates) rather than half-represented in two
// places, so this covers both states:
//
//   not yet shipped   dated TODAY, rolling forward, like the warehouse calendar
//   shipped           dated the day it went, and it stays there
//
// ⚠️ THE SHIP DATE IS if_date, AND actual_ship_date IS NOT AN OPTION. It is NULL on all
// 14 tracked transfers — NetSuite never sets it for this document type. if_date is the
// fulfilment's own transaction date, and fieldAssumptions.js already records that
// if_date equals actual_ship_date on every shipped sales-order fulfilment. So it is the
// same fact, from the only column that carries it here.
//
// ⚠️ AND "RECEIVED" IS THE OTHER END'S WORD, WHICH IS THE POINT. Nima: "sometimes they
// dont receive on their end and so it be helpful to know when they got it." So an
// unreceived transfer is reported as NOT CONFIRMED RECEIVED — never as "not delivered",
// which would state something we do not know.

import { isReceived } from './transferOrder.js'
import { isoPlainDay } from './shipmentCalendar.js'
import { daysBetween } from './heldShipment.js'

export const STATE = {
  NOT_SHIPPED: 'not-shipped',
  // ⚠️ MARKED SHIPPED IS NOT GONE. Nima, 2026-08-27: "these are marked as shipped when
  // the label is created normally so we dont forget." Measured the same day: 11
  // transfers read Shipped, THREE have a label and ZERO have an actual_ship_date. So
  // the status is a bookkeeping mark and eight of them were marked before a label even
  // existed. Calling that "sent" asserts a departure nobody witnessed — the same error
  // netDeparture.js was written for in August, which I then made again here.
  MARKED_SHIPPED: 'marked-shipped',
  IN_TRANSIT: 'in-transit',
  RECEIVED: 'received',
}

/**
 * ⚠️ ONLY A HUMAN SAYING SO MOVES IT PAST "MARKED SHIPPED".
 *
 * The fulfilment's status cannot answer this: it is set when the label is made, before
 * anything moves. `departureConfirmed` is the same manual marker the Net-terms flow
 * already uses (netDeparture.js, DEPARTURE_CONFIRMED) — transfers join that mechanism
 * rather than getting a parallel one, and setFulfillmentDeparted already accepts them
 * because it keys on the IF number.
 */
export function transferState({ ifStatus, toStatus, departureConfirmed = false } = {}) {
  if (isReceived(toStatus)) return STATE.RECEIVED
  const marked = /shipped/i.test(String(ifStatus || ''))
  if (!marked) return STATE.NOT_SHIPPED
  return departureConfirmed ? STATE.IN_TRANSIT : STATE.MARKED_SHIPPED
}

/**
 * The event id. ⚠️ Prefixed `to` so it can never collide with a shipment's `po`/`so`
 * key — a transfer and a sales order could otherwise both mint the same id and one
 * would silently overwrite the other on a shared calendar.
 * base32hex: a–v and 0–9 only.
 */
export function transferKey(toNumber) {
  const c = String(toNumber || '').toLowerCase().replace(/[^a-v0-9]/g, '')
  if (!c) return null
  return c.startsWith('to') ? c : `to${c}`
}

/**
 * Build the event, or null when there is nothing honest to say.
 * @param todayIso the day an unshipped transfer sits on — an INPUT, never a clock here
 */
export function transferEvent({
  toNumber, destination, toStatus, ifNumber, ifStatus, ifDate, tracking = [],
  departureConfirmed = false, departureConfirmedAt = null, scans = [], scansChecked = null,
  todayIso,
} = {}) {
  const key = transferKey(toNumber)
  if (!key) return null
  const state = transferState({ ifStatus, toStatus, departureConfirmed })
  // ⚠️ ONLY A CONFIRMED DEPARTURE EARNS A PAST DATE. A transfer merely marked shipped
  // is, as far as anyone actually knows, still on the floor — so it sits on TODAY and
  // rolls forward like the warehouse calendar, which is exactly what it is until
  // somebody says otherwise. Dating it on if_date would put it on the day the
  // FULFILMENT WAS CREATED and call that a departure.
  const gone = state === STATE.IN_TRANSIT || state === STATE.RECEIVED
  const day = gone ? (isoPlainDay(departureConfirmedAt) || isoPlainDay(ifDate)) : todayIso

  // ⚠️ NO DATE, NO EVENT — the same rule as every other calendar here. A shipped
  // transfer with no if_date has nothing to sit on, and inventing one would put freight
  // on a day nothing happened.
  if (!day) return null

  const where = destination || 'an unnamed location'
  const nums = (tracking || []).filter(Boolean)

  let verb
  if (state === STATE.RECEIVED) verb = 'received'
  else if (state === STATE.IN_TRANSIT) verb = 'sent — not confirmed received'
  // ⚠️ "Marked shipped", never "sent". The distinction is the whole point.
  else if (state === STATE.MARKED_SHIPPED) verb = 'marked shipped — not confirmed it left'
  else verb = 'not yet shipped'

  const waiting = state === STATE.IN_TRANSIT && day ? daysBetween(day, todayIso) : null
  const summary = `${toNumber} → ${where} — ${verb}`
    + (waiting != null && waiting > 0 ? ` (${waiting}d)` : '')

  const lines = []
  lines.push(`Transfer to ${where}`)
  if (ifNumber) lines.push(`Fulfilment: ${ifNumber}${ifStatus ? ` (${ifStatus})` : ''}`)
  lines.push('')

  if (nums.length) {
    lines.push(`Tracking (${nums.length}):`)
    for (const t of nums) lines.push(`  ${t}`)
  } else if (state !== STATE.NOT_SHIPPED) {
    // ⚠️ Warned for anything past "not shipped", INCLUDING merely marked — eight of the
    // eleven marked-shipped transfers have no label at all, which is precisely when you
    // want to know there is nothing to chase.
    // ⚠️ Said out loud. A shipment that left with no tracking number cannot be chased
    // at all, and that is worth knowing BEFORE the far end says it never arrived.
    lines.push('⚠ No tracking number recorded — this cannot be traced.')
  }
  lines.push('')

  if (state === STATE.RECEIVED) {
    lines.push('Confirmed received in NetSuite.')
  } else if (state === STATE.MARKED_SHIPPED) {
    lines.push('⚠ Marked shipped in NetSuite, which happens when the LABEL is made —')
    lines.push('  not when the goods move. Nobody has confirmed this left the building.')
    lines.push('  Confirm it on the board once it has, and this settles on that day.')
  } else if (state === STATE.IN_TRANSIT) {
    lines.push('⚠ NOT confirmed received. That is the far end’s confirmation, which')
    lines.push('  does not always happen — it may well have arrived.')
    // ⚠️ Do not tell someone to check a tracking number that is not there. The advice
    // has to match the shipment in front of them, or the whole entry reads as boilerplate.
    lines.push(nums.length
      ? '  Check the tracking above, and mark it received once you know.'
      : '  There is no tracking to check — this one has to be chased by asking.')
  } else {
    lines.push('This has NOT shipped. The entry moves to today until it does, then')
    lines.push('settles on the day it left.')
  }

  // ── the scanned paperwork ────────────────────────────────────────────────
  // Filed under Boutiques/<folder>/<TO>/ — Naghedi for the Office, Consignment for
  // Consignment (Nima's mapping, transferOrder.transferFilingFolder).
  lines.push('')
  const filed = (scans || []).filter(Boolean)
  if (filed.length) {
    lines.push('Signed paperwork:')
    for (const f of filed) lines.push(`  ${f.name}\n    ${f.url}`)
  } else if (scansChecked === false) {
    // ⚠️ NOT "none filed" — WE NEVER LOOKED. The same distinction the shipment
    // calendar had to learn: an absence we did not check for is not a finding.
    lines.push('Signed paperwork: not checked.')
  } else {
    lines.push('No signed paperwork filed for this transfer.')
  }

  return {
    key, date: day, state, summary,
    // `gone` means a human CONFIRMED it left — never merely that NetSuite says Shipped.
    gone,
    markedShipped: state === STATE.MARKED_SHIPPED,
    description: lines.join('\n').trim(),
    daysWaiting: waiting,
  }
}
