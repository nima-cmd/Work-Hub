// src/model/routingAuthSource.js — where does THIS card's authorization come from,
// and has it arrived?
//
// ⚠️ THE LESSON THIS EXISTS FOR (Nima, 2026-08-13): *"I thought a system was in place
// to read my emails for the project number to place into the routing guide."* Nothing
// broke — it was never built. The 18 authorized Bloomingdale's rows on the board were
// all hand-keyed, and because the habit was reliable the lane LOOKED automated.
//
//   **Manual work that looks automated is more dangerous than obviously-manual work,
//   because nobody checks it.**
//
// A card that says "Needs routing" and nothing else does not distinguish between
// "the authorization has not arrived", "it arrived and nobody typed it in", and
// "nothing in this app has ever looked". Those need three different actions from
// three different people. So every unrouted card states its source and its state —
// and when the app is not reading that source at all, it says exactly that, out loud,
// instead of leaving a silence that reads like coverage.
//
// Pure + tested on purpose: this repo has twice shipped routing logic inside .jsx,
// which `node --test` cannot import, so it was never tested at all
// (see src/model/custody.js's header for the same correction).

import { noBolReason } from './parcelLane.js'
import { partnerForDc } from './dc.js'

/** Where an authorization for this partner physically comes from. */
export const AUTH_SOURCE = {
  // Macy's / Bloomingdale's: a "Macy's, Inc. Routing Notification" email, keyed on the
  // project + shipment numbers the portal handed back when we submitted the request.
  MACYS_EMAIL: 'macys_email',
  // Nordstrom routes through Manhattan Associates' TMS, which sends a tender — and
  // never an authorization NUMBER. There is genuinely nothing to type, which is why
  // its BOLs sat on "Needs routing" forever until the manual ✓ Mark routed was added.
  NORDSTROM_TENDER: 'nordstrom_tender',
  // Parcel lanes (ShopBop) never get a BOL, so they never get an authorization.
  NONE: 'none',
  // A partner we hold no routing convention for. Say so rather than invent one.
  UNKNOWN: 'unknown',
}

/** How far along that source is for this particular card. */
export const AUTH_STATE = {
  APPLIED: 'applied', // the authorization is on the card
  ARRIVED: 'arrived', // it exists in the mailbox and matches — not applied yet
  WAITING: 'waiting', // refs are entered, nothing has come back yet
  NO_REFS: 'no_refs', // no project/shipment number, so nothing CAN match
  NOT_READ: 'not_read', // ⚠️ nothing in this app reads this source — it is hand entry
  NOT_APPLICABLE: 'not_applicable',
}

const isMacysFamily = (partner) => /macy|bloomingdale/i.test(String(partner || ''))
const isNordstrom = (partner) => /nordstrom/i.test(String(partner || ''))

/**
 * Describe one card's authorization provenance.
 *
 * @param shipment  a routing_shipment row (may be null — a group with no BOL yet)
 * @param group     { partner, dc } for the group, so a BOL-less card still answers
 * @param notification  the matched routing notification for this card, when the app
 *   reads that source at all. `undefined` means "this app does not read it" — which
 *   is a DIFFERENT statement from `null` ("read it, found nothing") and must not
 *   collapse into it. That distinction is the whole point of this module.
 */
export function authProvenance({ shipment = null, group = {}, notification } = {}) {
  // ⚠️ THE STORED PARTNER CAN BE A LIE, and on exactly the lane this matters for.
  // routing_shipment #29 is a ShopBop order (DC `SBX2`) recorded as "Bloomingdale's",
  // because partnerForDc resolves any non-numeric DC to Bloomingdale's — the same
  // mislabel that nearly put a BOL on a ShopBop shipment (see parcelLane.js). Asked
  // the stored partner alone, this module called it a Macy's lane and told Nima to go
  // look for a routing email that will never exist.
  //
  // So the DC gets the last word: it is the objective field, the partner name is the
  // derived one, and this repo's counter bugs have repeatedly been "keyed on a
  // hand-set/display field where an objective one exists" (see CLAUDE.md).
  const dc = shipment?.dc || group.dc || null
  const partner = (dc ? partnerForDc(dc) : null) || shipment?.partner || group.partner || null
  const noBol = noBolReason({ customer: partner, location: dc })

  if (noBol) {
    return {
      source: AUTH_SOURCE.NONE,
      state: AUTH_STATE.NOT_APPLICABLE,
      sourceLabel: 'No authorization — this lane ships parcel',
      detail: noBol,
      arrived: null,
      manual: false,
    }
  }

  if (isNordstrom(partner)) {
    // The tender is not an authorization: it carries the pickup date, the carrier and
    // the SRRs, and no auth number exists anywhere in the lane. Reported honestly as
    // "there is nothing to wait for" so the card never reads as a missing document.
    const tendered = !!shipment?.tender
    return {
      source: AUTH_SOURCE.NORDSTROM_TENDER,
      state: AUTH_STATE.NOT_APPLICABLE,
      sourceLabel: 'No authorization number — Nordstrom routes via Manhattan TMS',
      detail: tendered
        ? 'The TMS tender carries the pickup date and carrier. Routing is done by hand — press ✓ Mark routed.'
        : 'No tender ingested for this shipment yet. Routing is done by hand — press ✓ Mark routed.',
      arrived: null,
      manual: true,
    }
  }

  if (!isMacysFamily(partner)) {
    return {
      source: AUTH_SOURCE.UNKNOWN,
      state: AUTH_STATE.NOT_READ,
      sourceLabel: `No routing convention recorded for ${partner || 'this partner'}`,
      detail: 'Authorization is hand entry. Nothing in this app watches for it.',
      arrived: null,
      manual: true,
    }
  }

  // ── Macy's / Bloomingdale's ────────────────────────────────────────────────
  const sourceLabel = 'Authorization arrives by email — Macy’s, Inc. Routing Notification'
  const project = shipment?.projectNumber || null
  const ship = shipment?.shipmentNumber || null

  if (shipment?.authNumber) {
    return {
      source: AUTH_SOURCE.MACYS_EMAIL,
      state: AUTH_STATE.APPLIED,
      sourceLabel,
      detail: `Authorization ${shipment.authNumber} is on this card.`,
      arrived: true,
      manual: notification === undefined,
    }
  }

  // ⚠️ `undefined` (nobody looked) must never be reported as `null` (looked, nothing
  // there). Before the reader exists, the honest card says the lane is hand entry.
  if (notification === undefined) {
    return {
      source: AUTH_SOURCE.MACYS_EMAIL,
      state: AUTH_STATE.NOT_READ,
      sourceLabel,
      detail: project && ship
        ? `Nothing in this app reads that email — check the inbox for project ${project} / shipment ${ship} and key it in.`
        : 'Nothing in this app reads that email — check the inbox and key it in.',
      arrived: null,
      manual: true,
    }
  }

  if (notification) {
    return {
      source: AUTH_SOURCE.MACYS_EMAIL,
      state: AUTH_STATE.ARRIVED,
      sourceLabel,
      detail: `Authorization ${notification.authNumber} arrived` +
        (notification.receivedAt ? ` ${new Date(notification.receivedAt).toLocaleDateString()}` : '') +
        ' — not applied to this card yet.',
      arrived: true,
      manual: false,
    }
  }

  if (!project || !ship) {
    // No refs means the portal request has not been submitted (or its numbers were
    // never typed back in), so a notification could not be matched even if it came.
    return {
      source: AUTH_SOURCE.MACYS_EMAIL,
      state: AUTH_STATE.NO_REFS,
      sourceLabel,
      detail: 'No project / shipment number on this card yet, so no notification can match it.',
      arrived: false,
      manual: false,
    }
  }

  return {
    source: AUTH_SOURCE.MACYS_EMAIL,
    state: AUTH_STATE.WAITING,
    sourceLabel,
    detail: `Waiting on the notification for project ${project} / shipment ${ship}.`,
    arrived: false,
    manual: false,
  }
}

/** One short line for a card. Kept next to the states so the two cannot drift. */
export function authProvenanceLine(p) {
  return `${p.sourceLabel} — ${p.detail}`
}
