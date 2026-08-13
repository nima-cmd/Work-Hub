// src/model/macysRouting.js — Macy's/Bloomingdale's routing notification, parsed.
//
// ⚠️ WHY THIS EXISTS (Nima, 2026-08-13): *"we have some routed bloomingdales orders and
// i see that they didn't get auto populated from the email into the routing"* — then,
// once diagnosed: *"I now realize you manually put them in last time and we never built
// anything for this. I thought a system was in place to read my emails."*
//
// Nothing broke. It was never built. `manhattanTender.js` is the only module that has
// ever read Gmail for routing, and it is hard-scoped to Nordstrom. Macy's sends a
// different email from a different sender and nothing looked for it. Every authorized
// Bloomingdale's row on the board was hand-keyed — 18 of them before this file existed.
//
// ── THE JOIN KEY IS EXACT, ON BOTH SIDES, AND WAS ALREADY THERE ─────────────────
//
// `routing_shipment` already stores `project_number` and `shipment_number` — the two
// references the macysnet.com portal hands back when we submit a routing request. The
// email names both. So this is a DUAL EXACT KEY: no DC matching, no recency window, no
// inference of the kind that has failed three times on the ship-window question.
//
//   ⚠️ Both must match. Not either. A project number alone would be enough in every
//   sample in the mailbox, but the email's own words are "Project Number(s) X
//   containing Shipment(s) Y" — the shipment is the thing being authorized, and a
//   project that got re-cut into different shipments would silently authorize the
//   wrong freight. Anything that matches on one key and not the other is SURFACED,
//   never applied.
//
// ── ⚠️ TWO SENDERS, NOT ONE ────────────────────────────────────────────────────
//
// `ML.Manuundel.MacysNet@macys.com` AND `ml.manuundel@macysnet.com`. Both are live in
// the mailbox right now and roughly half the 50 notifications came from each. A filter
// on the one address that happened to be on today's email would have quietly read half
// the lane and looked like it was working.
//
// ── ⚠️ A BOL BLOCK CAN CARRY COMMA LISTS ───────────────────────────────────────
//
// Most blocks read "Project Number(s) 9022514 containing Shipment(s) 52172263". But the
// 2026-05-04 notification carries "Project Number(s) 8836810,8835718 containing
// Shipment(s) 51756016,51754370" — two of each, on ONE consignee. Pairing those is
// positional, which is an inference, so it is allowed ONLY when the counts match, and
// when they do not this pairs NOTHING and says so. Exactly the SRR rule in
// manhattanTender.js: a reference on the wrong shipment is worse than no reference,
// because it is a number that would be typed into a portal with confidence.
//
// ── WHAT IS AND IS NOT A KEY ───────────────────────────────────────────────────
//
// The consignee block names the destination DC ("SECAUCUS", "STONE MOUNTAIN (BT)") and
// whether it routes direct or via a Merge Center. Both are parsed and both are useful
// as a CROSS-CHECK — a matched shipment whose DC disagrees is worth shouting about —
// but neither is a join key. The DC repeats every cycle; the shipment number does not.
//
// Validated against 50 live notifications back to 2026-03-20 (76 BOL blocks, all
// parsed) and against the 23 routing_shipment rows that already carry both references.

/** How a block's projects were paired to its shipments. */
export const PAIRING = {
  ONE_TO_ONE: 'one_to_one', // the ordinary block: one project, one shipment
  BY_POSITION: 'by_position', // comma lists of equal length, zipped in order
  COUNT_MISMATCH: 'count_mismatch', // ⚠️ counts disagreed — paired nothing on purpose
}

// The senders seen in the mailbox. Kept as a list because there are already two, and
// the failure mode of guessing one is silent half-coverage rather than an error.
export const MACYS_SENDERS = [
  'ML.Manuundel.MacysNet@macys.com',
  'ml.manuundel@macysnet.com',
]

// Merge Centers named in the notification's own boilerplate: Burlington NJ, Santa Fe
// Springs CA, High Point NC. Only "MEGA-MERGE CA" has ever actually appeared in a
// consignee block, so the other two are matched but never assumed.
const MERGE_CENTERS = [
  { re: /MEGA-?MERGE\s+CA|SANTA\s+FE\s+SPGS/i, code: 'CA' },
  { re: /MEGA-?MERGE\s+NJ|BURLINGTON/i, code: 'NJ' },
  { re: /MEGA-?MERGE\s+(?:NC|HP)|HIGH\s+POINT/i, code: 'HP' },
]

function flatten(html) {
  return String(html || '')
    // The notification is a template with a large <style> block; a stray "Carrier" in
    // a class name would otherwise be read as data. Same guard as manhattanTender.js.
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// 'MM/DD/YYYY' or 'MM/DD/YYYY 10:00:00 AM' → 'YYYY-MM-DD'.
//
// ⚠️ Deliberately a DATE and never an instant. `routing_shipment.ship_date` is a DATE
// column, the notification carries no timezone at all, and inventing one is how the
// tender lane nearly booked a pickup in the wrong zone. The time of day, when present,
// is kept verbatim in `pickupRaw` and used by nothing.
export function parseMacysDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

/**
 * 'UPS GRND - BILL TO ACCT#5R12Y0 (UPSN)' → { name, scac, billToAccount, raw }.
 *
 * The stored convention is the SHORT name: the 23 authorized rows on the board read
 * `UPS GRND` / `FEDEX GROUND` / `FEDEX ECONOMY`, not the full string, and the BOLs
 * printed from them say the same. So the name is the text before the first hyphen —
 * which handles 'FEDEX GROUND- PARCEL-COLLECT' (no space before the hyphen) and
 * 'FEDEX ECONOMY - LTL' identically. The full text is kept in `raw`, because the
 * difference between "FEDEX GROUND" and "FEDEX GROUND- PARCEL-COLLECT" is a freight
 * term someone may need to read later.
 */
export function parseCarrier(raw) {
  const s = String(raw || '').trim()
  if (!s) return { name: null, scac: null, billToAccount: null, raw: null }
  const scac = (s.match(/\(([A-Z0-9]{2,6})\)\s*$/) || [])[1] || null
  const billToAccount = (s.match(/ACCT#\s*([A-Z0-9]+)/i) || [])[1] || null
  const withoutScac = s.replace(/\s*\([A-Z0-9]{2,6}\)\s*$/, '').trim()
  const name = withoutScac.split('-')[0].trim() || null
  return { name, scac, billToAccount, raw: s }
}

/** The consignee block → the destination DC name + how it is routed there. */
export function parseConsignee(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return { consignedTo: null, dcName: null, mergeCenter: null, shipDirect: null }
  const viaIdx = s.search(/\bc\/o\b/i)
  const dcName = (viaIdx > 0 ? s.slice(0, viaIdx) : s)
    // The street address follows the DC name with no delimiter, so the name is the
    // leading run of letters/spaces — 'STONE MOUNTAIN (BT) 4401 SARR PARKWAY' keeps
    // the (BT) qualifier, which distinguishes two real destinations.
    .replace(/\s+\d.*$/, '').trim() || null
  if (viaIdx < 0) return { consignedTo: s, dcName, mergeCenter: null, shipDirect: true }
  const via = s.slice(viaIdx)
  const mc = MERGE_CENTERS.find((m) => m.re.test(via))
  return { consignedTo: s, dcName, mergeCenter: mc ? mc.code : null, shipDirect: false }
}

/**
 * Parse one routing notification into ONE authorization covering 1..N stops.
 *
 * Returns null when the body is not a notification (no authorization number) — the
 * caller filters on subject and sender, but a mailbox is not a schema.
 */
export function parseRoutingNotification({ subject, body, receivedAt, messageId, from } = {}) {
  const text = flatten(body)
  const authNumber = (text.match(/Trip ID\s*\/\s*Authorization #\s*:\s*(\S+)/i) || [])[1] || null
  if (!authNumber) return null

  // 'N/A' is the literal the template uses for a small-package shipment with no dock
  // appointment. Kept as null so a surface never prints the string "N/A" as a number.
  const apptRaw = (text.match(/Appointment #\s*:\s*(\S+)/i) || [])[1] || null
  const appointmentNumber = apptRaw && apptRaw.toUpperCase() !== 'N/A' ? apptRaw : null

  const carrier = parseCarrier(
    (text.match(/Carrier\s*:\s*(.*?)\s*Carrier Mode\s*:/i) || [])[1],
  )
  const pickupRaw = (text.match(/Pickup Date\s*:\s*(.*?)\s*Delivery Date/i) || [])[1] || null
  const deliveryRaw = (text.match(/Delivery Date\s*:\s*(.*?)\s*Appointment Type/i) || [])[1] || null

  // The BILLS OF LADING section is the only part of the body that is data; everything
  // after it is a page of standing instructions that repeats words like "Carrier" and
  // "Project". Bounded on both sides so the block regex can never wander into it.
  const start = text.indexOf('BILLS OF LADING')
  const endMarker = text.indexOf('If you have received a notification email')
  const section = start < 0 ? '' : text.slice(start, endMarker > start ? endMarker : undefined)

  const stops = []
  let pairing = PAIRING.ONE_TO_ONE
  const blockRe = /Project Number\(s\)\s*([\d,\s]+?)\s*containing\s*Shipment\(s\)\s*([\d,\s]+?)\s*-\s*Consigned to:\s*(.*?)(?=Project Number\(s\)|$)/g
  for (const m of section.matchAll(blockRe)) {
    const projects = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    const shipments = m[2].split(',').map((s) => s.trim()).filter(Boolean)
    const consignee = parseConsignee(m[3])
    if (projects.length !== shipments.length) {
      // ⚠️ Pair NOTHING. The block is still reported so a surface can say a stop was
      // seen and deliberately left unpaired — silently dropping it would read as a
      // notification that simply had fewer stops.
      pairing = PAIRING.COUNT_MISMATCH
      stops.push({
        projectNumber: null, shipmentNumber: null,
        projects, shipments, unpaired: true, ...consignee,
      })
      continue
    }
    if (projects.length > 1 && pairing === PAIRING.ONE_TO_ONE) pairing = PAIRING.BY_POSITION
    projects.forEach((p, i) => {
      stops.push({
        projectNumber: p, shipmentNumber: shipments[i],
        projects, shipments, unpaired: false, ...consignee,
      })
    })
  }

  return {
    authNumber,
    appointmentNumber,
    messageId: messageId || null,
    from: from || null,
    receivedAt: receivedAt ? new Date(receivedAt) : null,
    carrier: carrier.name,
    carrierRaw: carrier.raw,
    scac: carrier.scac,
    billToAccount: carrier.billToAccount,
    carrierMode: (text.match(/Carrier Mode\s*:\s*(.*?)\s*Phone\s*:/i) || [])[1] || null,
    pickupRaw,
    pickupDate: parseMacysDate(pickupRaw),
    deliveryDate: parseMacysDate(deliveryRaw),
    appointmentType: (text.match(/Appointment Type\s*:\s*(.*?)\s*(?:Reminder:|BILLS OF LADING)/i) || [])[1] || null,
    // The subject lists every project the notification covers, independently of the
    // body. A disagreement means the block parse missed something, so it is kept as
    // the notification's own checksum rather than thrown away.
    subjectProjects: ((String(subject || '').match(/\(Project\(s\)\s*([^)]*)\)/) || [])[1] || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    pairing,
    stops,
  }
}

/** Does the body's stop list account for every project named in the subject? */
export function projectsReconcile(n) {
  if (!n?.subjectProjects?.length) return null
  const seen = new Set(n.stops.flatMap((s) => s.projects || []))
  return n.subjectProjects.every((p) => seen.has(p)) && seen.size === n.subjectProjects.length
}

/** Why a stop could not be applied. One reason per fact — never lumped. */
export const MISS = {
  NO_MATCH: 'no_match', // neither key found a shipment
  PROJECT_ONLY: 'project_only', // ⚠️ the project matched but the shipment did not
  SHIPMENT_ONLY: 'shipment_only', // ⚠️ and the mirror image
  UNPAIRED: 'unpaired', // the block's counts disagreed, so it carries no keys
  AUTH_CONFLICT: 'auth_conflict', // already authorized, with a DIFFERENT number
  DC_DISAGREES: 'dc_disagrees', // matched, but the consignee names another DC
  SHIP_DATE_DEPARTED: 'ship_date_departed', // already left — history is not rewritten
}

// ⚠️ THE PICKUP DATE ALWAYS WINS ON A SHIPMENT THAT HAS NOT LEFT.
//
// Nima, 2026-08-13: *"the date the bol is created is the date i generate it for routing,
// it has nothing to do with what date i think it will ship."*
//
// So `routing_shipment.ship_date` is NOT a prediction anyone made, and there is nothing
// to protect by holding it. Confirmed in the client: GroupBar and the refs editor both
// seed the field with `todayStr()`, and the one row set whose pre-application value we
// know — today's five cards — read 2026-08-12, identical to their `created_at`, until
// Nima applied 08-18 by hand this morning. Same family as `transaction.shipdate`
// (netsuite-fields-that-lie): a column that looks like a date and is an artifact of
// when a record was made.
//
// My first cut got this wrong. It measured that ship_date matches the pickup date on
// only 11 of 23 cards and read the other 12 as considered dates worth preserving —
// treating an artifact as evidence, which is exactly the mistake that memory is about.
// The disagreement was the finding, not the reason to be cautious.
//
// The ONE guard that stays: a shipment that has already DEPARTED is history. Its
// `shipped_at` is the real evidence of when it left (the five cards on the 08-01
// notification departed 08-03, before their own 08-04 pickup date), and moving a date
// on a record that is closed cannot help anyone. Surfaced, not written.
const hasDeparted = (s) => !!s.shippedAt

const norm = (v) => (v == null ? null : String(v).trim() || null)
const ymd = (d) => {
  if (!d) return null
  const x = d instanceof Date ? d : new Date(d)
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10)
}

/**
 * Match one notification against the routing shipments we hold, and plan what may be
 * applied automatically.
 *
 * ⚠️ THE ONE RULE: apply only on a DUAL EXACT MATCH of project AND shipment number.
 * Everything else — one key matching, no key matching, an unpaired block, a card that
 * already carries a different authorization — is returned as a MISS for a human, and
 * `check:routing` makes it loud. There is no fuzzy branch to fall through to.
 *
 * ⚠️ An existing `auth_number` is NEVER overwritten, even when both keys match. The
 * board already proves the convention drifted: shipments 5–8 store `55753138`, the
 * notification's APPOINTMENT number, while shipments 9–13 store the Trip ID. A rule
 * that "corrects" the older ones would silently rewrite a number Nima typed off a
 * document, and the register has taught this exact lesson once already
 * (dc-cargo-tag-never-closed). A disagreement is a thing to look at, not to fix.
 *
 * `shipments` are rows of { id, partner, dc, projectNumber, shipmentNumber, authNumber,
 * carrier, scac, shipDate, bolNumber, status, shippedAt }.
 */
export function planRoutingApply(notification, shipments = []) {
  const applies = []
  const misses = []
  // ⚠️ Counted separately from `applies` ON PURPOSE. "Historical" must mean NO STOP
  // FOUND A CARD — not "no stop produced a write". Deriving it from applies.length
  // hid a real finding on the live board: notification 00052827257S matches seven
  // cards that all carry a conflicting authorization, produces zero applies, and so
  // reported itself as historical and skipped printing its seven conflicts entirely.
  // A count that answers a different question from its label is the shape every
  // counter bug in this repo has taken (see CLAUDE.md).
  let matchedCards = 0

  const byProject = new Map()
  const byShipment = new Map()
  for (const s of shipments) {
    if (norm(s.projectNumber)) byProject.set(norm(s.projectNumber), s)
    if (norm(s.shipmentNumber)) byShipment.set(norm(s.shipmentNumber), s)
  }

  for (const stop of notification.stops) {
    if (stop.unpaired) {
      misses.push({
        kind: MISS.UNPAIRED, stop,
        detail: `${stop.projects.length} project(s) against ${stop.shipments.length} shipment(s) ` +
          'in one block — paired nothing rather than guess which belongs to which',
      })
      continue
    }

    const p = byProject.get(norm(stop.projectNumber)) || null
    const sh = byShipment.get(norm(stop.shipmentNumber)) || null

    if (!p && !sh) {
      misses.push({
        kind: MISS.NO_MATCH, stop,
        detail: `project ${stop.projectNumber} / shipment ${stop.shipmentNumber} matches no routing card` +
          (stop.dcName ? ` (consigned to ${stop.dcName})` : ''),
      })
      continue
    }
    if (!sh || (p && sh && p.id !== sh.id)) {
      misses.push({
        kind: MISS.PROJECT_ONLY, stop, shipmentId: p?.id ?? null, bolNumber: p?.bolNumber ?? null,
        detail: `project ${stop.projectNumber} matches card ${p?.bolNumber || p?.id}, but its shipment number is ` +
          `${p?.shipmentNumber || 'not set'} — the email says ${stop.shipmentNumber}`,
      })
      continue
    }
    if (!p) {
      misses.push({
        kind: MISS.SHIPMENT_ONLY, stop, shipmentId: sh.id, bolNumber: sh.bolNumber,
        detail: `shipment ${stop.shipmentNumber} matches card ${sh.bolNumber || sh.id}, but its project number is ` +
          `${sh.projectNumber || 'not set'} — the email says ${stop.projectNumber}`,
      })
      continue
    }

    // Both keys, same row. This is the only path that writes.
    const s = sh
    matchedCards++

    if (norm(s.authNumber) && norm(s.authNumber) !== norm(notification.authNumber)) {
      misses.push({
        kind: MISS.AUTH_CONFLICT, stop, shipmentId: s.id, bolNumber: s.bolNumber,
        ours: s.authNumber, theirs: notification.authNumber,
        detail: `card ${s.bolNumber || s.id} already carries authorization ${s.authNumber}; ` +
          `this notification says ${notification.authNumber} — left alone`,
      })
      continue
    }

    // A cross-check, not a key: the consignee names the destination DC, and a matched
    // card pointing somewhere else means one of the two references was mistyped.
    // Reported ALONGSIDE the apply — it is a warning about a match, not a rejection.
    const dcNote = stop.dcName && s.dc && !dcNameMatchesCard(stop.dcName, s)
      ? { kind: MISS.DC_DISAGREES, stop, shipmentId: s.id, bolNumber: s.bolNumber,
        detail: `card ${s.bolNumber || s.id} is DC ${s.dc}, but the notification consigns ` +
          `project ${stop.projectNumber} to ${stop.dcName}` }
      : null
    if (dcNote) misses.push(dcNote)

    // Only fields that are genuinely absent or genuinely different are written, so a
    // re-run of the same notification is a no-op and reports 0 changes rather than
    // "applied" every ten minutes.
    const set = {}
    if (!norm(s.authNumber)) set.authNumber = notification.authNumber
    // ── Where it is CONSIGNED, straight off the notification ────────────────
    //
    // ⚠️ These three were parsed from day one and thrown away, and the cost was not
    // cosmetic. `routing_shipment.ship_direct` DEFAULTS to false and `merge_center`
    // DEFAULTS to 'CA', so a card nobody hand-edited asserts "via the Santa Fe
    // Springs merge center" — an assertion no one ever made. Every one of the five
    // 2026-08-18 Bloomingdale's cards read that way while its own notification said
    // SECAUCUS / LOS ANGELES / STONE MOUNTAIN / CHINA GROVE / JOPPA, direct.
    //
    // The notification is the AUTHORITY here, for the same reason it is on the
    // pickup date (PR #97): it is the partner instructing us where to send the
    // freight, and our stored value is a default nobody typed. So this is written
    // whenever it DISAGREES, not only when absent — a COALESCE would be a no-op
    // against `false`, which is exactly how the wrong value survived.
    //
    // `shipDirect` is null when the consignee block is unparseable; null means "we
    // do not know", and nothing is written from a non-answer.
    if (stop.shipDirect != null && !!s.shipDirect !== stop.shipDirect) set.shipDirect = stop.shipDirect
    if (stop.mergeCenter && norm(s.mergeCenter) !== stop.mergeCenter) set.mergeCenter = stop.mergeCenter
    // Verbatim, so "where did we actually send it" survives our address table
    // changing under us.
    if (stop.consignedTo && norm(s.consignedTo) !== norm(stop.consignedTo)) set.consignedTo = stop.consignedTo
    if (notification.carrier && norm(s.carrier) !== notification.carrier) set.carrier = notification.carrier
    if (notification.scac && norm(s.scac) !== notification.scac) set.scac = notification.scac
    if (notification.pickupDate && ymd(s.shipDate) !== notification.pickupDate) {
      if (!hasDeparted(s)) {
        set.shipDate = notification.pickupDate
      } else {
        misses.push({
          kind: MISS.SHIP_DATE_DEPARTED, stop, shipmentId: s.id, bolNumber: s.bolNumber,
          ours: ymd(s.shipDate), theirs: notification.pickupDate,
          detail: `card ${s.bolNumber || s.id} left ${ymd(s.shippedAt)} and says ${ymd(s.shipDate)}; ` +
            `the notification's pickup was ${notification.pickupDate} — history, left alone`,
        })
      }
    }
    applies.push({
      shipmentId: s.id, bolNumber: s.bolNumber || null, dc: s.dc, partner: s.partner,
      projectNumber: stop.projectNumber, shipmentNumber: stop.shipmentNumber,
      // Named so the run output can say "ship date 2026-08-12 → 2026-08-18" rather
      // than a bare count. A date this lane moves is never allowed to move quietly.
      shipDateWas: set.shipDate ? ymd(s.shipDate) : null,
      // Same rule as the ship date: a change to where the freight is CONSIGNED is
      // never allowed to move quietly. This is the field that decides the BOL's
      // ship-to block, so the run output names both sides.
      consigneeWas: set.shipDirect !== undefined
        ? (s.shipDirect ? 'direct to the DC' : `via merge center ${s.mergeCenter || '?'}`)
        : null,
      consigneeNow: set.shipDirect !== undefined
        ? (stop.shipDirect ? `direct to ${stop.dcName || 'the DC'}` : `via merge center ${stop.mergeCenter || '?'}`)
        : null,
      set, changes: Object.keys(set).length,
    })
  }

  return {
    authNumber: notification.authNumber,
    receivedAt: notification.receivedAt,
    pickupDate: notification.pickupDate,
    carrier: notification.carrier,
    scac: notification.scac,
    stops: notification.stops.length,
    matched: applies.length,
    matchedCards,
    // A notification that matched nothing at all is HISTORICAL — the cards it
    // authorized have long since shipped and been archived. Nine of them shouting
    // "no routing card" every run would bury the one that is live. Same rule the
    // tender reconciliation arrived at.
    outOfScope: matchedCards === 0 && notification.stops.length > 0,
    changes: applies.reduce((n, a) => n + a.changes, 0),
    applies,
    misses,
  }
}

// The consignee names a DC in words ('CFC CHINA GROVE DC'); the card holds an
// abbreviation ('CG'). Rather than build a second name table that can drift from
// bolAddresses.js, this asks the weaker but honest question: do the card's own DC
// label and the email's name share their significant words? A card with no label to
// compare returns true — an unknown is not a disagreement.
function dcNameMatchesCard(dcName, card) {
  const words = (s) => String(s || '').toUpperCase().match(/[A-Z]{3,}/g) || []
  const theirs = words(dcName).filter((w) => !['DC', 'CFC', 'THE'].includes(w))
  const ours = words(card.dcLabel || card.dcName)
  if (!ours.length || !theirs.length) return true
  return theirs.some((w) => ours.includes(w)) || ours.some((w) => theirs.includes(w))
}

export function summarizeRoutingMisses(reports = []) {
  const all = reports.flatMap((r) => r.misses)
  const by = (k) => all.filter((m) => m.kind === k).length
  return {
    notifications: reports.length,
    outOfScope: reports.filter((r) => r.outOfScope).length,
    applied: reports.reduce((n, r) => n + r.matched, 0),
    changes: reports.reduce((n, r) => n + r.changes, 0),
    noMatch: by(MISS.NO_MATCH),
    projectOnly: by(MISS.PROJECT_ONLY),
    shipmentOnly: by(MISS.SHIPMENT_ONLY),
    unpaired: by(MISS.UNPAIRED),
    authConflict: by(MISS.AUTH_CONFLICT),
    dcDisagrees: by(MISS.DC_DISAGREES),
    shipDateDeparted: by(MISS.SHIP_DATE_DEPARTED),
  }
}
