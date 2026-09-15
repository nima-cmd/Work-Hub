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
  // ⚠️ `custbodycontainer` IS A DEDICATED CONTAINER FIELD AND THIS SYNC HAD NEVER READ
  // IT — it matched on `memo`, a free-text note. Measured 2026-09-15: 124 of 181 transfer
  // orders carry the purpose-built field and it DISAGREES with the memo on 86 of them.
  // TO95's memo is "PO1660"; its container field says "5 DHL 2026.4.6". Keying on a
  // hand-typed display field where an objective one exists is shape 3 in CLAUDE.md, and
  // the whole structural-key apparatus below exists because of a mismatch that the right
  // field would have narrowed from the start.
  //
  // ⚠️ `l.fullname`, NOT `BUILTIN.DF(t.transferlocation)` — and this cost a live bug in
  // the hour it was written. DF returns the LEAF name: "Nordstrom", where the location's
  // fullname is "Warehouse Bulk : Nordstrom". The HIERARCHY is the entire signal —
  // src/model/transferPurpose.js reads the "Warehouse Bulk : " prefix to tell partner
  // stock from the general floor, so with leaf names that branch was UNREACHABLE and all
  // 33 partner transfers would have read as unassigned. [[inbound-containers]] already
  // records this exact fullname-vs-leaf trap from the PO side.
  //
  // `custbodyrelated_po` is the PO link Nima described in his own account of the flow:
  // "we leave a link to the original PO in the transfer order so we know what PO its
  // for." It is an internal id, resolved to a document number further down.
  const head = await runSuiteQL(`
    SELECT t.tranid, t.memo, BUILTIN.DF(t.status) AS status, t.trandate,
           t.custbodycontainer AS container_field, t.custbodyrelated_po AS po_id,
           l.fullname AS destination
      FROM transaction t
      LEFT JOIN location l ON l.id = t.transferlocation
     WHERE t.type = 'TrnfrOrd' AND t.trandate >= TO_DATE('${since}','YYYY-MM-DD')`)
  if (!head.ok) return { ok: false, error: head.error }

  // ⚠️ RESOLVED IN ONE QUERY, NOT ONE PER TRANSFER. 119 of 181 carry a related PO and a
  // round trip each would be 119 calls against a one-vCPU deploy.
  const poIds = [...new Set(head.rows.map((r) => r.po_id).filter(Boolean))]
  const poName = new Map()
  if (poIds.length) {
    const p = await runSuiteQL(
      `SELECT id, tranid FROM transaction WHERE id IN (${poIds.map((n) => Number(n)).filter(Number.isFinite).join(',')})`)
    // ⚠️ A FAILED LOOKUP LEAVES THE PO NULL rather than failing the sync: the container
    // leg is the point, the PO number enriches it.
    if (p.ok) for (const row of p.rows) poName.set(String(row.id), row.tranid)
  }

  const qty = await runSuiteQL(`
    SELECT t.tranid, SUM(tl.quantity) AS units
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
     WHERE t.type = 'TrnfrOrd' AND tl.itemtype = 'InvtPart' AND tl.quantity > 0
       AND t.trandate >= TO_DATE('${since}','YYYY-MM-DD')
     GROUP BY t.tranid`)
  if (!qty.ok) return { ok: false, error: qty.error }
  const units = new Map(qty.rows.map((r) => [r.tranid, Number(r.units) || 0]))

  // ⚠️ THE THIRD QUERY IS WHERE DELIVERY COMES FROM, and it is the only place NetSuite
  // will tell us. A transfer order's own `trandate` and `status` say what it IS, never
  // when either end happened: a TO reading "Received" carries no receipt date, so before
  // this the app could not tell a container received yesterday from one received in May.
  //
  // `previoustransactionlinelink` holds the document chain. Off a transfer order it
  // yields two kinds, and they are opposite ends of the leg:
  //
  //   ItemShip  the transfer was fulfilled   — units left China's books
  //   ItemRcpt  the transfer was received    — units arrived on Glendale's
  //
  // ⚠️ AND `createdfrom` IS NOT AN ALTERNATIVE. `JOIN transaction src ON src.id =
  // t.createdfrom` and even a bare `SELECT createdfrom FROM transaction` both answer 500
  // UNEXPECTED_ERROR from SuiteQL. The link table is not the tidier option; it is the
  // one that works.
  //
  // ⚠️ DISTINCT IS LOAD-BEARING. The link table is per LINE, so a fifteen-line transfer
  // returns the same receipt fifteen times.
  const chain = await runSuiteQL(`
    SELECT DISTINCT src.tranid AS to_number, d.type AS doc_type, d.trandate AS doc_date, d.tranid AS doc_id
      FROM previoustransactionlinelink l
      JOIN transaction src ON src.id = l.previousdoc
      JOIN transaction d   ON d.id   = l.nextdoc
     WHERE src.type = 'TrnfrOrd' AND src.trandate >= TO_DATE('${since}','YYYY-MM-DD')
       AND d.type IN ('ItemShip','ItemRcpt')`)
  // The receipt's own NUMBER, so a card can link to the record rather than only date it.
  const rcptNo = new Map()
  // ⚠️ A FAILED CHAIN QUERY IS NOT A FAILED SYNC. The headers and units are the container
  // leg; the dates enrich it. Losing NetSuite's link table should leave delivery unknown
  // — which is a state this app models honestly — not throw away the whole run.
  const ship = new Map(); const rcpt = new Map()
  if (chain.ok) {
    for (const r of chain.rows) {
      // Latest wins: a transfer fulfilled in two shipments is finished by the last one,
      // the same MAX rule containerDelivery.receivedOn applies across a container.
      const m = r.doc_type === 'ItemRcpt' ? rcpt : ship
      const cur = m.get(r.to_number)
      const d = r.doc_date ? String(r.doc_date) : null
      if (d && (!cur || new Date(d) > new Date(cur))) {
        m.set(r.to_number, d)
        if (r.doc_type === 'ItemRcpt') rcptNo.set(r.to_number, r.doc_id || null)
      }
    }
  }

  return {
    ok: true,
    // ⚠️ Named so a surface can say "delivery dates are missing because NetSuite's link
    // table did not answer", rather than showing every container as never received.
    chainOk: chain.ok,
    chainError: chain.ok ? null : chain.error,
    rows: head.rows.map((r) => ({
      toNumber: r.tranid,
      memo: r.memo ?? null,
      status: r.status ?? null,
      trandate: r.trandate ? String(r.trandate) : null,
      fulfilledOn: ship.get(r.tranid) ?? null,
      receivedOn: rcpt.get(r.tranid) ?? null,
      receiptNumber: rcptNo.get(r.tranid) ?? null,
      containerField: r.container_field ?? null,
      poNumber: r.po_id ? (poName.get(String(r.po_id)) ?? null) : null,
      destination: r.destination ?? null,
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
      `INSERT INTO container_transfer (to_number, container_label, memo, status, trandate, units,
                                       fulfilled_on, received_on, container_field, matched_on,
                                       po_number, receipt_number, destination, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (to_number) DO UPDATE SET
         container_label = EXCLUDED.container_label, memo = EXCLUDED.memo,
         status = EXCLUDED.status, trandate = EXCLUDED.trandate,
         units = EXCLUDED.units, synced_at = now(),
         -- ⚠️ COALESCE KEEPS A DATE WE ALREADY HAVE when the chain query failed this
         -- run. Writing EXCLUDED straight through would blank every receipt date on the
         -- first bad round trip and report landed containers as never received.
         fulfilled_on = COALESCE(EXCLUDED.fulfilled_on, container_transfer.fulfilled_on),
         received_on  = COALESCE(EXCLUDED.received_on,  container_transfer.received_on),
         container_field = EXCLUDED.container_field,
         matched_on      = EXCLUDED.matched_on,
         destination     = EXCLUDED.destination,
         -- ⚠️ COALESCE for the two that come from a SECOND query. A failed PO or receipt
         -- lookup must not blank a number we already hold — the same reason the dates
         -- above are coalesced.
         po_number      = COALESCE(EXCLUDED.po_number, container_transfer.po_number),
         receipt_number = COALESCE(EXCLUDED.receipt_number, container_transfer.receipt_number)`,
      // ⚠️ `purpose` IS ABSENT FROM THE UPDATE LIST ON PURPOSE. It is entered by a person
      // and NetSuite knows nothing about it, so including it would have every sync wipe
      // it — the mistake that would make the whole feature look broken intermittently.
      [r.toNumber, r.containerLabel, r.memo, r.status, r.trandate, r.units, r.fulfilledOn,
       r.receivedOn, r.containerField, r.matchedOn ?? null, r.poNumber, r.receiptNumber, r.destination])
  }

  return {
    ok: true,
    fetched: t.rows.length,
    // ⚠️ Surfaced, not swallowed: without the chain every container reads as never
    // received, and that must be distinguishable from every container actually being at
    // sea. `dated` is how many legs have both ends.
    chainOk: t.chainOk,
    chainError: t.chainError,
    dated: t.rows.filter((r) => r.receivedOn).length,
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
