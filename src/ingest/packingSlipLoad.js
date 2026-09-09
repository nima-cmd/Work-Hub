// src/ingest/packingSlipLoad.js — persist a parsed slip, and read it back.
//
// ⚠️ THE SLIP IS STORED, NOT PASSED THROUGH, and that is the whole reason this work
// moved into Work-Hub. Nima, 2026-09-09: "we can check the import to make sure
// nothing weird is happening we can track the shipment we can make sure were
// receiving it on time we can have a record to go back against ... if we we still
// have the information of whats in what box if we ever eneded to do a look up of an
// item by what container and box it was teh app would be able to help".
//
// A generator that emits two CSVs and forgets can answer none of those. NetSuite
// records the RECEIPT; only the slip records the PACKING, so if we do not keep it,
// nobody can ever say which box a bag arrived in.

import { pool } from '../db.js'
import { slipRevision } from '../model/packingSlipRevision.js'

/**
 * Insert or replace a container.
 *
 * ⚠️ LINES AND CARTONS ARE REPLACED, NOT MERGED. A reissued slip is the newest
 * truth about what shipped; merging would leave SKUs from a superseded version
 * sitting in the container forever, and no total would ever reconcile again.
 *
 * ⚠️ BUT THE CHANGE IS RECORDED FIRST. See src/model/packingSlipRevision.js — a
 * replace that alters the totals writes a revision row before deleting anything,
 * because the Item Receipt may already have gone to NetSuite on the old numbers.
 *
 * ⚠️ ONE TRANSACTION. A slip whose header landed and whose cartons did not would
 * read as a container with no boxes — indistinguishable from a master list, and
 * the exact wrong answer to "which box was it in".
 */
export async function savePackingSlip(container, { sourceFilename = null, db = pool } = {}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [stored] } = await client.query(
      'SELECT container_num, unit_count, carton_count, po_numbers FROM packing_slip WHERE container_num = $1',
      [container.containerNum],
    )
    const rev = slipRevision(stored, container, { sourceFilename })
    if (rev.revision) {
      const r = rev.revision
      await client.query(
        `INSERT INTO packing_slip_revision
           (container_num, prev_units, new_units, prev_cartons, new_cartons, source_filename, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.containerNum, r.prevUnits, r.newUnits, r.prevCartons, r.newCartons, r.sourceFilename, r.note],
      )
    }

    await client.query(
      `INSERT INTO packing_slip (container_num, container_date, format, source_filename,
                                 unit_count, carton_count, po_numbers, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (container_num) DO UPDATE SET
         container_date = EXCLUDED.container_date, format = EXCLUDED.format,
         source_filename = EXCLUDED.source_filename, unit_count = EXCLUDED.unit_count,
         carton_count = EXCLUDED.carton_count, po_numbers = EXCLUDED.po_numbers,
         updated_at = now()`,
      [container.containerNum, container.containerDate, container.format || 'factory',
       sourceFilename, container.unitCount, container.cartonCount, container.poNumbers],
    )

    await client.query('DELETE FROM packing_slip_line WHERE container_num = $1', [container.containerNum])
    for (const l of container.skuTotals || []) {
      await client.query(
        `INSERT INTO packing_slip_line (container_num, po_number, sku, style, color, units)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (container_num, po_number, sku) DO UPDATE SET units = EXCLUDED.units`,
        [container.containerNum, l.poNumber, l.sku, l.style, l.color, l.units],
      )
    }

    await client.query('DELETE FROM packing_slip_carton WHERE container_num = $1', [container.containerNum])
    for (const [po, boxes] of Object.entries(container.cartons || {})) {
      for (const b of boxes) {
        for (const it of b.items) {
          await client.query(
            `INSERT INTO packing_slip_carton (container_num, po_number, box, sku, qty)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (container_num, po_number, box, sku) DO UPDATE SET qty = EXCLUDED.qty`,
            [container.containerNum, po, b.box, it.sku, it.qty],
          )
        }
      }
    }
    await client.query('COMMIT')
    return { containerNum: container.containerNum, ...rev, lines: (container.skuTotals || []).length }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * Where did this SKU arrive — which container, which box?
 *
 * ⚠️ THE QUESTION NOTHING ELSE HERE CAN ANSWER. NetSuite knows it was received; the
 * bin map knows where it sits now. Only the slip knows which carton it came out of,
 * which is what someone holding a mystery bag actually needs.
 */
export async function findSkuInCartons(sku, { db = pool, limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT c.container_num, s.container_date, c.po_number, c.box, c.qty, s.imported_at
       FROM packing_slip_carton c
       JOIN packing_slip s ON s.container_num = c.container_num
      WHERE upper(c.sku) = upper($1)
      ORDER BY s.imported_at DESC, c.po_number, c.box
      LIMIT $2`,
    [sku, limit],
  )
  return rows.map((r) => ({
    containerNum: r.container_num,
    containerDate: r.container_date,
    poNumber: r.po_number,
    box: r.box,
    qty: r.qty,
    importedAt: r.imported_at,
  }))
}

/** Everything on one container, in both shapes. */
export async function fetchPackingSlip(containerNum, { db = pool } = {}) {
  const { rows: [slip] } = await db.query('SELECT * FROM packing_slip WHERE container_num = $1', [containerNum])
  if (!slip) return null
  const { rows: lines } = await db.query(
    'SELECT po_number, sku, style, color, units FROM packing_slip_line WHERE container_num = $1 ORDER BY po_number, sku',
    [containerNum],
  )
  const { rows: cartonRows } = await db.query(
    'SELECT po_number, box, sku, qty FROM packing_slip_carton WHERE container_num = $1 ORDER BY po_number, box, sku',
    [containerNum],
  )
  const cartons = {}
  for (const r of cartonRows) {
    const list = (cartons[r.po_number] ??= [])
    let box = list.find((b) => b.box === r.box)
    if (!box) { box = { box: r.box, items: [] }; list.push(box) }
    box.items.push({ sku: r.sku, qty: r.qty })
  }
  const { rows: revisions } = await db.query(
    'SELECT observed_at, prev_units, new_units, prev_cartons, new_cartons, note FROM packing_slip_revision WHERE container_num = $1 ORDER BY observed_at DESC',
    [containerNum],
  )
  return {
    containerNum: slip.container_num,
    containerDate: slip.container_date,
    format: slip.format,
    sourceFilename: slip.source_filename,
    unitCount: slip.unit_count,
    cartonCount: slip.carton_count,
    poNumbers: slip.po_numbers,
    importedAt: slip.imported_at,
    skuTotals: lines.map((l) => ({ poNumber: l.po_number, sku: l.sku, style: l.style, color: l.color, units: l.units })),
    cartons,
    revisions,
  }
}

/** Every stored container, newest first. */
export async function listPackingSlips({ db = pool, limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT s.container_num, s.container_date, s.format, s.unit_count, s.carton_count,
            s.po_numbers, s.imported_at,
            (SELECT COUNT(*) FROM packing_slip_revision r WHERE r.container_num = s.container_num) AS revisions
       FROM packing_slip s ORDER BY s.imported_at DESC LIMIT $1`, [limit],
  )
  return rows.map((r) => ({
    containerNum: r.container_num, containerDate: r.container_date, format: r.format,
    unitCount: r.unit_count, cartonCount: r.carton_count, poNumbers: r.po_numbers,
    importedAt: r.imported_at, revisions: Number(r.revisions),
  }))
}
