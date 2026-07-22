// server/queries.js — read orders (+ their fulfillments) from Neon and enrich
// each with the SAME pipeline flags the CLI analyzer uses, so UI and analyzer
// never disagree.

import { pool } from '../src/db.js'
import { computeFlags } from '../src/model/pipeline.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'
import { SOURCE_LABELS, REQUIRED_SOURCES, SOURCE_LINKS } from '../src/ingest/detect.js'
import {
  fetchOrderConfirmations, fetchPurchaseOrders, fetchOcPoLinks,
  upsertOcPoLink, deleteOcPoLink, dismissOrderConfirmation, dismissPurchaseOrder,
} from '../src/ingest/loadToDb.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeContainerView } from '../src/model/ocPoContainers.js'
import { computeEdiPipeline } from '../src/model/ediPipeline.js'
import { computeEdiWork } from '../src/model/ediWork.js'
import { computeAffection } from '../src/model/affection.js'
import { fetchEdiTransactions, syncOrderful, fetchEdiDocumentPoRefs } from '../src/ingest/orderful.js'
import {
  fetchEdiFulfillments, fetchEdiManualLinks, upsertEdiManualLink, deleteEdiManualLink,
  createEdiManualOrder, fetchEdiManualOrders, deleteEdiManualOrder,
  fetchEdiPoResolutions, upsertEdiPoResolution, deleteEdiPoResolution,
  fetchEdiTransactionAcks, upsertEdiTransactionAck, deleteEdiTransactionAck,
  fetchSeasons, upsertSeason,
  fetchEdiSupply, upsertEdiSupply, deleteEdiSupply,
  fetchLinksFor, addDocLink, deleteDocLink,
} from '../src/ingest/loadToDb.js'
import { insertOrderEvent, fetchOrderEvents, insertFulfillmentBox } from '../src/ingest/loadToDb.js'
import {
  fetchEdiPackages, assignBol, fetchRoutingShipments, voidRoutingShipment,
  updateShipmentRefs, upsertRoutingAuth, fetchRoutingAuths, assignAuthToShipments, deleteRoutingAuth,
  fetchRoutingShipmentById,
} from '../src/ingest/loadToDb.js'
import { consolidateRouting } from '../src/model/routing.js'
import { buildBolPdf, renderBolTo } from './bolPdf.js'
import { uploadBolPdf } from '../src/ingest/googleDrive.js'
import {
  fetchQuestEmails, loadQuestEmails, reconcileReadStatus, assignQuestEmailCharacter, markQuestEmailReadLocal, dismissQuestEmail, setQuestEmailNote,
  fetchQuestEmailById, createQuestTask, createManualTask, fetchQuestTasks, fetchQuestTaskById, fetchOpenReplyTasks, completeQuestTask,
  updateTaskNeeds, updateTaskUrgency, updateTaskCharacter, searchQuestEmails, searchQuestTasks, logTaskActivity, fetchTaskActivity,
  fetchActiveRecurringTemplates, createRecurringTaskInstance, updateTaskChecklistItem,
  fetchOpenRecurringInstances, escalateRecurringTask, deleteQuestTask,
  createEdiTask, fetchEdiTaskStates, closeEdiTask,
} from '../src/ingest/loadToDb.js'
import { fetchInboxMessages, markMessageRead, applyLabel, fetchThread, getProfile, listUserLabels, markMessageSpam } from '../src/ingest/gmail.js'
import { fetchCalendarEvents } from '../src/ingest/googleCalendar.js'
import { getCharacterById, CHARACTERS } from '../src/model/characters.js'
import { NETSUITE_DOC_TYPES, normalizeDocNumber } from '../src/model/netsuiteDocs.js'
import { parseDcToken, parseDc, dcAbbrev } from '../src/model/dc.js'

export async function getOrders() {
  // Subqueries (not joins+GROUP BY) for fulfillments and invoices: both are
  // one-to-many off orders, and joining both at once would cross-multiply
  // (2 fulfillments x 3 invoices = 6 rows) before aggregation.
  const { rows } = await pool.query(`
    SELECT o.*,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'ifNumber', f.if_number, 'status', f.status,
            'packedStatus', f.packed_status, 'daysPending', f.days_pending,
            'invoice', f.invoice_number, 'actualShipDate', f.actual_ship_date,
            'ifDate', f.if_date,
            'custodyOut', (SELECT MAX(e.occurred_at) FROM order_events e
                           WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'CUSTODY_OUT'),
            'custodyIn',  (SELECT MAX(e.occurred_at) FROM order_events e
                           WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'CUSTODY_IN')
          ) ORDER BY f.if_number
        )
        FROM fulfillments f WHERE f.so_number = o.so_number
      ), '[]'::json) AS fulfillments,
      (SELECT MAX(f.days_pending) FROM fulfillments f WHERE f.so_number = o.so_number) AS days_pending,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'invNumber', i.inv_number, 'status', i.status,
            'shippingStatus', i.shipping_status,
            'amountRemaining', i.amount_remaining, 'shipDate', i.ship_date
          ) ORDER BY i.inv_number
        )
        FROM invoices i WHERE i.so_number = o.so_number
      ), '[]'::json) AS invoices
    FROM orders o
  `)

  const today = new Date()
  return rows.map((r) => {
    const o = {
      soNumber: r.so_number,
      customer: r.customer,
      location: r.location,
      isAts: r.is_ats,
      source: r.source,
      stage: r.stage,
      stageLabel: STAGE_LABEL[r.stage] || r.stage,
      stageRank: STAGE_RANK[r.stage] || 0,
      nextAction: NEXT_ACTION[r.stage] || '',
      poNumber: r.po_number,
      soStatus: r.so_status,
      qtyOrdered: num(r.qty_ordered),
      qtyAllocated: num(r.qty_allocated),
      qtyFulfilled: num(r.qty_fulfilled),
      shippingStatus: r.shipping_status,
      shipDate: r.ship_date,
      startDate: r.start_date,
      endDate: r.end_date,
      cancelDate: r.cancel_date,
      daysPending: r.days_pending,
      notes: r.notes,
      approvalStatus: r.approval_status,
      billingStatus: r.billing_status,
      amountPaid: num(r.amount_paid),
      fulfillments: r.fulfillments,
      invoices: r.invoices,
    }
    o.flags = computeFlags(o, today)
    o.severity = o.flags.reduce((m, f) => Math.max(m, f.severity), 0)
    return o
  })
}

const num = (v) => (v == null ? null : Number(v))

// ── Custody scans (QR labels — Nima, 2026-07-17) ─────────────────────────────
// direction 'OUT' = handed to the warehouse; 'IN' = received back. The scan is
// the source of truth for the physical handoff, so an event is recorded even
// when the IF isn't (yet) in our data — `found:false` warns the scanner, and
// the event backfills its meaning once the next CSV import brings the IF in.
export async function recordCustodyScan({ docNumber, direction, note, confirm = false }) {
  const dir = String(direction || '').toUpperCase()
  if (dir !== 'OUT' && dir !== 'IN') throw new Error(`direction must be OUT or IN, got: ${direction}`)
  const eventType = dir === 'OUT' ? 'CUSTODY_OUT' : 'CUSTODY_IN'

  // Per-DC cargo tags (Nima, 2026-07-21) encode a `DC:<po>:<abbrev>` token, not
  // an IF. Resolve the customer/partner from the PO so the scan shows it's
  // Bloomingdale's + which DC, and log custody keyed by the PO+DC carton.
  // Also recognize a BARE customer-PO scan (Nima, 2026-07-22): the older EDI
  // labels encoded just the PO number, so a scan that isn't an IF but matches a
  // known PO is treated as PO-level custody — those labels work without reprint.
  const raw = String(docNumber || '').trim()
  let dcTok = parseDcToken(raw)
  if (!dcTok && raw && !/^IF/i.test(raw)) {
    const { rows: m } = await pool.query(`SELECT 1 FROM orders WHERE po_number = $1 LIMIT 1`, [raw])
    if (m.length) dcTok = { poNumber: raw, dc: null }
  }
  if (dcTok) {
    const po = dcTok.poNumber
    const doc = `${po}:${dcTok.dc || ''}`
    // Count the scanned DC's stores specifically (match the label), and grab a
    // sample customer for that DC so the channel tag reads right.
    const { rows: poRows } = await pool.query(
      `SELECT customer, location FROM orders WHERE po_number = $1 ORDER BY so_number`, [po])
    const inDc = dcTok.dc ? poRows.filter((r) => dcAbbrev(parseDc(r.customer)) === dcTok.dc) : poRows
    const sample = (inDc[0] || poRows[0]) || null
    const cnt = [{ n: inDc.length }]
    const { rows: prior } = await pool.query(
      `SELECT count(*)::int AS n, MAX(occurred_at) AS last
       FROM order_events WHERE doc_type='DC' AND doc_number=$1 AND event_type=$2`, [doc, eventType])
    if (prior[0].n > 0 && !confirm) {
      return { needsConfirm: true, isDc: true, direction: dir, docNumber: doc,
        poNumber: po, dc: dcTok.dc, customer: sample?.customer || null, location: sample?.location || null,
        storeCount: cnt[0].n, priorSameDir: prior[0].n, lastSameDirAt: prior[0].last, found: !!sample }
    }
    const event = await insertOrderEvent({ eventType, docType: 'DC', docNumber: doc, soNumber: null, note, source: 'scan' })
    return { ok: true, isDc: true, direction: dir, docNumber: doc, poNumber: po, dc: dcTok.dc,
      customer: sample?.customer || null, location: sample?.location || null, storeCount: cnt[0].n,
      occurredAt: event.occurredAt, repeat: prior[0].n > 0, found: !!sample }
  }

  const doc = normalizeDocNumber('IF', String(docNumber || '').trim())
  if (!doc || doc === 'IF') throw new Error('no document number scanned')

  const { rows } = await pool.query(
    `SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber", f.status, f.packed_status AS "packedStatus",
            o.customer, o.po_number AS "poNumber"
     FROM fulfillments f LEFT JOIN orders o ON o.so_number = f.so_number
     WHERE f.if_number = $1`,
    [doc],
  )
  const fulfillment = rows[0] || null

  // Guard against duplicate logs (Nima, 2026-07-17): an IF should go OUT once
  // and IN once. If it's already been scanned this same direction, don't
  // silently pile on another log — hand back a needsConfirm so the Scan Bay can
  // ask "log it again?" and let a real re-handoff carry a note ("gave it back
  // for a fix"). `confirm:true` is the user saying yes; only then do we insert.
  const { rows: prior } = await pool.query(
    `SELECT count(*)::int AS n, MAX(occurred_at) AS last
     FROM order_events WHERE doc_type='IF' AND doc_number=$1 AND event_type=$2`,
    [doc, eventType],
  )
  const priorSameDir = prior[0].n
  if (priorSameDir > 0 && !confirm) {
    return {
      needsConfirm: true,
      direction: dir,
      docNumber: doc,
      priorSameDir,
      lastSameDirAt: prior[0].last,
      found: !!fulfillment,
      fulfillment,
    }
  }

  const event = await insertOrderEvent({
    eventType,
    docType: 'IF',
    docNumber: doc,
    soNumber: fulfillment?.soNumber || null,
    note,
    source: 'scan',
  })

  return {
    ok: true,
    found: !!fulfillment,
    direction: dir,
    docNumber: doc,
    occurredAt: event.occurredAt,
    repeat: priorSameDir > 0, // a confirmed re-scan (dupe or re-handoff)
    fulfillment,
  }
}

// The ledger feed — custody scans (and future derived transitions), scoped to
// a day for the Calendar or unscoped for a recent-history view.
export async function getOrderEventsFeed({ date, docNumber, soNumber } = {}) {
  return fetchOrderEvents({ date, docNumber, soNumber })
}

// ── Box capture (Nima, 2026-07-17) — the IN-scan carton measurement ──────────
// Called from the Scan Bay right after an IN scan (skippable). Everything but
// the IF is optional; a box with no measurements at all is rejected so a stray
// empty submit doesn't create noise.
const numOrNull = (v) => (v == null || v === '' ? null : Number(v))
export async function recordFulfillmentBox({ ifNumber, weightLb, lengthIn, widthIn, heightIn, note }) {
  const doc = normalizeDocNumber('IF', String(ifNumber || '').trim())
  if (!doc || doc === 'IF') throw new Error('no IF number for the box')
  const dims = { weightLb: numOrNull(weightLb), lengthIn: numOrNull(lengthIn), widthIn: numOrNull(widthIn), heightIn: numOrNull(heightIn) }
  const hasAny = Object.values(dims).some((v) => v != null) || (note && note.trim())
  if (!hasAny) throw new Error('nothing to record — enter a weight or a dimension')
  const box = await insertFulfillmentBox({ ifNumber: doc, ...dims, note })
  return { ok: true, box }
}

// ── Custody register (Nima, 2026-07-17) ──────────────────────────────────────
// Every IF that entered the custody gap (has at least one OUT/IN scan) and
// hasn't departed yet — the "nothing sits ignored" list for physical cargo.
// State comes from latest OUT vs latest IN: 'with_warehouse' (out for
// pick/pack, or re-handed out after a fix) vs 'returned' (back in our hands,
// boxed, waiting to leave). Departed IFs are cleaned out by clearDepartedCustody
// at ingest, and the actual_ship_date guard here is the belt-and-suspenders.
export async function getCustodyRegister({ today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT c.if_number AS "ifNumber",
           c.custody_out AS "custodyOut", c.custody_in AS "custodyIn", c.first_scan AS "firstScan",
           f.so_number AS "soNumber", f.packed_status AS "packedStatus", f.status,
           o.customer, o.source, o.po_number AS "poNumber",
           COALESCE(b.boxes, 0) AS boxes, COALESCE(b.weight, 0) AS "boxWeight",
           COALESCE(bl.list, '[]'::json) AS "boxList"
    FROM (
      SELECT doc_number AS if_number,
             MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_OUT') AS custody_out,
             MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_IN')  AS custody_in,
             MIN(occurred_at) AS first_scan,
             -- CUSTODY_CLEARED (written at departure) is pinned to the ship DATE
             -- (midnight), not a real clock time, so it can't be compared against
             -- scan timestamps — its mere presence means "this IF has departed".
             bool_or(event_type='CUSTODY_CLEARED') AS cleared
      FROM order_events
      WHERE doc_type='IF' AND event_type IN ('CUSTODY_OUT','CUSTODY_IN','CUSTODY_CLEARED')
      GROUP BY doc_number
      HAVING bool_or(event_type IN ('CUSTODY_OUT','CUSTODY_IN'))  -- had at least one scan
    ) c
    LEFT JOIN fulfillments f ON f.if_number = c.if_number
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN (
      SELECT if_number, COUNT(*)::int AS boxes, COALESCE(SUM(weight_lb),0) AS weight
      FROM fulfillment_boxes GROUP BY if_number
    ) b ON b.if_number = c.if_number
    LEFT JOIN (
      SELECT if_number, json_agg(json_build_object(
               'id', id, 'weightLb', weight_lb, 'lengthIn', length_in,
               'widthIn', width_in, 'heightIn', height_in, 'note', note
             ) ORDER BY captured_at) AS list
      FROM fulfillment_boxes GROUP BY if_number
    ) bl ON bl.if_number = c.if_number
    WHERE NOT c.cleared                -- custody closed at departure → off the register
      AND f.actual_ship_date IS NULL   -- belt-and-suspenders for IFs already marked shipped
    ORDER BY c.first_scan ASC
  `)

  // DC-carton custody (Nima, 2026-07-22): per-DC labels scan as doc_type='DC'
  // (doc_number '<po>:<abbrev>'), so they were invisible to the IF-only query
  // above. Pull them in too, resolving the partner from the PO.
  const { rows: dcRows } = await pool.query(`
    SELECT c.doc_number AS "docNumber",
           c.custody_out AS "custodyOut", c.custody_in AS "custodyIn", c.first_scan AS "firstScan",
           (SELECT customer FROM orders WHERE po_number = split_part(c.doc_number, ':', 1) LIMIT 1) AS customer,
           (SELECT location FROM orders WHERE po_number = split_part(c.doc_number, ':', 1) LIMIT 1) AS location
    FROM (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_OUT') AS custody_out,
             MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_IN')  AS custody_in,
             MIN(occurred_at) AS first_scan,
             bool_or(event_type='CUSTODY_CLEARED') AS cleared
      FROM order_events
      WHERE doc_type='DC' AND event_type IN ('CUSTODY_OUT','CUSTODY_IN','CUSTODY_CLEARED')
      GROUP BY doc_number
      HAVING bool_or(event_type IN ('CUSTODY_OUT','CUSTODY_IN'))
    ) c
    WHERE NOT c.cleared
  `)

  const now = today.getTime()
  const shape = (r, extra) => {
    const outT = r.custodyOut ? new Date(r.custodyOut).getTime() : 0
    const inT = r.custodyIn ? new Date(r.custodyIn).getTime() : 0
    const lastScan = new Date(Math.max(outT, inT))
    const ageDays = Math.max(0, Math.floor((now - lastScan.getTime()) / 86_400_000))
    return {
      ...r, ...extra,
      state: inT >= outT && inT > 0 ? 'returned' : 'with_warehouse',
      lastScan: lastScan.toISOString(),
      ageDays,
      stale: ageDays >= 3, // physically in-house 3+ days with no movement → chase it
    }
  }

  const ifResults = rows.map((r) => shape(r, {
    boxes: Number(r.boxes), boxWeight: Number(r.boxWeight), inData: !!r.soNumber,
  }))
  const dcResults = dcRows.map((r) => {
    const [po, abbrev] = String(r.docNumber).split(':')
    return shape(r, {
      isDc: true, poNumber: po, dc: abbrev || null,
      label: `PO ${po}${abbrev ? ` · ${abbrev}` : ''}`,
      boxes: 0, boxList: [], inData: !!r.customer,
    })
  })
  return [...ifResults, ...dcResults].sort((a, b) => new Date(a.firstScan) - new Date(b.firstScan))
}

// Permanently DELETE a custody scan (Nima, 2026-07-22) — distinct from clear:
// this removes the scan event(s) from the ledger entirely, for a mistaken
// scan. By `id` deletes one scan row (Scan Bay today-log); by doc deletes all
// of that IF/DC carton's custody events (Custody Register). Caller warns first.
const CUSTODY_TYPES = ['CUSTODY_OUT', 'CUSTODY_IN', 'CUSTODY_CLEARED']
export async function deleteCustodyScan({ id, docType, docNumber }) {
  if (id != null) {
    await pool.query(`DELETE FROM order_events WHERE id = $1 AND event_type = ANY($2)`, [id, CUSTODY_TYPES])
  } else if (docNumber) {
    const dt = docType === 'DC' ? 'DC' : 'IF'
    await pool.query(`DELETE FROM order_events WHERE doc_type = $1 AND doc_number = $2 AND event_type = ANY($3)`,
      [dt, String(docNumber), CUSTODY_TYPES])
  } else {
    throw new Error('id or docNumber required')
  }
  return { ok: true }
}

// Manually clear a custody item off the register (Nima, 2026-07-22) — writes a
// CUSTODY_CLEARED marker so a departed carton or a stale/orphaned scan drops
// off, the same signal ingest uses at departure. Works for IF and DC docs.
export async function clearCustodyItem({ docType, docNumber }) {
  const dt = docType === 'DC' ? 'DC' : 'IF'
  if (!docNumber) throw new Error('docNumber required')
  await insertOrderEvent({
    eventType: 'CUSTODY_CLEARED', docType: dt, docNumber: String(docNumber),
    soNumber: null, note: 'Manually cleared from the register', source: 'manual',
  })
  return getCustodyRegister()
}

// ── Ship departures (Nima, 2026-07-16) — every packed IF, grouped by its
// IF-Packed-Status: "Approved to Ship" can leave today; "FOB Order Awaiting
// Shipment" is mid-process; "Waiting On Payment" is stuck at the dock for a
// credit transfer; "Pending Invoice" is its own real status seen in the data
// too. Only rows with a packed_status at all are shown — everything else has
// already moved past this part of the pipeline.
export async function getShipDepartures() {
  const { rows } = await pool.query(`
    SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber", f.packed_status AS "packedStatus",
           f.days_pending AS "daysPending", f.invoice_number AS "invoiceNumber", f.if_date AS "ifDate",
           o.customer, o.source, o.po_number AS "poNumber"
    FROM fulfillments f LEFT JOIN orders o ON o.so_number = f.so_number
    WHERE f.packed_status IS NOT NULL
    ORDER BY f.days_pending DESC NULLS LAST
  `)
  return rows
}

// ── Shipment credits (Nima, 2026-07-17) — the header counter ─────────────────
// Two figures, shown as "galactic credits" but really plain dollars:
//   • shippedThisMonth — sum of SHIPPED_VALUE ledger snapshots dated this month
//     (pinned to actual ship date, immune to later payment zeroing the invoice);
//   • waiting — live sum of amount_remaining across everything packed but not yet
//     shipped (the ships sitting in the Launch Bay).
export async function getCredits({ today = new Date() } = {}) {
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const [shipped, waiting] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(NULLIF(note,'')::numeric), 0) AS total
       FROM order_events
       WHERE event_type = 'SHIPPED_VALUE' AND occurred_at >= $1`,
      [monthStart],
    ),
    pool.query(
      `SELECT COALESCE(SUM(i.amount_remaining), 0) AS total
       FROM fulfillments f
       JOIN invoices i ON i.inv_number = f.invoice_number
       WHERE f.packed_status IS NOT NULL AND f.actual_ship_date IS NULL`,
    ),
  ])
  return {
    shippedThisMonth: Number(shipped.rows[0].total),
    waiting: Number(waiting.rows[0].total),
    month: monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
  }
}

// ── Character affection (Nima, 2026-07-17) — relationship tracker ────────────
export async function getAffection() {
  const tasks = await fetchQuestTasks()
  return computeAffection(tasks).map((a) => ({ ...a, character: getCharacterById(a.characterId) }))
}

// ── Launch Bay (Nima, 2026-07-17; reliability rework same day) ───────────────
// Ships = fulfillments not yet shipped (actual_ship_date null = still in the
// bay). REWORKED to stop depending on the hand-keyed IF-Packed-Status field —
// that search went stale and left the bay showing 1 of ~11 real orders. State
// now comes from FRESH, reliable tables (imported with every batch):
//   • invoices.shipping_status — 'Approved For Shipping' → cleared to launch
//     (floats); 'Pending Payment' → grounded on payment;
//   • else orders.billing_status 'Pending Billing' / no invoice yet → grounded,
//     awaiting invoice;
//   • the old manual packed_status is only a last-resort fallback now.
// China-Warehouse orders (orders.location ~ 'China') are EXCLUDED — they ship
// FOB direct from China and never leave Naghedi's dock. (Open question with
// Nima: whether an approved-to-ship China order should still show.)
// approved ships float; the REACHED_APPROVED ledger stamp drives the delay warning.
function launchState(r) {
  const ship = (r.invShip || '').toLowerCase()
  if (ship.includes('approved')) return 'approved'
  if (ship.includes('pending payment')) return 'payment'
  const bill = (r.billingStatus || '').toLowerCase()
  if (bill.includes('pending billing') || !r.invoiceNumber) return 'invoice'
  // last-resort fallback to the legacy manual field for rows with no invoice signal
  const pk = (r.packedStatus || '').toLowerCase()
  if (pk.includes('approved to ship')) return 'approved'
  if (pk.includes('waiting on payment')) return 'payment'
  if (pk.includes('pending invoice')) return 'invoice'
  return 'other'
}

export async function getLaunchBay({ today = new Date() } = {}) {
  // Only PACKED IFs belong in the bay (Nima, 2026-07-17) — a merely-Picked IF
  // isn't ready. The ONE exception: a Picked IF we've physically scanned back
  // into our possession (custody IN latest) surfaces as a highlighted
  // 'scanned_in' ship — the prompt to generate its shipping label and get it
  // ready to invoice. Custody state (latest OUT vs IN) comes from the ledger.
  const { rows } = await pool.query(`
    SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber", f.packed_status AS "packedStatus",
           f.status AS "ifStatus",
           f.days_pending AS "daysPending", f.invoice_number AS "invoiceNumber",
           f.if_date AS "ifDate", f.actual_ship_date AS "actualShipDate",
           o.customer, o.source, o.po_number AS "poNumber", o.location,
           o.billing_status AS "billingStatus",
           i.shipping_status AS "invShip", i.status AS "invStatus",
           a.approved_since AS "approvedSince",
           c.custody_out AS "custodyOut", c.custody_in AS "custodyIn"
    FROM fulfillments f
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN invoices i ON i.inv_number = f.invoice_number
    LEFT JOIN (
      SELECT doc_number, MIN(occurred_at) AS approved_since
      FROM order_events
      WHERE event_type = 'REACHED_APPROVED' AND doc_type = 'IF'
      GROUP BY doc_number
    ) a ON a.doc_number = f.if_number
    LEFT JOIN (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS custody_out,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS custody_in
      FROM order_events WHERE doc_type = 'IF' AND event_type IN ('CUSTODY_OUT','CUSTODY_IN')
      GROUP BY doc_number
    ) c ON c.doc_number = f.if_number
    WHERE f.actual_ship_date IS NULL
      AND COALESCE(o.location, '') NOT ILIKE '%china%'   -- China ships FOB direct, not from our dock
      AND (
        f.status IS NULL OR f.status NOT ILIKE '%picked%'   -- packed (or a packed sub-status), not just picked
        OR (c.custody_in IS NOT NULL AND (c.custody_out IS NULL OR c.custody_in >= c.custody_out))  -- picked but back in our hands
      )
    ORDER BY f.days_pending DESC NULLS LAST
  `)

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }
  const todayStart = startOfDay(today)

  return rows.map((r) => {
    const isPicked = /picked/i.test(r.ifStatus || '')
    const scannedIn = r.custodyIn && (!r.custodyOut || new Date(r.custodyIn) >= new Date(r.custodyOut))
    // a picked-but-scanned-back-in IF is the highlighted "prep it to ship" case
    const state = isPicked && scannedIn ? 'scanned_in' : launchState(r)
    // whole calendar days the ship has been cleared-for-launch but still here
    const floatingDays =
      state === 'approved' && r.approvedSince
        ? Math.round((todayStart - startOfDay(r.approvedSince)) / 86_400_000)
        : 0
    // delayed = approved on a previous day and still not marked shipped
    const delayed = state === 'approved' && floatingDays >= 1
    return { ...r, state, floating: state === 'approved', floatingDays, delayed }
  })
}

// Data-freshness: how old is the underlying export data? Uses the most recent
// snapshot per source and reports the STALEST one. Thresholds are the initial
// guess (warn 24h, stale 48h) — tune later once the real refresh cadence is known.
const WARN_HOURS = 24
const STALE_HOURS = 48

// Per-source freshness. Reports EVERY required export (not just ones we've
// seen) so a never-uploaded search shows as 'missing' rather than silently
// absent — that's how you know which export to go pull.
const STATUS_RANK = { missing: 4, stale: 3, warn: 2, unknown: 1, fresh: 0 }

export async function getFreshness() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (source) source, imported_at, file_modified
    FROM import_snapshots
    ORDER BY source, imported_at DESC
  `)
  const bySource = new Map(rows.map((r) => [r.source, r]))
  const now = Date.now()

  const sources = REQUIRED_SOURCES.map((key) => {
    const snap = bySource.get(key)
    const label = SOURCE_LABELS[key] || key
    const url = SOURCE_LINKS[key] || null // NetSuite saved-search link, when configured
    if (!snap) return { key, label, url, status: 'missing', ageHours: null, fileModified: null, importedAt: null }
    const ageHours = snap.file_modified ? (now - new Date(snap.file_modified).getTime()) / 3.6e6 : null
    const status =
      ageHours == null ? 'unknown' : ageHours > STALE_HOURS ? 'stale' : ageHours > WARN_HOURS ? 'warn' : 'fresh'
    return { key, label, url, status, ageHours, fileModified: snap.file_modified, importedAt: snap.imported_at }
  })

  // Overall = the worst single source, so the header pill reflects the weakest link.
  const status = sources.reduce(
    (worst, s) => (STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst),
    'fresh',
  )
  const ages = sources.map((s) => s.ageHours).filter((a) => a != null)
  const maxAgeHours = ages.length ? Math.max(...ages) : null

  return { status, maxAgeHours, warnHours: WARN_HOURS, staleHours: STALE_HOURS, sources }
}

// ── Naghedi-Warehouse freshness (its Supabase, read-only) ────────────────────
// Two of Bugs' three Naghedi-Warehouse checklist items actually land in that
// app's Supabase with timestamps (sku_catalog.updated_at per row;
// purchase_orders.updated_at) — so Work-Hub can check them remotely instead
// of trusting a checkbox. The NetSuite Items CSV is localStorage-only over
// there and stays a manual checklist item. IMPORTS STAY IN NAGHEDI-WAREHOUSE
// (decided 2026-07-17): its import pipelines do app-specific processing
// (full-replace semantics, style-color indexes), so Work-Hub only reads
// freshness and links to that app — it never writes these tables.
const NW_SUPABASE_URL = process.env.VITE_SUPABASE_URL
const NW_SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const NW_APP_URL = process.env.NAGHEDI_WAREHOUSE_URL || 'https://naghedi-warehouse.vercel.app'

const NW_SOURCES = [
  { key: 'nw-catalog', label: 'Naghedi-Warehouse: SKU/Quantities Catalog', table: 'sku_catalog' },
  { key: 'nw-po', label: 'Naghedi-Warehouse: PO Warehouse View', table: 'purchase_orders' },
]

async function nwLatestUpdate(table) {
  const res = await fetch(
    `${NW_SUPABASE_URL}/rest/v1/${table}?select=updated_at&order=updated_at.desc&limit=1`,
    { headers: { apikey: NW_SUPABASE_KEY, Authorization: `Bearer ${NW_SUPABASE_KEY}` } },
  )
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  const rows = await res.json()
  return rows[0]?.updated_at || null
}

export async function getNwFreshness() {
  if (!NW_SUPABASE_URL || !NW_SUPABASE_KEY) {
    return { configured: false, appUrl: NW_APP_URL, sources: [] }
  }
  const now = Date.now()
  const sources = await Promise.all(
    NW_SOURCES.map(async ({ key, label, table }) => {
      try {
        const ts = await nwLatestUpdate(table)
        const ageHours = ts ? (now - new Date(ts).getTime()) / 3.6e6 : null
        const status =
          ts == null ? 'missing' : ageHours > STALE_HOURS ? 'stale' : ageHours > WARN_HOURS ? 'warn' : 'fresh'
        return { key, label, status, ageHours, updatedAt: ts, url: NW_APP_URL }
      } catch (e) {
        // 'unknown' (not silently fresh): the verifier treats it as blocking so
        // a broken key/URL can't quietly disable the check.
        return { key, label, status: 'unknown', ageHours: null, error: e.message, url: NW_APP_URL }
      }
    }),
  )
  return { configured: true, appUrl: NW_APP_URL, sources }
}

// ── OC↔PO allocation review — the "open task" queue ──────────────────────────
// Kept entirely manual (Nima, 2026-07-09): this reads current state and runs
// the matcher, but nothing here writes anything. Every OC/PO line that isn't
// yet committed to a link AND isn't dismissed shows up somewhere in this
// response — suggestedMatches, candidates, or unmatchedOcs/unmatchedPos — so
// the queue can't silently lose track of an order the way loose spreadsheets do.
export async function getOcPoReview() {
  const [ocs, pos, links] = await Promise.all([
    fetchOrderConfirmations(),
    fetchPurchaseOrders(),
    fetchOcPoLinks(),
  ])
  const { suggestedMatches, candidates, unmatchedOcs, unmatchedPos } = computeOcPoMatches({ ocs, pos, links })
  const { locations, containers, unassignedOcs } = computeContainerView({ ocs, pos, links })
  return { suggestedMatches, candidates, unmatchedOcs, unmatchedPos, links, locations, containers, unassignedOcs }
}

// ── EDI (Orderful) review — mirrors Airtable's 850 Tracker/856, pulled live
// from Orderful's API into Neon instead of via CSV → Airtable. ──────────────
// EDI-sourced orders only: their po_number reliably matches an Orderful
// business number, unlike boutique orders' free-text PO/check numbers.
async function fetchEdiSourcedOrders() {
  const { rows } = await pool.query(
    `SELECT o.po_number AS "poNumber", o.so_number AS "soNumber", o.stage,
      COALESCE((
        SELECT json_agg(json_build_object(
          'ifNumber', f.if_number, 'status', f.status,
          'actualShipDate', f.actual_ship_date, 'invoiceNumber', f.invoice_number
        ))
        FROM fulfillments f WHERE f.so_number = o.so_number
      ), '[]'::json) AS "itemFulfillments",
      COALESCE((
        SELECT json_agg(json_build_object(
          'invNumber', i.inv_number, 'status', i.status, 'amountRemaining', i.amount_remaining
        ))
        FROM invoices i WHERE i.so_number = o.so_number
      ), '[]'::json) AS "invoices"
     FROM orders o WHERE o.source = 'edi' AND o.po_number IS NOT NULL`,
  )
  // Same stage/next-action language the rest of the app uses (Dashboard,
  // Kanban) — Nima asked for "needs printed/packed/shipped/invoiced" per PO,
  // which IS this shared model, not something EDI-specific to invent.
  return rows.map((r) => ({ ...r, stageLabel: STAGE_LABEL[r.stage] || r.stage, nextAction: NEXT_ACTION[r.stage] || '—' }))
}

export async function getEdiReview() {
  const [transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs, manualOrders, resolutions, acks] = await Promise.all([
    fetchEdiTransactions(), fetchEdiFulfillments(), fetchEdiSourcedOrders(), fetchEdiManualLinks(), fetchEdiDocumentPoRefs(),
    fetchEdiManualOrders(), fetchEdiPoResolutions(), fetchEdiTransactionAcks(),
  ])
  const pipeline = computeEdiPipeline(transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs, acks)
  // manualOrders are returned ALONGSIDE (never merged into) the automated
  // pipeline — the EDI view renders them in their own clearly-flagged section.
  // resolutions ride along for the client-side work layer (src/model/ediWork.js).
  // ediTasks (bn → 'open'|'done') lets each PO card show "task exists" vs a
  // "make task" button (Nima, 2026-07-20).
  const taskStates = await fetchEdiTaskStates()
  const ediTasks = Object.fromEntries(taskStates.map((s) => [s.instanceKey.slice(4), s.status]))
  // ediSupply (bn → {poNumber, fromStock, note}) — the inbound production PO
  // each EDI order is fulfilled from, or a from-stock flag.
  const supplyRows = await fetchEdiSupply()
  const ediSupply = Object.fromEntries(supplyRows.map((r) => [r.businessNumber, r]))
  return { ...pipeline, manualOrders, resolutions, ediTasks, ediSupply }
}

// Assign the inbound production PO an EDI order comes from (or mark from-stock).
export async function setEdiSupply({ businessNumber, poNumber, fromStock, note }) {
  if (!businessNumber) throw new Error('businessNumber is required')
  await upsertEdiSupply({ businessNumber, poNumber, fromStock, note })
  return getEdiReview()
}

export async function clearEdiSupply(businessNumber) {
  await deleteEdiSupply(businessNumber)
  return getEdiReview()
}

// ── Document links (Nima, 2026-07-20) — attach any doc/transaction to any
// other. getLinksFor returns the other endpoint of every link touching a doc.
export async function getLinksFor(docType, docNumber) {
  return fetchLinksFor(docType, docNumber)
}

export async function createDocLink(payload) {
  await addDocLink(payload)
  return getLinksFor(payload.aType, payload.aNumber)
}

export async function removeDocLink(id) {
  await deleteDocLink(id)
  return { ok: true }
}

// Search every real document number the app knows (Nima, 2026-07-20: "every
// document number that exists we'd like to choose them") — so linking picks a
// verified doc instead of typing a typo-prone number. Merges the natural keys
// across orders/fulfillments/invoices/POs/OCs/EDI, each with a bit of context.
export async function searchDocNumbers(q) {
  const term = `%${String(q || '').trim()}%`
  if (term.length < 3) return [] // need at least 1 real char between the %s
  const { rows } = await pool.query(
    `
    (SELECT 'SO' AS type, so_number AS number, customer AS label FROM orders WHERE so_number ILIKE $1 LIMIT 8)
    UNION ALL (SELECT 'IF', if_number, so_number FROM fulfillments WHERE if_number ILIKE $1 LIMIT 8)
    UNION ALL (SELECT 'INV', inv_number, so_number FROM invoices WHERE inv_number ILIKE $1 LIMIT 8)
    UNION ALL (SELECT 'PO', po_number, MAX(vendor) FROM purchase_orders WHERE po_number ILIKE $1 GROUP BY po_number LIMIT 8)
    UNION ALL (SELECT 'OC', oc_number, MAX(customer) FROM order_confirmations WHERE oc_number ILIKE $1 GROUP BY oc_number LIMIT 8)
    UNION ALL (SELECT 'EDI_PO', business_number, MAX(trading_partner) FROM edi_transactions WHERE business_number ILIKE $1 GROUP BY business_number LIMIT 8)
    LIMIT 30
    `,
    [term],
  )
  return rows
}

// Deterministic messenger per PO (stable across regenerations, like the ship /
// portrait hashes) so an EDI PO's task always shows the same face.
function ediTaskCharacter(businessNumber) {
  const s = String(businessNumber)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return CHARACTERS[h % CHARACTERS.length].id
}

// One work-attached EDI order → its task (idempotent via instance_key).
async function createEdiTaskFromOrder(o) {
  const partner = o.tradingPartner || 'EDI'
  const so = o.netsuiteOrder?.soNumber || null
  const subject = `${partner} · PO ${o.businessNumber}${so ? ` · ${so}` : ''}`
  const snippet = o.work?.needed || 'Review this EDI order'
  const urgency = (o.work?.cancelState === 'passed' || o.work?.missed850) ? 'hi'
    : o.work?.cancelState === 'soon' ? 'mid' : null
  return createEdiTask({
    businessNumber: o.businessNumber,
    characterId: ediTaskCharacter(o.businessNumber),
    fromName: partner,
    subject, snippet,
    netsuiteDocType: so ? 'SO' : null,
    netsuiteDocNumber: so,
    urgency,
  })
}

// Reconcile EDI tasks with the live work board (Nima, 2026-07-20): open EDI POs
// that ALREADY exist as a NetSuite SO are confirmed, actionable work, so they
// auto-materialize as tasks ("if the SO exists it should be a task already").
// POs with no SO yet only become tasks via the manual button (createEdiTaskFor)
// — they're a "needs entering" judgment call, not automatic. Any EDI task whose
// PO is no longer open work is closed. Best-effort caller (see ensureRecurringTasks).
export async function ensureEdiTasks() {
  const review = await getEdiReview()
  const work = computeEdiWork(review.orders || [], review.resolutions || [])
  const openByBn = new Map()
  let created = 0
  for (const o of work.orders) {
    if (o.work.closed) continue
    openByBn.set(o.businessNumber, o)
    if (!o.netsuiteOrder) continue // only "SO exists" ones auto-materialize
    const id = await createEdiTaskFromOrder(o)
    if (id) {
      await logTaskActivity({ taskId: id, kind: 'created', note: `EDI: ${(o.tradingPartner || '').trim()} PO ${o.businessNumber}`.replace(/\s+/g, ' ') })
      created++
    }
  }
  let closed = 0
  for (const s of await fetchEdiTaskStates()) {
    if (s.status !== 'open') continue
    const bn = s.instanceKey.slice(4)
    if (!openByBn.has(bn)) { await closeEdiTask(bn); closed++ }
  }
  return { created, closed }
}

// The manual "＋ Task" button on an EDI PO card — works for ANY open PO,
// including the no-SO ones the auto-reconcile skips. Same instance_key, so it
// collapses with any auto-created task for the same PO.
export async function createEdiTaskFor(businessNumber) {
  const review = await getEdiReview()
  const work = computeEdiWork(review.orders || [], review.resolutions || [])
  const o = work.orders.find((x) => x.businessNumber === businessNumber)
  if (!o) throw new Error(`No EDI order found for ${businessNumber}`)
  const id = await createEdiTaskFromOrder(o)
  if (id) await logTaskActivity({ taskId: id, kind: 'created', note: `EDI task created from the relay · PO ${businessNumber}` })
  return getEdiReview()
}

// Per-document acknowledgment (Nima, 2026-07-20) — distinct from resolveEdiPo:
// this clears ONE invalid/failed document (a Bloomingdale's 856 that was
// resent and accepted, or one confirmed to have nothing to link) without
// touching the rest of the PO's open work.
export async function ackEdiTransaction({ transactionId, linkedTransactionId, note }) {
  if (!transactionId) throw new Error('transactionId is required')
  await upsertEdiTransactionAck({ transactionId, linkedTransactionId, note })
  return getEdiReview()
}

export async function unackEdiTransaction(transactionId) {
  await deleteEdiTransactionAck(transactionId)
  return getEdiReview()
}

// Doc seasons (Nima, 2026-07-20) — free-text season tag on any OC/PO/EDI PO
// (see db/schema.sql doc_seasons).
export async function getSeasons() {
  return fetchSeasons()
}

export async function setSeason({ docType, docNumber, season }) {
  if (!docType || !docNumber) throw new Error('docType and docNumber are required')
  await upsertSeason({ docType, docNumber, season })
  return getSeasons()
}

// Manual PO resolution (Nima, 2026-07-18): connect a PO to its NetSuite ref
// and/or mark it closed. Empty businessNumber is a caller bug, reject loudly.
export async function resolveEdiPo({ businessNumber, closed, cancelled, netsuiteRef, note }) {
  if (!businessNumber?.trim()) throw new Error('businessNumber is required')
  await upsertEdiPoResolution({ businessNumber: businessNumber.trim(), closed, cancelled, netsuiteRef, note })
  return getEdiReview()
}

export async function unresolveEdiPo(businessNumber) {
  await deleteEdiPoResolution(businessNumber)
  return getEdiReview()
}

// ── EDI routing + BOL ────────────────────────────────────────────────────────
// The Routing view's read model: the raw package feed, consolidated into one
// group per (partner, DC), each annotated with the shipment/BOL already
// assigned to that exact PO-set (if any). Shipments whose PO-set is no longer
// in the feed (already routed/exported away) surface separately so a minted BOL
// is never lost from view.
export async function getRouting() {
  const [packages, shipments, auths] = await Promise.all([
    fetchEdiPackages(), fetchRoutingShipments(), fetchRoutingAuths(),
  ])
  const groups = consolidateRouting(packages)

  const byKey = new Map()
  for (const s of shipments) byKey.set(s.dcPoKey, s)

  const consolidated = groups.map((g) => {
    const dcPoKey = `${g.partner}|${g.dc}|${g.memberPos.join(',')}`
    return { ...g, dcPoKey, shipment: byKey.get(dcPoKey) || null }
  })

  const liveKeys = new Set(consolidated.map((g) => g.dcPoKey))
  const detached = shipments.filter((s) => !liveKeys.has(s.dcPoKey))

  // packages returned raw too, so the view can re-consolidate over a PO subset
  // (the "consolidate by DC across selected POs" interaction) client-side.
  return { packages, consolidated, shipments, detached, auths, packageCount: packages.length }
}

export async function setShipmentRefs(id, fields) {
  await updateShipmentRefs(id, fields || {})
  return getRouting()
}

export async function saveRoutingAuth(body = {}) {
  if (!body.authNumber?.trim()) throw new Error('authNumber is required')
  await upsertRoutingAuth({ ...body, authNumber: body.authNumber.trim() })
  if (Array.isArray(body.shipmentIds) && body.shipmentIds.length) {
    await assignAuthToShipments({ authNumber: body.authNumber.trim(), shipmentIds: body.shipmentIds })
  }
  return getRouting()
}

export async function removeRoutingAuth(authNumber) {
  await deleteRoutingAuth(authNumber)
  return getRouting()
}

// Phase 3 — VICS BOL PDF + Drive filing
export async function streamShipmentBol(res, id) {
  const shipment = await fetchRoutingShipmentById(id)
  if (!shipment) throw new Error('shipment not found')
  await renderBolTo(res, shipment)
}

export async function fileShipmentToDrive(id) {
  const shipment = await fetchRoutingShipmentById(id)
  if (!shipment) throw new Error('shipment not found')
  const buffer = await buildBolPdf(shipment)
  const filename = `BOL_${shipment.bolNumber || 'draft'}_${shipment.dc}.pdf`
  return uploadBolPdf({
    partner: shipment.partner, pos: shipment.memberPos || [], filename, buffer,
  })
}

export async function assignRoutingBol(body = {}) {
  const { partner, dc, memberPos, cartons, units, weightLb, cubicFeet } = body
  if (!partner || !dc) throw new Error('partner and dc are required')
  if (!Array.isArray(memberPos) || !memberPos.length) throw new Error('memberPos is required')
  await assignBol({ partner, dc, memberPos, cartons, units, weightLb, cubicFeet })
  return getRouting()
}

export async function voidRouting(id) {
  await voidRoutingShipment(id)
  return getRouting()
}

export async function linkEdiTransaction({ transactionId, businessNumber, note }) {
  await upsertEdiManualLink({ transactionId, businessNumber, note })
  return getEdiReview()
}

export async function unlinkEdiTransaction(transactionId) {
  await deleteEdiManualLink(transactionId)
  return getEdiReview()
}

export async function addEdiManualOrder({ businessNumber, tradingPartner, note }) {
  if (!businessNumber?.trim()) throw new Error('A PO / business number is required')
  await createEdiManualOrder({ businessNumber: businessNumber.trim(), tradingPartner, note })
  return getEdiReview()
}

export async function removeEdiManualOrder(id) {
  await deleteEdiManualOrder(Number(id))
  return getEdiReview()
}

export async function syncEdi() {
  if (!process.env.ORDERFUL_API_KEY) throw new Error('ORDERFUL_API_KEY is not set in .env.local')
  const r = await syncOrderful(process.env.ORDERFUL_API_KEY)
  // Fresh Orderful data can shift what's open — refresh the auto-generated
  // tasks right after (best-effort; a failure here mustn't fail the sync).
  try { await ensureEdiTasks() } catch (e) { console.error('EDI task generation after sync failed:', e.message) }
  return r
}

export async function commitOcPoLink(payload) {
  return upsertOcPoLink(payload)
}

export async function undoOcPoLink(id) {
  return deleteOcPoLink(id)
}

// type: 'oc' | 'po'. dismissed=false lets a mistaken close be reversed.
export async function dismissOcPoLine({ type, ocNumber, poNumber, item, note, dismissed }) {
  if (type === 'oc') return dismissOrderConfirmation({ ocNumber, item, note, dismissed })
  if (type === 'po') return dismissPurchaseOrder({ poNumber, item, note, dismissed })
  throw new Error(`unknown dismiss type: ${type}`)
}

// ── Quest emails (Gmail-to-quest hologram transmissions) ────────────────────
// Read-only from Neon; /sync pulls fresh messages from Gmail first. Every
// mutation performs its write (Gmail API + local DB where applicable) then
// returns the refreshed view, same shape as the EDI/OC↔PO routes above.
// `characters` rides along so the client's reassign dropdown always reflects
// the server's roster (src/model/characters.js) instead of a duplicated copy.
export async function getQuestEmails() {
  const emails = await fetchQuestEmails()
  return { emails: emails.map((e) => ({ ...e, character: getCharacterById(e.characterId) })), characters: CHARACTERS }
}

export async function syncQuestEmails() {
  const messages = await fetchInboxMessages()
  const upserted = await loadQuestEmails(messages)
  const reconciled = await reconcileReadStatus(messages.map((m) => m.id))
  const autoClosed = await checkRepliedTasks()
  const review = await getQuestEmails()
  return { fetched: messages.length, upserted, reconciled, autoClosed, ...review }
}

// "Reply needed" tasks close themselves once we've actually sent a reply
// (Nima, 2026-07-15: "have the app acknowledge it to close and mark the task
// as done") — scans each open reply-needed task's Gmail thread for a message
// FROM this account dated after the task was created. Runs every sync
// (manual + the 5-min auto-poll in Transmissions.jsx), not on a separate timer.
export async function checkRepliedTasks() {
  const openReplyTasks = await fetchOpenReplyTasks()
  if (!openReplyTasks.length) return 0
  const myAddress = (await getProfile()).toLowerCase()
  let closed = 0
  for (const t of openReplyTasks) {
    const thread = await fetchThread(t.threadId)
    const replied = thread.some(
      (m) => m.fromAddress?.toLowerCase() === myAddress && new Date(m.receivedAt) > new Date(t.createdAt),
    )
    if (!replied) continue
    await completeQuestTask(t.id, true)
    await logTaskActivity({ taskId: t.id, kind: 'reply_detected', note: 'Reply detected in thread — auto-closed' })
    closed++
  }
  return closed
}

export async function markQuestEmailRead(id) {
  await markMessageRead(id) // Gmail write first — if it throws, local state stays untouched
  await markQuestEmailReadLocal(id)
  return getQuestEmails()
}

export async function assignQuestEmail({ id, characterId, fromAddress }) {
  if (!getCharacterById(characterId)) throw new Error(`unknown characterId: ${characterId}`)
  await assignQuestEmailCharacter({ id, characterId, fromAddress })
  return getQuestEmails()
}

export async function applyQuestEmailLabel({ id, label }) {
  await applyLabel(id, label) // Gmail write — label_ids refresh on next sync
  return getQuestEmails()
}

export async function dismissQuestEmailLine(id, dismissed = true) {
  await dismissQuestEmail(id, dismissed)
  // "Clear once" (Nima, 2026-07-20): dismissing here also marks it read in
  // Gmail so the same email never needs reviewing in both places. Best-effort
  // — a Gmail hiccup must not block the in-app dismiss.
  if (dismissed) {
    try { await markMessageRead(id); await markQuestEmailReadLocal(id) } catch { /* next sync reconciles */ }
  }
  return getQuestEmails()
}

// The user's real Gmail labels, for the label picker.
export async function getGmailLabels() {
  return listUserLabels()
}

// Upcoming Google Calendar events (Nima, 2026-07-21) — for the in-app calendar
// + holocalls. 30-day window from now. Fails soft to {configured:false} when
// the token lacks calendar scope (before re-auth).
export async function getCalendarEvents() {
  const timeMax = new Date(Date.now() + 30 * 86400000).toISOString()
  return fetchCalendarEvents({ timeMax })
}

// Spam (Nima, 2026-07-20): Gmail's own SPAM label (trains its filter, leaves
// the inbox) + dismissed here — gone from both places in one click.
export async function spamQuestEmail(id) {
  await markMessageSpam(id)
  await markQuestEmailReadLocal(id)
  await dismissQuestEmail(id, true)
  return getQuestEmails()
}

// On-demand thread context (not stored — see src/ingest/gmail.js). Excludes
// the message being viewed since the client already has its full body.
export async function getQuestEmailThread(id) {
  const email = await fetchQuestEmailById(id)
  if (!email?.threadId) return []
  const messages = await fetchThread(email.threadId)
  return messages.filter((m) => m.id !== id).sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))
}

// Archive search — deliberately reads past dismissed/done state (unlike
// every other quest-emails/quest-tasks read above), since the whole point is
// finding something that already cycled out of the active views.
export async function searchQuestArchive(q) {
  const [emails, tasks] = await Promise.all([searchQuestEmails(q), searchQuestTasks(q)])
  return {
    emails: emails.map((e) => ({ ...e, character: getCharacterById(e.characterId) })),
    tasks: tasks.map((t) => ({ ...t, character: getCharacterById(t.characterId) })),
  }
}

// ── Quest tasks — a transmission promoted to something durable ──────────────
// Copies the email's subject/snippet/character over so the task keeps the
// same "who delivered this" identity even after the source transmission
// itself cycles out of the unread-only list. Dismissing the source email
// here is deliberate: once claimed as a task, it's done being a transmission.
// Every read runs ensureRecurringTasks first — the "catch up whenever the
// app is opened" mechanism (Nima, 2026-07-16), no separate scheduler needed
// until this is deployed somewhere always-on.
export async function getQuestTasks() {
  await ensureRecurringTasks()
  const tasks = await fetchQuestTasks()
  return tasks.map((t) => ({ ...t, character: getCharacterById(t.characterId) }))
}

export async function createTaskFromQuestEmail(emailId) {
  const email = await fetchQuestEmailById(emailId)
  if (!email) throw new Error(`no quest email found for id ${emailId}`)
  const taskId = await createQuestTask({
    emailId: email.id, threadId: email.threadId, characterId: email.characterId, fromAddress: email.fromAddress,
    fromName: email.fromName, subject: email.subject, snippet: email.snippet,
  })
  await dismissQuestEmail(emailId, true)
  await logTaskActivity({ taskId, kind: 'created', note: `Claimed as a task: "${email.subject}"` })
  return { ...(await getQuestEmails()), tasks: await getQuestTasks() }
}

// ── Universal notes (Nima, 2026-07-20) — the Datapad, generalized off the
// email-only quest_emails.note. doc_type/doc_number is a plain natural key
// ('EMAIL'/email id, 'EDI_PO'/business_number, 'SO'/so_number, etc.) — no FK,
// so a note can attach to anything the app knows a doc-number for.
export async function getNotesFor(docType, docNumber) {
  const { rows } = await pool.query(
    `SELECT id, doc_type AS "docType", doc_number AS "docNumber", note,
            linked_doc_type AS "linkedDocType", linked_doc_number AS "linkedDocNumber",
            created_at AS "createdAt"
     FROM notes WHERE doc_type = $1 AND doc_number = $2 ORDER BY created_at DESC`,
    [docType, docNumber],
  )
  return rows
}

export async function addNote({ docType, docNumber, note, linkedDocType, linkedDocNumber }) {
  if (!docType || !docNumber || !note?.trim()) throw new Error('A note needs a docType, docNumber, and text')
  await pool.query(
    `INSERT INTO notes (doc_type, doc_number, note, linked_doc_type, linked_doc_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [docType, docNumber, note.trim(), linkedDocType || null, linkedDocNumber || null],
  )
  return getNotesFor(docType, docNumber)
}

export async function deleteNote(id) {
  await pool.query('DELETE FROM notes WHERE id = $1', [id])
}

// Datapad rebuild source (Nima, 2026-07-20): the new notes table UNIONed with
// the legacy quest_emails.note column — simpler than migrating that data over,
// and nothing existing has to move. doc_type is synthesized 'EMAIL' for the
// legacy rows so both sources render through the same sectioned UI.
export async function getAllNotes() {
  const { rows } = await pool.query(`
    SELECT id::text AS id, doc_type AS "docType", doc_number AS "docNumber", note,
           linked_doc_type AS "linkedDocType", linked_doc_number AS "linkedDocNumber",
           created_at AS "createdAt"
    FROM notes
    UNION ALL
    SELECT ('email-' || e.id) AS id, 'EMAIL' AS "docType", e.id AS "docNumber", e.note,
           NULL AS "linkedDocType", NULL AS "linkedDocNumber", e.received_at AS "createdAt"
    FROM quest_emails e
    WHERE e.note IS NOT NULL AND e.note <> ''
    ORDER BY "createdAt" DESC
  `)
  return rows
}

// The note ledger, standalone (Nima, 2026-07-20): every email carrying a
// Datapad note, oldest first isn't useful — newest first, with the source
// email's Gmail link and (if promoted) its task's subject/status alongside.
export async function getLedgerNotes() {
  const { rows } = await pool.query(`
    SELECT e.id, e.thread_id AS "threadId", e.subject, e.note, e.character_id AS "characterId",
           e.received_at AS "receivedAt",
           t.id AS "taskId", t.subject AS "taskSubject", t.status AS "taskStatus"
    FROM quest_emails e
    LEFT JOIN quest_tasks t ON t.email_id = e.id
    WHERE e.note IS NOT NULL AND e.note <> ''
    ORDER BY e.received_at DESC
  `)
  return rows.map((r) => ({ ...r, character: getCharacterById(r.characterId) }))
}

// Note ledger (Nima, 2026-07-18): save/clear the personal summary on an email.
export async function setEmailNote(emailId, note) {
  await setQuestEmailNote(emailId, note)
  return getQuestEmails()
}

// One-click acknowledge (Nima, 2026-07-18): an email that only needs "seen and
// understood" shouldn't take create-task → open it → mark done. This records
// the acknowledgment as a task that was created AND completed in one motion —
// it lands in the journal/Calendar like any finished quest, the messenger's
// affection still counts it, and the transmission is dismissed.
export async function acknowledgeQuestEmail(emailId) {
  const email = await fetchQuestEmailById(emailId)
  if (!email) throw new Error(`no quest email found for id ${emailId}`)
  const taskId = await createQuestTask({
    emailId: email.id, threadId: email.threadId, characterId: email.characterId, fromAddress: email.fromAddress,
    fromName: email.fromName, subject: email.subject, snippet: email.snippet,
  })
  await updateTaskNeeds({ id: taskId, needsType: 'acknowledgment', needsNote: null, netsuiteDocType: null, netsuiteDocNumber: null })
  await completeQuestTask(taskId, true)
  await dismissQuestEmail(emailId, true)
  // Acknowledging is "seen and understood" — mark it read in Gmail too, same
  // "clear once" rule as dismiss (Nima, 2026-07-21). Best-effort: a Gmail
  // hiccup must not block the acknowledgment. dismiss already does this; this
  // brings acknowledge in line so BOTH paths clear the email in Gmail.
  try { await markMessageRead(emailId); await markQuestEmailReadLocal(emailId) } catch { /* next sync reconciles */ }
  await logTaskActivity({ taskId, kind: 'created', note: `Acknowledged: "${email.subject}"` })
  await logTaskActivity({ taskId, kind: 'done', note: 'Acknowledged on receipt' })
  return { ...(await getQuestEmails()), tasks: await getQuestTasks() }
}

// One hand-written task. "Messenger (random)" (no characterId) → a random
// roster face, so the card looks like the rest. A netsuite_doc requirement has
// its number normalized to the type's prefix (e.g. "1213" under SO → "SO1213"),
// the same rule the per-task needs editor uses — this is how you record the doc
// that closes it out. Returns the new task id (shared by single + bulk create).
async function createOneManualTask(fields) {
  if (!fields?.subject?.trim()) throw new Error('A task needs at least a subject')
  const characterId = fields.characterId || CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id
  const isDoc = fields.needsType === 'netsuite_doc'
  const netsuiteDocType = isDoc ? (fields.netsuiteDocType || 'SO') : null
  const netsuiteDocNumber = isDoc && fields.netsuiteDocNumber
    ? normalizeDocNumber(netsuiteDocType, fields.netsuiteDocNumber) : null
  const taskId = await createManualTask({ ...fields, characterId, netsuiteDocType, netsuiteDocNumber })
  await logTaskActivity({ taskId, kind: 'created', note: `Created manually: "${fields.subject}"` })
  return taskId
}

// A task Nima writes himself — returns the refreshed task list.
export async function addManualTask(fields) {
  await createOneManualTask(fields)
  return getQuestTasks()
}

// Bulk create (Nima, 2026-07-20) — turn many selected orders/PO groups into
// tasks at once (the Mission Quests "create tasks" flow). Each gets its own
// random messenger; a shared needsType/urgency applies to all, and a doc
// number (single-selection only) closes-out reference rides along.
export async function addTasksBulk(tasks = []) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('No tasks to create')
  let created = 0
  for (const t of tasks) {
    await createOneManualTask(t)
    created++
  }
  return { created, tasks: await getQuestTasks() }
}

// ── Recurring tasks ──────────────────────────────────────────────────────────
// Verifiers a 'verified'-mode task can reference by key. Add more here as new
// recurring tasks need real (code-checkable) completion gates.
const VERIFIERS = {
  csv_freshness_workhub: async () => {
    const fresh = await getFreshness()
    const problems = fresh.sources
      .filter((s) => s.status === 'stale' || s.status === 'missing')
      .map((s) => s.label)
    // Naghedi-Warehouse Catalog + PO imports are auto-checked via its Supabase
    // (2026-07-17 — they used to be manual checklist items). 'unknown' (fetch/
    // auth failure) blocks too, so a broken key can't quietly pass the gate.
    const nw = await getNwFreshness()
    if (nw.configured) {
      problems.push(
        ...nw.sources
          .filter((s) => s.status === 'stale' || s.status === 'missing' || s.status === 'unknown')
          .map((s) => s.label + (s.status === 'unknown' ? ` (couldn’t check: ${s.error})` : '')),
      )
    }
    return { ok: problems.length === 0, detail: problems.length ? `Still need updating: ${problems.join(', ')}` : 'ok' }
  },
}

async function runVerification(task) {
  const checklist = task.checklist || []
  const unchecked = checklist.filter((c) => !c.done)
  const verifier = task.verifyKey && VERIFIERS[task.verifyKey]
  const verifierResult = verifier ? await verifier() : { ok: true, detail: 'ok' }
  const problems = [
    ...(verifierResult.ok ? [] : [verifierResult.detail]),
    ...unchecked.map((c) => `Not checked: ${c.label}`),
  ]
  return { ok: problems.length === 0, detail: problems.join(' · ') }
}

export async function completeTask(id, done = true) {
  if (done) {
    const task = await fetchQuestTaskById(id)
    if (task?.completionMode === 'verified') {
      const result = await runVerification(task)
      if (!result.ok) throw new Error(result.detail)
    }
  }
  await completeQuestTask(id, done)
  await logTaskActivity({ taskId: id, kind: done ? 'done' : 'reopened', note: done ? 'Marked done' : 'Reopened' })
  return getQuestTasks()
}

export async function setTaskChecklistItem(id, itemKey, done) {
  const checklist = await updateTaskChecklistItem(id, itemKey, done)
  const item = checklist.find((c) => c.key === itemKey)
  await logTaskActivity({ taskId: id, kind: 'checklist_set', note: `${item?.label || itemKey}: ${done ? 'checked' : 'unchecked'}` })
  return getQuestTasks()
}

// 'daily_times' (e.g. 9am/2pm) spawns one instance per listed time, only
// once that time has actually passed today; 'daily' spawns once per day,
// whenever this next runs after midnight. instance_key's UNIQUE index is
// the actual dedupe — this function is safe to call as often as you like.
const URGENCY_UP = { lo: 'mid', mid: 'hi', hi: 'hi' }

// A repeat-asked task hands off to a DIFFERENT messenger, not just the same
// one getting louder (Nima, 2026-07-20: "another character take the task
// letting me [know] they were told previously by the other task manager to
// give me the task"). A template with a fixed characterId (Bugs owns the CSV
// monitor) never hands off — that's a dedicated role, not a rotation.
function pickHandoffCharacter(fixedCharacterId, currentCharacterId) {
  if (fixedCharacterId) return fixedCharacterId
  const pool = CHARACTERS.filter((c) => c.id !== currentCharacterId)
  return (pool.length ? pool : CHARACTERS)[Math.floor(Math.random() * (pool.length || CHARACTERS.length))].id
}

// An in-character nag when a recurring task is overdue (Nima, 2026-07-17: "if
// it hasn't been completed in time, increase the urgency and update with a new
// message in character asking what's going on"). Bugs (the CSV monitor) gets
// her own voice and never hands off. Everyone else, when a handoff happened,
// opens by naming who passed it to them — that's the "told previously by the
// other task manager" cue Nima wants visible in the message itself.
function overdueNag(template, characterId, agoLabel, prevCharacterId) {
  if (characterId === 'bugs' || template.verifyKey === 'csv_freshness_workhub') {
    return `Ehhh — what's up, Doc? These CSVs STILL aren't uploaded and we're ${agoLabel} overdue. I can't see a thing in here without 'em — let's get 'em in. 🥕`
  }
  const prevName = prevCharacterId && prevCharacterId !== characterId ? getCharacterById(prevCharacterId)?.name : null
  const handoff = prevName ? `${prevName} asked me to make sure this actually gets to you — ` : ''
  return `⚠ ${handoff}Still not done — ${agoLabel} overdue. Bumping this up; it needs handling now. ${template.description || ''}`.trim()
}

export async function ensureRecurringTasks() {
  const templates = await fetchActiveRecurringTemplates()
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  let created = 0
  for (const t of templates) {
    // 'daily' tasks stay SINGLE: one open instance at a time. Collapse any
    // duplicate spawns, and escalate (not re-create) if the open one has
    // rolled past its day without being completed.
    if (t.scheduleType !== 'daily_times') {
      const open = await fetchOpenRecurringInstances(t.key)
      if (open.length) {
        const [keep, ...extras] = open
        for (const e of extras) await deleteQuestTask(e.id) // redundant dupes — remove, don't complete
        const keptDay = new Date(keep.createdAt).toISOString().slice(0, 10)
        if (keptDay < dateStr) {
          const daysOverdue = Math.round((new Date(dateStr) - new Date(keptDay)) / 86_400_000)
          const nextCharacterId = pickHandoffCharacter(t.characterId, keep.characterId)
          await escalateRecurringTask(keep.id, {
            urgency: URGENCY_UP[keep.urgency] || 'hi',
            snippet: overdueNag(t, nextCharacterId, `${daysOverdue}d`, keep.characterId),
            characterId: nextCharacterId,
          })
          const handoffNote = nextCharacterId !== keep.characterId
            ? ` — handed off from ${getCharacterById(keep.characterId)?.name || 'previous messenger'} to ${getCharacterById(nextCharacterId)?.name || 'next messenger'}`
            : ''
          await logTaskActivity({ taskId: keep.id, kind: 'escalated', note: `Overdue ${daysOverdue}d — urgency raised${handoffNote}` })
        }
        continue // never spawn a second one
      }
      const characterId = t.characterId || CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id
      const taskId = await createRecurringTaskInstance({
        recurringKey: t.key, instanceKey: `${t.key}:${dateStr}`, characterId, subject: t.title, snippet: t.description,
        completionMode: t.completionMode, verifyKey: t.verifyKey, urgency: t.urgency, checklist: t.checklistItems,
      })
      if (taskId) { await logTaskActivity({ taskId, kind: 'created', note: `Recurring: ${t.title}` }); created++ }
      continue
    }

    // 'daily_times' (e.g. 9am/2pm reminders) — stays SINGLE too (Nima,
    // 2026-07-20: "asked over and over" shouldn't spawn ANOTHER separate nag;
    // it should escalate the one already open and hand off to a different
    // messenger). A slot only spawns a fresh instance when nothing for this
    // key is currently open; if one IS open and a later slot has since
    // passed, that's the repeat-ask moment — escalate instead of duplicating.
    const openDT = await fetchOpenRecurringInstances(t.key)
    if (openDT.length) {
      const [keep, ...extras] = openDT
      for (const e of extras) await deleteQuestTask(e.id)
      const keptAt = new Date(keep.createdAt)
      const passedSlotSince = (t.scheduleTimes || []).some((slot) => {
        const [hh, mm] = slot.split(':').map(Number)
        const slotTime = new Date(now); slotTime.setHours(hh, mm, 0, 0)
        return slotTime > keptAt && slotTime <= now
      })
      if (passedSlotSince) {
        const nextCharacterId = pickHandoffCharacter(t.characterId, keep.characterId)
        const hours = Math.round((now - keptAt) / 3.6e6)
        const agoLabel = hours < 24 ? `${Math.max(1, hours)}h` : `${Math.round(hours / 24)}d`
        await escalateRecurringTask(keep.id, {
          urgency: URGENCY_UP[keep.urgency] || 'hi',
          snippet: overdueNag(t, nextCharacterId, agoLabel, keep.characterId),
          characterId: nextCharacterId,
        })
        const handoffNote = nextCharacterId !== keep.characterId
          ? ` — handed off from ${getCharacterById(keep.characterId)?.name || 'previous messenger'} to ${getCharacterById(nextCharacterId)?.name || 'next messenger'}`
          : ''
        await logTaskActivity({ taskId: keep.id, kind: 'escalated', note: `Still open past a scheduled reminder${handoffNote}` })
      }
      continue // never spawn a duplicate while one is already open
    }
    for (const slot of t.scheduleTimes || []) {
      const [hh, mm] = slot.split(':').map(Number)
      const slotTime = new Date(now)
      slotTime.setHours(hh, mm, 0, 0)
      if (now < slotTime) continue
      const characterId = t.characterId || CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id
      const taskId = await createRecurringTaskInstance({
        recurringKey: t.key, instanceKey: `${t.key}:${dateStr}:${slot}`, characterId, subject: t.title, snippet: t.description,
        completionMode: t.completionMode, verifyKey: t.verifyKey, urgency: t.urgency, checklist: t.checklistItems,
      })
      if (!taskId) continue
      await logTaskActivity({ taskId, kind: 'created', note: `Recurring: ${t.title}` })
      created++
      break // one instance per key per run — later elapsed slots escalate it
            // on a future run instead of piling on a second fresh task
    }
  }

  // EDI orders that already exist as NetSuite SOs are real, confirmed work —
  // surface them as tasks automatically (Nima, 2026-07-20). Best-effort: an
  // Orderful/DB hiccup here must never break the core recurring reconcile.
  try {
    const edi = await ensureEdiTasks()
    created += edi.created
  } catch (e) {
    console.error('EDI task generation failed (recurring tasks still processed):', e.message)
  }
  return created
}

// needsType 'netsuite_doc' normalizes the number against its doc type's
// prefix (e.g. typing "1213" under Sales Order saves as "SO1213") — the one
// piece of this that isn't just a straight column write.
export async function setTaskNeeds({ id, needsType, needsNote, netsuiteDocType, netsuiteDocNumber }) {
  const normalizedNumber = needsType === 'netsuite_doc' ? normalizeDocNumber(netsuiteDocType, netsuiteDocNumber) : null
  await updateTaskNeeds({ id, needsType, needsNote, netsuiteDocType: needsType === 'netsuite_doc' ? netsuiteDocType : null, netsuiteDocNumber: normalizedNumber })
  const NEEDS_NOTE = {
    none: 'Marked as nothing needed', reply: 'Marked as reply needed', acknowledgment: 'Acknowledged',
    file: `File reference set${needsNote ? `: ${needsNote}` : ''}`,
    netsuite_doc: `NetSuite ${netsuiteDocType} reference set${normalizedNumber ? `: ${normalizedNumber}` : ''}`,
  }
  await logTaskActivity({ taskId: id, kind: 'needs_set', note: NEEDS_NOTE[needsType] || 'Needs updated' })
  return getQuestTasks()
}

export async function setTaskUrgency(id, urgency) {
  await updateTaskUrgency(id, urgency)
  await logTaskActivity({ taskId: id, kind: 'urgency_set', note: urgency ? `Urgency set to ${urgency}` : 'Urgency cleared' })
  return getQuestTasks()
}

export async function setTaskCharacter(id, characterId) {
  const character = getCharacterById(characterId)
  if (!character) throw new Error(`unknown characterId: ${characterId}`)
  await updateTaskCharacter(id, characterId)
  await logTaskActivity({ taskId: id, kind: 'character_set', note: `Reassigned to ${character.name}` })
  return getQuestTasks()
}

export async function getTaskActivity(date) {
  return fetchTaskActivity(date ? { date } : {})
}

export { NETSUITE_DOC_TYPES }
