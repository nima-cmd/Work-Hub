// src/ingest/inboundShipmentLoad.js — read and write the vessel.
//
// ⚠️ A SHIPMENT ROW IS CREATED FROM THE SLIP, NOT INSTEAD OF IT. The container's
// identity is the packing slip's `container_label`, so storing a slip is what puts a
// vessel on the board — there is no second place to type a container's name, and
// therefore no way for the two to disagree about which shipment they mean.

import { pool } from '../db.js'
import { shipmentBoard, describeShipment, transitStats, sourceWins } from '../model/inboundShipment.js'
import { inferMode } from '../model/inboundShipment.js'

const rowToShipment = (r) => ({
  containerLabel: r.container_label,
  containerNum: r.container_num ?? null,
  mode: r.mode ?? null,
  modeSource: r.mode_source ?? null,
  // ⚠️ NAMED `departedOn` AND IT IS THE PACKING SLIP'S DATE — the day the factory told
  // us the goods were complete, which on the 59-carton container was EIGHT DAYS before
  // the vessel sailed. src/model/inboundShipment.js ANCHORS explains what each measures.
  departedOn: r.departed_on ? r.departed_on.toISOString().slice(0, 10) : null,
  // ⚠️ THIS WAS SELECTED BY `s.*` AND NEVER MAPPED, so the better anchor was invisible
  // to the model — `anchorFor` could only ever return `packed` and the ETD branch was
  // unreachable. Counter-bug shape 1 in CLAUDE.md, in a mapper rather than a counter.
  etdOn: r.etd_on ? r.etd_on.toISOString().slice(0, 10) : null,
  etaOn: r.eta_on ? r.eta_on.toISOString().slice(0, 10) : null,
  etaSource: r.eta_source ?? null,
  etaNote: r.eta_note ?? null,
  arrivedOn: r.arrived_on ? r.arrived_on.toISOString().slice(0, 10) : null,
  arrivedSource: r.arrived_source ?? null,
  arrivedRecordedAt: r.arrived_recorded_at ?? null,
  carrier: r.carrier ?? null,
  trackingNumber: r.tracking_number ?? null,
  notes: r.notes ?? null,
  unitCount: r.unit_count ?? null,
  cartonCount: r.carton_count ?? null,
  poNumbers: r.po_numbers ?? [],
})

const SELECT = `
  SELECT s.*, p.container_num, p.unit_count, p.carton_count, p.po_numbers,
         p.container_date
    FROM inbound_shipment s
    JOIN packing_slip p ON p.container_label = s.container_label`

/**
 * Ensure a vessel row exists for a stored container.
 *
 * ⚠️ `departed_on` COMES FROM THE SLIP'S OWN PRINTED DATE — the one document that
 * actually witnessed the shipment leaving. It is stored as observed, and a later
 * import of a reissued slip may correct it, because the factory reprinting a slip is
 * the only thing that would.
 *
 * ⚠️ MODE IS NOT STORED FROM THE GUESS. inferMode() reads "air" out of the label and
 * is usually right, but a stored guess is indistinguishable from a decision, and mode
 * picks which transit median an ETA is built on. The suggestion stays in the model.
 */
export async function ensureShipment(containerLabel, { departedOn = null, db = pool } = {}) {
  const { rows } = await db.query(
    `INSERT INTO inbound_shipment (container_label, departed_on)
     VALUES ($1, $2)
     ON CONFLICT (container_label) DO UPDATE SET
       departed_on = COALESCE(EXCLUDED.departed_on, inbound_shipment.departed_on),
       updated_at = now()
     RETURNING container_label`,
    [containerLabel, departedOn],
  )
  return rows[0]?.container_label ?? containerLabel
}

/**
 * Record what a person (or later, an email or a tracking lookup) says.
 *
 * ⚠️ THE SOURCE IS REQUIRED AND IT IS ENFORCED. `sourceWins` refuses to let an
 * estimate overwrite an entered date; without that rule the nightly estimate would
 * quietly erase the ETA a human typed after reading the forwarder's email, which is
 * the single most useful value on the record.
 *
 * ⚠️ AND MARKING AN ARRIVAL WRITES TWO DIFFERENT TIMES. `arrived_on` is the day it
 * landed — editable, because someone marking Monday's arrival on Wednesday must be
 * able to say Monday. `arrived_recorded_at` is now(), and is never editable. Only the
 * first feeds the transit statistics; only the second says how stale our knowledge is.
 */
export async function updateShipment(containerLabel, patch = {}, { db = pool } = {}) {
  const { rows: [current] } = await db.query(
    'SELECT eta_source, arrived_source FROM inbound_shipment WHERE container_label = $1',
    [containerLabel],
  )
  if (!current) throw new Error(`no shipment for ${containerLabel}`)

  const sets = []
  const vals = []
  const put = (col, v) => { sets.push(`${col} = $${vals.push(v) + 1}`) }

  if (patch.mode !== undefined) {
    put('mode', patch.mode || null)
    // A person choosing air or sea is a decision, and is marked as one so it is never
    // mistaken for the label guess.
    put('mode_source', patch.mode ? 'entered' : null)
  }
  if (patch.etaOn !== undefined) {
    const src = patch.etaSource || 'entered'
    if (!sourceWins(src, current.eta_source)) {
      throw new Error(`refusing to overwrite an ETA sourced '${current.eta_source}' with '${src}'`)
    }
    put('eta_on', patch.etaOn || null)
    put('eta_source', patch.etaOn ? src : null)
    put('eta_note', patch.etaNote ?? null)
  }
  if (patch.arrivedOn !== undefined) {
    put('arrived_on', patch.arrivedOn || null)
    put('arrived_source', patch.arrivedOn ? (patch.arrivedSource || 'marked') : null)
    // ⚠️ now(), not the arrival date. Clearing an arrival clears this too, or the
    // record would claim to know when something un-happened.
    put('arrived_recorded_at', patch.arrivedOn ? new Date() : null)
  }
  if (patch.departedOn !== undefined) put('departed_on', patch.departedOn || null)
  if (patch.carrier !== undefined) put('carrier', patch.carrier || null)
  if (patch.trackingNumber !== undefined) put('tracking_number', patch.trackingNumber || null)
  if (patch.notes !== undefined) put('notes', patch.notes || null)
  if (!sets.length) return fetchShipment(containerLabel, { db })

  await db.query(
    `UPDATE inbound_shipment SET ${sets.join(', ')}, updated_at = now() WHERE container_label = $1`,
    [containerLabel, ...vals],
  )
  return fetchShipment(containerLabel, { db })
}

/** One vessel, resolved — state, and an estimate only if the data supports one. */
export async function fetchShipment(containerLabel, { db = pool, now = () => new Date() } = {}) {
  const { rows } = await db.query(`${SELECT} WHERE s.container_label = $1`, [containerLabel])
  if (!rows.length) return null
  const all = await allShipments({ db })
  const { stats } = transitStats(all)
  const s = rowToShipment(rows[0])
  return { ...describeShipment(s, stats, now()), modeSuggestion: s.mode ? null : inferMode(s.containerLabel).mode }
}

/** Raw rows, for statistics. */
export async function allShipments({ db = pool } = {}) {
  const { rows } = await db.query(`${SELECT} ORDER BY s.departed_on DESC NULLS LAST`)
  return rows.map(rowToShipment)
}

/**
 * The board.
 *
 * ⚠️ STATISTICS ARE COMPUTED OVER EVERY SHIPMENT, INCLUDING ARRIVED ONES, and the
 * board is then rendered from the same list. Filtering to "in transit" before
 * computing would throw away every observed arrival — which is to say, all of the
 * evidence — and leave the estimate permanently unable to form.
 */
export async function fetchShipmentBoard({ db = pool, now = () => new Date() } = {}) {
  const all = await allShipments({ db })
  const board = shipmentBoard(all, now())
  return {
    ...board,
    rows: board.rows.map((r) => ({ ...r, modeSuggestion: r.mode ? null : inferMode(r.containerLabel).mode })),
  }
}
