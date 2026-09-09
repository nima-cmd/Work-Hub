// src/ingest/containerVerifyLive.js — fetch the NetSuite side of a container check.
//
// ⚠️ QUERIED BY EXTERNAL ID, which is the whole trick: the keys are recomputed from
// the container label (see src/model/containerVerify.js), so there is no link table
// to keep in sync and no chance of the app believing a pairing NetSuite does not have.
//
// ⚠️ AND THE BLIND SPOT IS DECLARED, NOT PAPERED OVER. This login can see 11
// transaction types; Inventory Transfer is not one of them. On 2026-09-09 that gap
// made me report "no transfer was ever created" when two had been — I was reading a
// permission boundary as an absence. So a container whose transfer was imported as an
// Inventory Transfer rather than a Transfer Order will read as MISSING here, and the
// result says so rather than pretending the check is complete.

import { runSuiteQL } from './netsuiteApi.js'

/** Transaction types this login is permitted to see. Anything else is invisible. */
export const VISIBLE_TYPES = [
  'CashRfnd', 'CashSale', 'CustCred', 'CustInvc', 'Deposit',
  'Estimate', 'ItemRcpt', 'ItemShip', 'PurchOrd', 'SalesOrd', 'TrnfrOrd',
]

/**
 * ⚠️ Inventory Transfer (`InvTrnfr`) is NOT in that list, and it is the record type a
 * container transfer lands in when someone picks the wrong import type — which the
 * generated filename actively invites, because it says "Inventory Transfer" while
 * every one of the 187 historical records is a Transfer Order.
 */
export const INVISIBLE_TRANSFER_TYPE = 'InvTrnfr'

const sqlList = (vals) => vals.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',')

/**
 * Look up every record carrying one of these External IDs, with the receipt lines.
 *
 * @param externalIds the keys from expectedKeys()
 * @returns { byExternalId: Map, blindSpot: {...} }
 */
export async function fetchContainerRecords(externalIds = [], { _runSuiteQL = runSuiteQL } = {}) {
  const ids = [...new Set(externalIds.filter(Boolean))]
  if (!ids.length) return { byExternalId: new Map(), blindSpot: blindSpotNote() }

  const heads = await _runSuiteQL(
    `SELECT t.id, t.type, t.tranid, t.externalid, t.trandate,
            ts.fullname AS status
       FROM transaction t
       LEFT JOIN transactionstatus ts ON ts.id = t.status AND ts.trantype = t.type
      WHERE t.externalid IN (${sqlList(ids)})`,
  )
  const rows = heads.rows || heads.data || heads
  const byExternalId = new Map()
  const receiptIds = []
  for (const r of rows) {
    const rec = {
      id: r.id, type: r.type, tranid: r.tranid,
      status: r.status || null, trandate: r.trandate || null, lines: [],
    }
    byExternalId.set(r.externalid, rec)
    if (r.type === 'ItemRcpt') receiptIds.push(r.id)
  }

  // ⚠️ RECEIPT LINES ONLY. A Transfer Order writes three lines per item (two negative
  // at the source, one positive at the destination), so pulling its lines invites the
  // sum-them trap. verifyContainer compares quantities on the receipt for that reason.
  if (receiptIds.length) {
    const lines = await _runSuiteQL(
      `SELECT t.externalid, i.itemid AS sku, tl.quantity AS qty
         FROM transactionline tl
         JOIN transaction t ON t.id = tl.transaction
         JOIN item i ON i.id = tl.item
        WHERE t.id IN (${receiptIds.join(',')}) AND tl.itemtype = 'InvtPart'`,
    )
    for (const l of (lines.rows || lines.data || lines)) {
      byExternalId.get(l.externalid)?.lines.push({ sku: l.sku, qty: Number(l.qty) || 0 })
    }
  }

  return { byExternalId, blindSpot: blindSpotNote() }
}

const blindSpotNote = () => ({
  invisibleTypes: [INVISIBLE_TRANSFER_TYPE, 'InvAdjst'],
  note: 'This login cannot read Inventory Transfers or Inventory Adjustments. '
      + 'A transfer imported as an Inventory Transfer instead of a Transfer Order '
      + 'will read as MISSING here. Grant the Claude bot role view access to remove '
      + 'this gap.',
})
