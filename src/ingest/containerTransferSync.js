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
import { aliasesFor } from '../model/containerAlias.js'

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
  // ⚠️ RECORDED ALIASES ARE CONSULTED FIRST. Without this the sync re-derives
  // "55 LCL to LA carton 2026.9.7" structurally on every run — a hypothesis repeated
  // forever instead of a fact written down once and correctable by a person.
  const { rows: aliasRows } = await db.query('SELECT alias, container_label FROM container_alias')
  const aliasMap = new Map(aliasRows.map((r) => [r.alias, r.container_label]))

  const { byContainer, unmatched, matchedLoosely, collided } = groupByContainer(
    t.rows, labels.map((r) => r.container_label), aliasMap)

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

/**
 * Record every name a container is known by.
 *
 * ⚠️ THIS IS WHAT TURNS A GUESS INTO A FACT. The transfer-order sync finds "55 LCL to LA
 * carton 2026.9.7" by structural key — carton count plus date — which is a hypothesis
 * re-derived on every run. Writing it down means the next sync matches on recorded data,
 * and a wrong one is a row somebody can see and delete rather than behaviour buried in a
 * regex.
 */
export async function syncContainerAliases({ db = pool } = {}) {
  const { rows: slips } = await db.query(
    `SELECT p.container_label AS label, p.source_filename AS filename,
            i.forwarder_ref, i.tracking_number
       FROM packing_slip p LEFT JOIN inbound_shipment i USING (container_label)`)

  let written = 0
  for (const s of slips) {
    const { rows: memos } = await db.query(
      'SELECT DISTINCT memo FROM container_transfer WHERE container_label = $1 AND memo IS NOT NULL',
      [s.label])
    const aliases = aliasesFor({
      label: s.label,
      filename: s.filename,
      memos: memos.map((m) => m.memo),
      forwarderRef: s.forwarder_ref,
      trackingNumber: s.tracking_number,
    })
    for (const a of aliases) {
      // ⚠️ DO NOTHING on conflict, never re-point. An alias already attached to another
      // container is a collision worth seeing, not something to silently move.
      const r = await db.query(
        `INSERT INTO container_alias (alias, container_label, source) VALUES ($1,$2,$3)
         ON CONFLICT (alias) DO NOTHING`,
        [a.alias, s.label, a.source])
      written += r.rowCount
    }
  }
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int n FROM container_alias')
  return { ok: true, written, total: n }
}
