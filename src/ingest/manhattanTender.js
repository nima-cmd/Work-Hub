// src/ingest/manhattanTender.js — pull Nordstrom's TMS tender emails and persist them.
//
// The parse rules and every trap live in src/model/manhattanTender.js (pure, tested).
// This file only fetches, upserts, and reads back for reconciliation — the same split
// as asnCartonSync.js, so the CLI, the check and any future cron share one path.

import { pool } from '../db.js'
import { searchMessages } from './gmail.js'
import { parseTenderEmail, reconcileTender } from '../model/manhattanTender.js'

// Manhattan sends other mail (account setup, password resets) from the same address, so
// the subject is part of the filter. Both are matched again in the parser, which returns
// null for anything without a ShipmentId — a mailbox is not a schema.
export const TENDER_QUERY = 'from:cpadmin@support.manh.com subject:"Tender Accepted" in:anywhere'

export async function fetchTenders({ max = 100, sinceDays = null } = {}) {
  // The scheduled caller passes a small window so the common case is ONE cheap search
  // returning nothing — tenders arrive a few times a month, not a few times an hour.
  // The CLI passes none and sweeps everything.
  const query = sinceDays ? `${TENDER_QUERY} newer_than:${sinceDays}d` : TENDER_QUERY
  const messages = await searchMessages({ query, max })
  const parsed = []
  for (const m of messages) {
    const t = parseTenderEmail({
      subject: m.subject, body: m.body, receivedAt: m.receivedAt, messageId: m.id,
    })
    if (t) parsed.push(t)
  }
  // ⚠️ A re-sent tender is the SAME shipment (S000137008 arrived twice). Keep the most
  // recently received copy per shipment id so the upsert is deterministic regardless of
  // the order Gmail returns them in.
  const byId = new Map()
  for (const t of parsed) {
    const prev = byId.get(t.shipmentId)
    if (!prev || (t.tenderedAt?.getTime() || 0) >= (prev.tenderedAt?.getTime() || 0)) {
      byId.set(t.shipmentId, t)
    }
  }
  return { fetched: messages.length, parsed: parsed.length, tenders: [...byId.values()] }
}

export async function upsertTenders(tenders, { dryRun = false } = {}) {
  if (dryRun || !tenders.length) return { tenders: tenders.length, stops: 0, dryRun }
  const client = await pool.connect()
  let stops = 0
  try {
    await client.query('BEGIN')
    for (const t of tenders) {
      await client.query(
        `INSERT INTO tms_tender (
           shipment_id, partner, message_id, tendered_at, pickup_at, pickup_raw, carrier,
           origin_facility, origin_city, origin_state, dest_facility, dest_city, dest_state,
           total_cartons, total_weight_lb, total_volume_cuft, srr_pairing, srr_count, spo_count)
         VALUES ($1,'Nordstrom',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (shipment_id) DO UPDATE SET
           message_id = EXCLUDED.message_id, tendered_at = EXCLUDED.tendered_at,
           pickup_at = EXCLUDED.pickup_at, pickup_raw = EXCLUDED.pickup_raw,
           carrier = EXCLUDED.carrier,
           origin_facility = EXCLUDED.origin_facility, origin_city = EXCLUDED.origin_city,
           origin_state = EXCLUDED.origin_state, dest_facility = EXCLUDED.dest_facility,
           dest_city = EXCLUDED.dest_city, dest_state = EXCLUDED.dest_state,
           total_cartons = EXCLUDED.total_cartons, total_weight_lb = EXCLUDED.total_weight_lb,
           total_volume_cuft = EXCLUDED.total_volume_cuft, srr_pairing = EXCLUDED.srr_pairing,
           srr_count = EXCLUDED.srr_count, spo_count = EXCLUDED.spo_count,
           updated_at = now()`,
        [t.shipmentId, t.messageId, t.tenderedAt, t.pickupAt, t.pickupRaw, t.carrier,
          t.originFacility, t.originCity, t.originState, t.destFacility, t.destCity, t.destState,
          t.totalCartons, t.totalWeightLb, t.totalVolumeCuft, t.srrPairing, t.srrCount, t.spoCount],
      )
      // Replace this tender's stops wholesale. Scoped to the one shipment id, so a
      // re-send that genuinely dropped a DC is reflected rather than left behind — the
      // sweep can never reach another shipment's rows.
      await client.query('DELETE FROM tms_tender_stop WHERE shipment_id = $1', [t.shipmentId])
      for (const s of t.stops) {
        await client.query(
          `INSERT INTO tms_tender_stop (shipment_id, dc, dc_raw, seq, srr, po_numbers)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [t.shipmentId, s.dc, s.dcRaw, s.seq, s.srr, s.poNumbers],
        )
        stops++
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return { tenders: tenders.length, stops, dryRun: false }
}

export async function syncTenders({ max = 100, dryRun = false, sinceDays = null } = {}) {
  const { fetched, parsed, tenders } = await fetchTenders({ max, sinceDays })
  const written = await upsertTenders(tenders, { dryRun })
  return { fetched, parsed, shipments: tenders.length, ...written, tenders }
}

/** Read persisted tenders back, newest first, shaped like the model's parse output. */
export async function loadTenders({ limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT t.*, COALESCE(json_agg(
              json_build_object('dc', s.dc, 'dcRaw', s.dc_raw, 'seq', s.seq,
                                'srr', s.srr, 'poNumbers', s.po_numbers)
              ORDER BY s.seq) FILTER (WHERE s.dc IS NOT NULL), '[]') AS stops
       FROM tms_tender t
       LEFT JOIN tms_tender_stop s ON s.shipment_id = t.shipment_id
      GROUP BY t.shipment_id
      ORDER BY t.pickup_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({
    shipmentId: r.shipment_id,
    partner: r.partner,
    tenderedAt: r.tendered_at,
    pickupAt: r.pickup_at,
    pickupRaw: r.pickup_raw,
    carrier: r.carrier,
    originFacility: r.origin_facility, originCity: r.origin_city, originState: r.origin_state,
    destFacility: r.dest_facility, destCity: r.dest_city, destState: r.dest_state,
    totalCartons: r.total_cartons,
    totalWeightLb: r.total_weight_lb == null ? null : Number(r.total_weight_lb),
    totalVolumeCuft: r.total_volume_cuft == null ? null : Number(r.total_volume_cuft),
    srrPairing: r.srr_pairing, srrCount: r.srr_count, spoCount: r.spo_count,
    stops: r.stops || [],
  }))
}

/** The routing shipments a tender could match, in the shape reconcileTender wants. */
export async function loadRoutingShipments(partner = 'Nordstrom') {
  const { rows } = await pool.query(
    `SELECT id, dc, cartons, ship_date AS "shipDate", carrier, bol_number AS "bolNumber",
            status, member_pos AS "memberPos",
            routing_request_number AS "routingRequestNumber"
       FROM routing_shipment WHERE partner = $1 ORDER BY id`,
    [partner],
  )
  return rows
}

export async function reconcileAll({ limit = 20 } = {}) {
  const [tenders, shipments] = await Promise.all([loadTenders({ limit }), loadRoutingShipments()])
  return tenders.map((t) => ({ tender: t, report: reconcileTender(t, shipments) }))
}
