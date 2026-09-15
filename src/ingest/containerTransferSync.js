// src/ingest/containerTransferSync.js — pull the China → US transfer orders.
//
// ⚠️ THE ENTIRE CHINA LEG WAS INVISIBLE TO THIS APP. `npm run sync:transfers` filters to
// Office and Consignment and its own comment says "173 of 187 are NOT this work" — the
// twelve transfer orders carrying our three live containers are in that 173. Nothing
// showed that 3,066 units were in transit, or which PO each belonged to.
//
// ⚠️ MATCHED BY MEMO, WHICH IS THE CONTAINER LABEL. Not inferred from dates or
// destinations: the memo is the label byte for byte, and the units tie to the packing
// slip and the item receipt for every one of the twelve.

import { pool } from '../db.js'
import { runSuiteQL } from './netsuiteApi.js'
import { groupByContainer } from '../model/containerTransfer.js'

/**
 * Transfer orders since a date, with their memo and units.
 *
 * ⚠️ TWO QUERIES, AND NOT FOR TIDINESS. SuiteQL rejects `GROUP BY` over
 * `BUILTIN.DF(t.status)` with a bare "Invalid or unsupported search" — the status label
 * is a function call, not a groupable column. Selecting the headers and the unit sums
 * separately and joining them here is the shape that actually works.
 */
export async function fetchTransferOrders({ since = '2026-01-01' } = {}) {
  const head = await runSuiteQL(`
    SELECT t.tranid, t.memo, BUILTIN.DF(t.status) AS status, t.trandate
      FROM transaction t
     WHERE t.type = 'TrnfrOrd' AND t.trandate >= TO_DATE('${since}','YYYY-MM-DD')`)
  if (!head.ok) return { ok: false, error: head.error }

  const qty = await runSuiteQL(`
    SELECT t.tranid, SUM(tl.quantity) AS units
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
     WHERE t.type = 'TrnfrOrd' AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
       AND t.trandate >= TO_DATE('${since}','YYYY-MM-DD')
     GROUP BY t.tranid`)
  if (!qty.ok) return { ok: false, error: qty.error }
  const units = new Map(qty.rows.map((r) => [r.tranid, Number(r.units) || 0]))

  return {
    ok: true,
    rows: head.rows.map((r) => ({
      toNumber: r.tranid,
      memo: r.memo ?? null,
      status: r.status ?? null,
      trandate: r.trandate ? String(r.trandate) : null,
      // ⚠️ A TO with no positive inventory lines gets 0, not null — it exists and is
      // empty, which is a different thing from a quantity we failed to read.
      units: units.get(r.tranid) ?? 0,
    })),
  }
}

/**
 * Sync the container legs.
 *
 * ⚠️ IT STORES THE UNMATCHED ONES TOO, with a null container_label. A transfer order
 * whose memo names no container we hold is either not a container leg at all (TO215's
 * memo is "PO1616Transfer") or a container leg with a typo'd memo — and the second is
 * precisely the case that must not disappear.
 */
export async function syncContainerTransfers({ since = '2026-01-01', db = pool } = {}) {
  const t = await fetchTransferOrders({ since })
  if (!t.ok) return { ok: false, error: t.error }

  const { rows: labels } = await db.query('SELECT container_label FROM packing_slip')
  const { byContainer, unmatched, matchedLoosely, collided } = groupByContainer(
    t.rows, labels.map((r) => r.container_label))

  const toWrite = []
  for (const [label, tos] of byContainer) for (const to of tos) toWrite.push({ ...to, containerLabel: label })
  // ⚠️ Unmatched rows are written with a null label rather than skipped — see the docblock.
  for (const to of unmatched) toWrite.push({ ...to, containerLabel: null })

  for (const r of toWrite) {
    await db.query(
      `INSERT INTO container_transfer (to_number, container_label, memo, status, trandate, units, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (to_number) DO UPDATE SET
         container_label = EXCLUDED.container_label, memo = EXCLUDED.memo,
         status = EXCLUDED.status, trandate = EXCLUDED.trandate,
         units = EXCLUDED.units, synced_at = now()`,
      [r.toNumber, r.containerLabel, r.memo, r.status, r.trandate, r.units])
  }

  return {
    ok: true,
    fetched: t.rows.length,
    matched: toWrite.filter((r) => r.containerLabel).length,
    unmatched: unmatched.length,
    containers: byContainer.size,
    // ⚠️ Reported, not buried: a transfer order that matched only on carton-count +
    // date rather than on the whole label, and any structural key two containers share.
    matchedLoosely,
    collided,
  }
}
