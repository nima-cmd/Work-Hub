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
export async function fetchPoItemSeasons({ poNumbers = [] } = {}) {
  const pos = poNumbers.map((p) => String(p).trim().toUpperCase()).filter((p) => /^PO\d+$/.test(p))
  if (!pos.length) return { ok: true, rows: [] }
  const list = pos.map((p) => `'${p}'`).join(',')
  const r = await runSuiteQL(`
    SELECT t.tranid AS po, i.custitem_season_year AS season, SUM(tl.quantity) AS units
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      JOIN item i ON i.id = tl.item
     WHERE t.type = 'PurchOrd' AND t.tranid IN (${list})
       AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
     GROUP BY t.tranid, i.custitem_season_year`)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    rows: r.rows.map((x) => ({ poNumber: x.po, season: x.season ?? null, units: Number(x.units) || 0 })),
  }
}

/**
 * Cache the mix for every PO our containers carry.
 *
 * ⚠️ SCOPED TO THE POs ON CONTAINERS, not every PO in NetSuite. This exists to answer a
 * container question; widening it is a decision about query cost on a one-vCPU deploy,
 * not a tidy-up.
 */
export async function syncPoItemSeasons({ db = pool } = {}) {
  const { rows: pos } = await db.query(
    `SELECT DISTINCT po_number FROM container_transfer WHERE po_number IS NOT NULL ORDER BY po_number`)
  const poNumbers = pos.map((r) => r.po_number)
  if (!poNumbers.length) return { ok: true, pos: 0, rows: 0 }

  const r = await fetchPoItemSeasons({ poNumbers })
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
        'INSERT INTO po_item_season (po_number, season, units, synced_at) VALUES ($1,$2,$3, now())',
        [x.poNumber, x.season, x.units])
    }
    await client.query('COMMIT')
    return { ok: true, pos: touched.size, rows: r.rows.length, asked: poNumbers.length }
  } catch (e) {
    await client.query('ROLLBACK')
    return { ok: false, error: e.message }
  } finally {
    client.release()
  }
}
