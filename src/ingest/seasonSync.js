// src/ingest/seasonSync.js — the item seasons, and the marketing calendar's drop dates.
//
// Two reads, both of things that already exist and neither of which the app could see:
//
//   1. `item.custitem_season_year` per PO — 4,152 of 4,280 inventory items carry it.
//   2. The shared marketing calendar — the drop dates, which is the only place the app
//      can learn WHEN stock is needed.
//
// ⚠️ NEITHER WRITES A SEASON ONTO A PO. The suggestion is computed from the mix by
// src/model/poSeason.js every time it is asked for, so a `doc_seasons` row always means a
// person decided. See the schema note on `confirmed_by`.

import { pool } from '../db.js'
import { runSuiteQL } from './netsuiteApi.js'
import { getAccessToken } from './gmail.js'
import { dropsFrom, productLaunch } from '../model/seasonDrops.js'

/**
 * The shared marketing calendar (Nima, 2026-09-16).
 *
 * ⚠️ NOT `primary`. src/ingest/googleCalendar.js is hardcoded to the personal calendar;
 * this is a group calendar with its own id, and the same OAuth refresh token reads it
 * because the granted scope is calendar.readonly across all calendars the account can
 * see. Verified live: 136 events.
 */
export const MARKETING_CALENDAR_ID =
  'c_0b7c411c769b21ec15757bd3c0a30b416f5c29ae412c3e701ff70c87e90e2c32@group.calendar.google.com'

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars'

/** Every event on the marketing calendar since `from`, following pagination. */
export async function fetchMarketingEvents({ from = '2026-01-01', calendarId = MARKETING_CALENDAR_ID } = {}) {
  let token
  try { token = await getAccessToken() } catch (e) { return { ok: false, error: `Google auth: ${e.message}` } }
  const items = []
  let pageToken
  do {
    const u = new URL(`${CAL_API}/${encodeURIComponent(calendarId)}/events`)
    u.searchParams.set('timeMin', `${from}T00:00:00Z`)
    u.searchParams.set('maxResults', '250')
    // ⚠️ singleEvents EXPANDS RECURRENCE. Without it a weekly reminder arrives as one
    // event with a rule this app would have to interpret, and a drop that was ever set
    // up as recurring would land on the wrong date.
    u.searchParams.set('singleEvents', 'true')
    u.searchParams.set('orderBy', 'startTime')
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json().catch(() => ({}))
    // ⚠️ A 403 HERE IS NOT AN EMPTY CALENDAR. Failing soft with `[]` would report "no
    // drops" — and then every lateness check silently answers "unknown" forever.
    if (!r.ok) return { ok: false, status: r.status, error: body?.error?.message || `calendar ${r.status}` }
    items.push(...(body.items || []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return {
    ok: true,
    events: items.map((e) => ({
      title: e.summary || '',
      start: e.start?.dateTime || e.start?.date || '',
    })),
  }
}

/** Mirror the calendar's drops and product launches. */
export async function syncSeasonDrops({ from = '2026-01-01', db = pool } = {}) {
  const r = await fetchMarketingEvents({ from })
  if (!r.ok) return { ok: false, error: r.error }

  const drops = dropsFrom(r.events)
  const launches = r.events.map(productLaunch).filter(Boolean)

  // ⚠️ REFUSES TO EMPTY THE TABLE. A calendar read that comes back with no drops is far
  // more likely a permission change than a year with no launches, and wiping the dates
  // would turn every lateness verdict into "unknown" without saying why.
  if (!drops.length) {
    return { ok: false, error: 'the calendar returned no drops — refusing to replace the dates we hold', events: r.events.length }
  }

  for (const d of drops) {
    await db.query(
      `INSERT INTO season_drop (season, drop_number, year, on_date, title, single, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (season, drop_number, year) DO UPDATE SET
         on_date = EXCLUDED.on_date, title = EXCLUDED.title,
         single = EXCLUDED.single, synced_at = now()`,
      [d.season, d.drop, new Date(d.on).getFullYear(), d.on, d.title, !!d.single])
  }
  for (const l of launches) {
    await db.query(
      `INSERT INTO product_launch (on_date, title, name, synced_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (on_date, title) DO UPDATE SET name = EXCLUDED.name, synced_at = now()`,
      [l.on, l.title, l.name])
  }
  return { ok: true, events: r.events.length, drops: drops.length, launches: launches.length }
}

/**
 * The item-season mix for open purchase orders.
 *
 * ⚠️ GROUPED IN SUITEQL, NOT IN JS. One row per (PO, season) rather than per item line:
 * the POs on our containers run to thousands of lines and the mix is all this needs.
 *
 * ⚠️ AND A NULL SEASON IS SELECTED DELIBERATELY. PO1761 is 720 units on items that carry
 * no season at all; dropping those rows would make it look like a PO with no stock rather
 * than a PO with nothing to infer from — and poSeason.js counts them toward the total so
 * a minority season cannot be auto-accepted.
 */
export async function fetchPoItemSeasons({ poNumbers = [], sinceMonths = null } = {}) {
  const pos = poNumbers.map((p) => String(p).trim().toUpperCase()).filter((p) => /^PO\d+$/.test(p))
  // ⚠️ A DATE WINDOW *OR* A LIST, AND THE WINDOW IS WHY. Scoping by "POs that still owe
  // units" made every FULLY RECEIVED PO invisible — and a fully received PO is exactly
  // the one carrying stock that has arrived. Eight of them held 838 Holiday 2026 units,
  // all 838 received, so the board reported 1,163 of 6,547 when the truth was 2,330 of
  // 7,714. It was showing HALF the received stock and calling it 18%.
  //
  // Nima found it from the floor: "we received no holiday that doesn't make sense since
  // we have the net bag which should be holliday."
  const where = sinceMonths
    ? `t.trandate >= ADD_MONTHS(SYSDATE, -${Number(sinceMonths)})`
    : (pos.length ? `t.tranid IN (${pos.map((p) => `'${p}'`).join(',')})` : null)
  if (!where) return { ok: true, rows: [] }
  // ⚠️ `received` IS SUMMED IN THE SAME GROUPING, and adding it closed a gap that had
  // blocked the same question twice: the mix knew what was ORDERED for a season and
  // nothing about what had ARRIVED. PO1785 is 1,330 Holiday units with 830 received —
  // a fact this query was one column away from all along.
  const r = await runSuiteQL(`
    SELECT t.tranid AS po, i.custitem_season_year AS season,
           SUM(tl.quantity) AS units,
           SUM(COALESCE(tl.quantityshiprecv, 0)) AS received
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      JOIN item i ON i.id = tl.item
     WHERE t.type = 'PurchOrd' AND ${where}
       AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
     GROUP BY t.tranid, i.custitem_season_year`)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    // ⚠️ `units` KEEPS ITS MEANING — ordered. Everything that reads it is unchanged;
    // `received` is additive.
    rows: r.rows.map((x) => ({
      poNumber: x.po, season: x.season ?? null,
      units: Number(x.units) || 0,
      received: Number(x.received) || 0,
    })),
  }
}

/**
 * The item-season mix per TRANSFER ORDER — the grain that is actually on the boat.
 *
 * ⚠️ A TRANSFER ORDER IS A SUBSET OF ITS PO. TO218 carries 100 units of Fall 2026;
 * PO1777 holds Fall 2025 = 175 AND Fall 2026 = 140. Asking the PO what season a
 * container leg is describes merchandise that did not ship.
 */
export async function fetchToItemSeasons({ toNumbers = [] } = {}) {
  const tos = toNumbers.map((t) => String(t).trim().toUpperCase()).filter((t) => /^TO\d+$/.test(t))
  if (!tos.length) return { ok: true, rows: [] }
  const r = await runSuiteQL(`
    SELECT t.tranid AS too, i.custitem_season_year AS season, SUM(tl.quantity) AS units
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      JOIN item i ON i.id = tl.item
     WHERE t.type = 'TrnfrOrd' AND t.tranid IN (${tos.map((t) => `'${t}'`).join(',')})
       AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
     GROUP BY t.tranid, i.custitem_season_year`)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, rows: r.rows.map((x) => ({ toNumber: x.too, season: x.season ?? null, units: Number(x.units) || 0 })) }
}

/** Cache it, replace-per-TO inside a transaction — same rules as the PO version. */
export async function syncToItemSeasons({ db = pool } = {}) {
  const { rows } = await db.query(
    'SELECT to_number FROM container_transfer WHERE container_label IS NOT NULL ORDER BY to_number')
  const toNumbers = rows.map((r) => r.to_number)
  if (!toNumbers.length) return { ok: true, tos: 0, rows: 0 }

  const r = await fetchToItemSeasons({ toNumbers })
  if (!r.ok) return { ok: false, error: r.error }

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const touched = new Set(r.rows.map((x) => x.toNumber))
    for (const t of touched) await client.query('DELETE FROM to_item_season WHERE to_number = $1', [t])
    for (const x of r.rows) {
      await client.query(
        'INSERT INTO to_item_season (to_number, season, units, synced_at) VALUES ($1,$2,$3, now())',
        [x.toNumber, x.season, x.units])
    }
    await client.query('COMMIT')
    return { ok: true, tos: touched.size, rows: r.rows.length, asked: toNumbers.length }
  } catch (e) {
    await client.query('ROLLBACK')
    return { ok: false, error: e.message }
  } finally { client.release() }
}

/**
 * Cache the mix for every PO our containers carry, AND every PO still owing units.
 *
 * ⚠️ THE SCOPE WAS WIDENED ON PURPOSE (2026-09-18), and the old comment here said
 * widening it was "a decision about query cost, not a tidy-up". This is that decision,
 * made because the container scope could not answer the question the season view asks.
 *
 * Measured before changing it: `po_item_season` held 89 POs and `purchase_orders` holds
 * 80 — and the two sets OVERLAP BY FIVE. A season view built on the container scope
 * would have grouped 5 of 80 open POs and shown empty seasons for the rest, which reads
 * as "no stock coming for Holiday" rather than "nobody asked NetSuite". That is the
 * empty-table-looks-like-a-quiet-one shape this repo keeps finding.
 *
 * ⚠️ THE TWO SCOPES ARE UNIONED, NOT SWAPPED. A container PO can be fully received and
 * so carry no remaining units, which is exactly when `purchase_orders` drops it — and
 * the Landing bay still needs its mix to describe freight already on the water.
 *
 * Cost: one SuiteQL call, grouped per (PO, season) in NetSuite rather than per line.
 * The union is ~164 POs against the 89 it asked for before.
 */
/**
 * ⚠️ EIGHTEEN MONTHS, NOT "STILL OWES UNITS". Measured before choosing: 369 POs and 864
 * stored rows across 18 months, against 164 POs and 381 rows under the old scope. The
 * window is what makes a received PO visible at all, and it is cheap.
 *
 * Why 18: it covers every season with a drop still ahead of it plus the one behind, so a
 * "how much of Holiday has landed" question can be answered for a PO raised last autumn.
 * 12 months would have cut 114 POs; 24 drags in seasons nobody is working toward.
 */
export const SEASON_WINDOW_MONTHS = 18

export async function syncPoItemSeasons({ db = pool, sinceMonths = SEASON_WINDOW_MONTHS } = {}) {
  const r = await fetchPoItemSeasons({ sinceMonths })
  if (!r.ok) return { ok: false, error: r.error }

  // ⚠️ REPLACE PER PO, INSIDE A TRANSACTION. An upsert alone would leave a stale
  // (PO, season) row behind when a line is removed from the PO, and the mix would then
  // report units that are no longer ordered — a season inferred from freight that does
  // not exist.
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const touched = new Set(r.rows.map((x) => x.poNumber))
    for (const po of touched) await client.query('DELETE FROM po_item_season WHERE po_number = $1', [po])
    // ⚠️ A PLAIN INSERT, NO ON CONFLICT. The delete above already cleared this PO, and
    // ON CONFLICT cannot name a partial index's predicate — the no-season row and the
    // named-season rows are guarded by two DIFFERENT indexes (see the schema note).
    for (const x of r.rows) {
      await client.query(
        'INSERT INTO po_item_season (po_number, season, units, received, synced_at) VALUES ($1,$2,$3,$4, now())',
        [x.poNumber, x.season, x.units, x.received ?? null])
    }
    await client.query('COMMIT')
    return { ok: true, pos: touched.size, rows: r.rows.length, windowMonths: sinceMonths }
  } catch (e) {
    await client.query('ROLLBACK')
    return { ok: false, error: e.message }
  } finally {
    client.release()
  }
}

/**
 * How much of each PO has actually been received — the WHOLE PO, every line.
 *
 * ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
 * │ The purchase_orders table only keeps lines that still owe units, so it      │
 * │ cannot say how much of a PO has arrived. PO1785 has had 830 of its 1,330    │
 * │ units delivered and our table shows zero received, because the delivered    │
 * │ lines are simply not in it.                                                 │
 * │                                                                             │
 * │ This asks NetSuite for the totals across every line and stores them beside  │
 * │ that table, so "is this PO fully received?" has an answer.                   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ IT DOES NOT WIDEN purchase_orders, and that is the point — see the schema note.
 * Nine queries read that table expecting open lines only.
 */
export async function fetchPoProgress({ poNumbers = [], sinceMonths = null } = {}) {
  const pos = poNumbers.map((p) => String(p).trim().toUpperCase()).filter((p) => /^PO\d+$/.test(p))
  // Same window rule as the season mix, and for the same reason — see fetchPoItemSeasons.
  const where = sinceMonths
    ? `t.trandate >= ADD_MONTHS(SYSDATE, -${Number(sinceMonths)})`
    : (pos.length ? `t.tranid IN (${pos.map((p) => `'${p}'`).join(',')})` : null)
  if (!where) return { ok: true, rows: [] }
  // ⚠️ THE HEADER FACTS COME WITH IT — vendor, status, destination and due date. The
  // board read those from `purchase_orders`, which drops a PO once it owes nothing, so a
  // received PO had no vendor and no lane and could not be drawn at all.
  const r = await runSuiteQL(`
    SELECT t.tranid AS po, COUNT(*) AS lines, SUM(tl.quantity) AS ordered,
           SUM(COALESCE(tl.quantityshiprecv, 0)) AS received,
           MAX(BUILTIN.DF(t.entity)) AS vendor, MAX(BUILTIN.DF(t.status)) AS status,
           MAX(loc.fullname) AS destination, MAX(TO_CHAR(t.duedate,'YYYY-MM-DD')) AS duedate
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      LEFT JOIN location loc ON loc.id = t.custbody_acs_final_destination
     WHERE t.type = 'PurchOrd' AND ${where}
       AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
     GROUP BY t.tranid`)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    rows: r.rows.map((x) => {
      const ordered = Number(x.ordered) || 0
      const received = Number(x.received) || 0
      return {
        poNumber: x.po, lines: Number(x.lines) || 0, ordered, received,
        vendor: x.vendor || null,
        status: String(x.status || '').replace(/^Purchase Order\s*:\s*/i, '').trim() || null,
        destination: x.destination || null,
        dueDate: x.duedate || null,
        // ⚠️ DERIVED HERE, NOT ASKED FOR. SuiteQL will happily sum a per-line
        // subtraction, but a line whose received exceeds its ordered (it happens) would
        // make the total smaller than reality. Clamped at zero, from two honest sums.
        remaining: Math.max(0, ordered - received),
      }
    }),
  }
}

/** Cache it for every PO still owing units, and every PO on a container. */
export async function syncPoProgress({ db = pool, sinceMonths = SEASON_WINDOW_MONTHS } = {}) {
  const r = await fetchPoProgress({ sinceMonths })
  if (!r.ok) return { ok: false, error: r.error }
  for (const x of r.rows) {
    await db.query(
      `INSERT INTO po_progress (po_number, lines, ordered, received, remaining,
                                vendor, status, destination, due_date, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (po_number) DO UPDATE SET
         lines = EXCLUDED.lines, ordered = EXCLUDED.ordered, received = EXCLUDED.received,
         remaining = EXCLUDED.remaining, vendor = EXCLUDED.vendor, status = EXCLUDED.status,
         destination = EXCLUDED.destination, due_date = EXCLUDED.due_date, synced_at = now()`,
      [x.poNumber, x.lines, x.ordered, x.received, x.remaining,
       x.vendor, x.status, x.destination, x.dueDate])
  }
  return { ok: true, pos: r.rows.length, windowMonths: sinceMonths }
}

/**
 * Who each PO is FOR — the addressee on its shipping address.
 *
 * ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
 * │ Every purchase order has a "ship to" in NetSuite naming the customer the    │
 * │ goods are for — Nordstrom, Eve Group, Holt Renfrew, or NAGHEDI when it is    │
 * │ our own stock. The app has never read it; the copy it holds is frozen at a   │
 * │ CSV export from July, and every PO raised since September has none.          │
 * │                                                                             │
 * │ This reads it live. It is a name a person reads, NOT something to join on —  │
 * │ the same store appears under five different spellings.                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ THE HEADER'S ADDRESS, NOT A LINE'S. The original objection to syncing this was that
 * the saved search's "Ship To" did not map to any single line of `transaction.shipaddress`
 * (PO1745 had it on line 2). `transaction.shippingaddress` is a header field that joins
 * to one address record, which is why this works where that did not.
 */
export async function fetchPoShipTo({ sinceMonths = SEASON_WINDOW_MONTHS } = {}) {
  const r = await runSuiteQL(`
    SELECT t.tranid AS po, a.addressee, a.city, a.country
      FROM transaction t
      LEFT JOIN transactionShippingAddress a ON a.nkey = t.shippingaddress
     WHERE t.type = 'PurchOrd'
       AND t.trandate >= ADD_MONTHS(SYSDATE, -${Number(sinceMonths)})`)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    // ⚠️ A PO WITH NO ADDRESSEE IS KEPT, with null. Dropping it would make "we have not
    // synced this PO" and "this PO has no ship-to" the same thing, and 3 of 80 open POs
    // genuinely have none.
    rows: r.rows.map((x) => ({
      poNumber: x.po,
      addressee: (x.addressee || '').trim() || null,
      city: (x.city || '').trim() || null,
      country: (x.country || '').trim() || null,
    })),
  }
}

/** Cache it. Same window as the season mix, for the same reason. */
export async function syncPoShipTo({ db = pool, sinceMonths = SEASON_WINDOW_MONTHS } = {}) {
  const r = await fetchPoShipTo({ sinceMonths })
  if (!r.ok) return { ok: false, error: r.error }
  let named = 0
  for (const x of r.rows) {
    if (x.addressee) named++
    await db.query(
      `INSERT INTO po_ship_to (po_number, addressee, city, country, synced_at)
            VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (po_number) DO UPDATE SET
         addressee = EXCLUDED.addressee, city = EXCLUDED.city,
         country = EXCLUDED.country, synced_at = now()`,
      [x.poNumber, x.addressee, x.city, x.country])
  }
  return { ok: true, pos: r.rows.length, named, windowMonths: sinceMonths }
}
