// src/ingest/macysRouting.js — pull Macy's/Bloomingdale's routing notifications and
// apply them to the routing board.
//
// Parse rules and every trap live in src/model/macysRouting.js (pure, tested). This
// file only fetches, matches, writes and reads back — the same split as
// manhattanTender.js and asnCartonSync.js, so the CLI, the check and the cron all
// share one path.
//
// ── ⚠️ NO NEW TABLE, ON PURPOSE ────────────────────────────────────────────────
//
// The tender lane persists its emails because a tender carries facts (SRRs, carton
// totals) that live nowhere else and are needed after the fact. A routing
// notification carries nothing that `routing_auth` + `routing_shipment` do not
// already have columns for — `auth_number`, `carrier`, `scac`, `ship_date`,
// `project_number`, `shipment_number` were all built for exactly this and only the
// reader was missing. Storing a second copy would create a thing that can disagree
// with the board. The mailbox is the archive; the board is the record.
//
// ── ⚠️ IT HAS A CALLER ─────────────────────────────────────────────────────────
//
// Wired into POST /api/internal/recurring-check beside syncTenders. This repo has
// shipped a sync with NO CALLER twice — PR #16 (a week of silent NetSuite drift, 7
// stranded BOLs) and PR #78 (the tender sync, wired in three comments below the line
// documenting the first one). A sync with no caller is indistinguishable from a sync
// with nothing to do. Checked the same round it was written.

import { pool } from '../db.js'
import { searchMessages } from './gmail.js'
import {
  parseRoutingNotification, planRoutingApply, projectsReconcile,
} from '../model/macysRouting.js'

// Filtered on the SUBJECT, not the sender. There are already two sender addresses in
// the mailbox (`ML.Manuundel.MacysNet@macys.com` and `ml.manuundel@macysnet.com`),
// each carrying about half the notifications, so a from: filter is a silent 50% miss.
// The subject line has been byte-stable across 60 messages since 2026-03-20, and the
// parser returns null for anything with no authorization number anyway.
export const ROUTING_QUERY = 'subject:"Routing Notification" in:anywhere'

// Where the lane records that it ran. Lets a surface distinguish "we looked and there
// was nothing" from "nothing has ever looked" — the distinction routingAuthSource.js
// exists to protect. `sync_meta` already exists; no migration.
export const CHECKED_KEY = 'macys_routing_checked_at'

export async function fetchRoutingNotifications({ max = 100, sinceDays = null } = {}) {
  // The scheduled caller passes a small window so the common case is ONE cheap search
  // returning nothing — notifications arrive a few times a month. The CLI passes none
  // and sweeps the whole mailbox.
  const query = sinceDays ? `${ROUTING_QUERY} newer_than:${sinceDays}d` : ROUTING_QUERY
  const messages = await searchMessages({ query, max })
  const parsed = []
  for (const m of messages) {
    const n = parseRoutingNotification({
      subject: m.subject, body: m.body, receivedAt: m.receivedAt,
      messageId: m.id, from: m.fromAddress,
    })
    if (n) parsed.push(n)
  }
  // ⚠️ A notification can be re-sent, and the authorization number is the identity —
  // the same lesson as the 62 re-sent 856s and the tender that arrived twice. Keep
  // the most recently received copy per authorization so the plan is deterministic
  // regardless of the order Gmail returns them in.
  const byAuth = new Map()
  for (const n of parsed) {
    const prev = byAuth.get(n.authNumber)
    if (!prev || (n.receivedAt?.getTime() || 0) >= (prev.receivedAt?.getTime() || 0)) {
      byAuth.set(n.authNumber, n)
    }
  }
  return {
    fetched: messages.length,
    parsed: parsed.length,
    // The body's stop list must account for every project the subject names. A
    // notification that fails its own checksum is reported, never quietly applied.
    checksumFailed: parsed.filter((n) => projectsReconcile(n) === false).map((n) => n.authNumber),
    notifications: [...byAuth.values()],
  }
}

/** Every Macy's-family routing shipment, in the shape planRoutingApply wants. */
export async function loadMacysShipments(db = pool) {
  const { rows } = await db.query(
    `SELECT id, partner, dc, status, bol_number AS "bolNumber",
            project_number AS "projectNumber", shipment_number AS "shipmentNumber",
            auth_number AS "authNumber", carrier, scac,
            ship_date AS "shipDate", shipped_at AS "shippedAt"
       FROM routing_shipment
      WHERE partner ILIKE '%bloomingdale%' OR partner ILIKE '%macy%'
      ORDER BY id`,
  )
  return rows
}

/**
 * Write one notification's applies. Mirrors what POST /api/routing/auth does by hand —
 * the authorization row first, then the shipments — so a card reaches exactly the same
 * state whether Nima typed it or this read it.
 *
 * ⚠️ `status` is promoted only from an unsettled state, the same CASE the manual
 * assign uses. A `routed` or `shipped` card is never dragged backwards.
 */
export async function applyRouting(notification, applies, { dryRun = false } = {}) {
  const writable = applies.filter((a) => a.changes > 0)
  if (dryRun || !writable.length) {
    return { auths: 0, shipments: 0, fields: writable.reduce((n, a) => n + a.changes, 0), dryRun }
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // COALESCE on every column: an authorization that already exists keeps whatever a
    // human put on it. Same contract as upsertRoutingAuth.
    await client.query(
      `INSERT INTO routing_auth (auth_number, partner, carrier, scac, ship_date, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (auth_number) DO UPDATE SET
         partner   = COALESCE(routing_auth.partner, EXCLUDED.partner),
         carrier   = COALESCE(routing_auth.carrier, EXCLUDED.carrier),
         scac      = COALESCE(routing_auth.scac, EXCLUDED.scac),
         ship_date = COALESCE(routing_auth.ship_date, EXCLUDED.ship_date),
         note      = COALESCE(routing_auth.note, EXCLUDED.note),
         updated_at = now()`,
      [
        notification.authNumber, "Bloomingdale's", notification.carrier, notification.scac,
        notification.pickupDate,
        // The full carrier string is kept as the note because the difference between
        // "FEDEX GROUND" and "FEDEX GROUND- PARCEL-COLLECT" is a freight term, and the
        // short name is what the BOL prints. Nima made this same call by hand today.
        `Auto-applied from the Macy's routing notification` +
        (notification.receivedAt ? ` received ${notification.receivedAt.toISOString().slice(0, 10)}` : '') +
        (notification.carrierRaw ? ` · carrier "${notification.carrierRaw}"` : '') +
        (notification.appointmentNumber ? ` · appointment ${notification.appointmentNumber}` : ''),
      ],
    )
    let shipments = 0
    let fields = 0
    for (const a of writable) {
      // Only the fields the plan actually chose are written, and each is guarded by
      // its own condition rather than a blanket COALESCE, so this cannot revive a
      // value the plan deliberately declined to change.
      const { rowCount } = await client.query(
        `UPDATE routing_shipment
            SET auth_number  = COALESCE($2, auth_number),
                carrier      = COALESCE($3, carrier),
                scac         = COALESCE($4, scac),
                ship_date    = COALESCE($5::date, ship_date),
                ship_direct  = COALESCE($6::boolean, ship_direct),
                merge_center = COALESCE($7, merge_center),
                consigned_to = COALESCE($8, consigned_to),
                status      = CASE WHEN status IN ('needs_routing','submitted','bol_assigned')
                                   THEN 'authorized' ELSE status END,
                updated_at  = now()
          WHERE id = $1`,
        // ⚠️ The COALESCE here guards the PARAMETER, not the column: the planner
        // already decided each field, and only fields it chose are non-null. So a
        // field the plan declined to change is left alone, while one it chose is
        // written even when the stored value is a non-null default (`false` / 'CA').
        // That distinction is the whole fix — see the planner's note.
        [a.shipmentId, a.set.authNumber ?? null, a.set.carrier ?? null,
          a.set.scac ?? null, a.set.shipDate ?? null,
          a.set.shipDirect ?? null, a.set.mergeCenter ?? null, a.set.consignedTo ?? null],
      )
      shipments += rowCount
      fields += a.changes
    }
    await client.query('COMMIT')
    return { auths: 1, shipments, fields, dryRun: false }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function stampChecked(db = pool) {
  await db.query(
    `INSERT INTO sync_meta (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CHECKED_KEY, new Date().toISOString()],
  )
}

/** When did this lane last run? null = it never has. */
export async function lastCheckedAt(db = pool) {
  const { rows } = await db.query('SELECT value FROM sync_meta WHERE key = $1', [CHECKED_KEY])
  return rows[0]?.value || null
}

/**
 * The whole lane: fetch → match → apply what is unambiguous → report the rest.
 *
 * ⚠️ The stamp is written even when nothing matched. "We looked and there was nothing"
 * is a real result, and it is the one a surface needs in order to stop claiming that
 * a hand-entry lane is automated.
 */
export async function syncMacysRouting({ max = 100, dryRun = false, sinceDays = null } = {}) {
  const { fetched, parsed, checksumFailed, notifications } =
    await fetchRoutingNotifications({ max, sinceDays })
  const shipments = await loadMacysShipments()

  const reports = []
  let auths = 0, applied = 0, fields = 0
  for (const n of notifications) {
    const plan = planRoutingApply(n, shipments)
    reports.push({ notification: n, plan })
    if (plan.outOfScope) continue
    const w = await applyRouting(n, plan.applies, { dryRun })
    auths += w.auths
    applied += w.shipments
    fields += w.fields
  }
  if (!dryRun) await stampChecked()

  return {
    fetched, parsed, checksumFailed,
    notifications: notifications.length,
    live: reports.filter((r) => !r.plan.outOfScope).length,
    historical: reports.filter((r) => r.plan.outOfScope).length,
    auths, applied, fields, dryRun,
    reports,
  }
}

/** Match without writing — what `check:routing` and the UI read. */
export async function reconcileMacysRouting({ max = 100, sinceDays = null } = {}) {
  const { notifications, checksumFailed } = await fetchRoutingNotifications({ max, sinceDays })
  const shipments = await loadMacysShipments()
  return {
    checksumFailed,
    shipments,
    reports: notifications.map((n) => ({ notification: n, plan: planRoutingApply(n, shipments) })),
  }
}
