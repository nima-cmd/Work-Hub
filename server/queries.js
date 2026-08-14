// server/queries.js — read orders (+ their fulfillments) from Neon and enrich
// each with the SAME pipeline flags the CLI analyzer uses, so UI and analyzer
// never disagree.

import { pool, DB_TARGET, IS_MIRROR, mirrorAsOf } from '../src/db.js'
import { computeFlags } from '../src/model/pipeline.js'
import { shipWindow } from '../src/model/shipWindow.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'
import { deriveTaskUrgency } from '../src/model/taskUrgency.js'
import { refreshProgress } from '../src/model/netsuiteRefreshSteps.js'
import { DEPARTURE_CONFIRMED, DEPARTURE_UNCONFIRMED, boardSettled } from '../src/model/netDeparture.js'
import { PREPPED, PREP_CLEARED } from '../src/model/prepped.js'
import { buildLabelWorksheet, worksheetCsv } from '../src/model/labelWorksheet.js'
import { pushOrders, ediOrdersFor, boutiqueOrdersFor, fetchBoutiqueAddresses, fetchBoutiqueShipMethods, fetchBoutiqueShipDetails } from '../src/ingest/shipstationPush.js'
import { harvestTracking, backfillPushedOrders } from '../src/ingest/shipstationTracking.js'
import { runSuiteQL, restGet, refName } from '../src/ingest/netsuiteApi.js'

// The API-created store ("Api Shipments"). Overridable per deploy; the account's
// other stores are the Shopify/retail ones and must not receive these.
const SHIPSTATION_STORE_ID = Number(process.env.SHIPSTATION_STORE_ID || 351819)
import { macysDc, parcelBilling } from '../src/model/bolAddresses.js'
import { SOURCE_LABELS, REQUIRED_SOURCES, SOURCE_LINKS } from '../src/ingest/detect.js'
import {
  fetchOrderConfirmations, fetchPurchaseOrders, fetchOcPoLinks,
  upsertOcPoLink, deleteOcPoLink, dismissOrderConfirmation, dismissPurchaseOrder,
  fetchCartonsForIfs,
} from '../src/ingest/loadToDb.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeContainerView } from '../src/model/ocPoContainers.js'
import { groupContainers, lateContainers } from '../src/model/containers.js'
import { computeEdiPipeline } from '../src/model/ediPipeline.js'
import { computeEdiWork } from '../src/model/ediWork.js'
import { computeAffection } from '../src/model/affection.js'
import { SPINE_LABEL, timeline, isOurInvoiceNumber, invNumberFrom810 } from '../src/model/orderEvents.js'
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
import { splitUnfiled } from '../src/model/filing.js'
import { paymentBlocked, clearedReason, overdueInvoices, overdueSummary, netTerms } from '../src/model/paymentGate.js'
import { labelGapKind, labelGapNeeded } from '../src/model/labelGap.js'
import { dcTagDeparture } from '../src/model/custody.js'
import { pushingAllowed, pushBlockedForLocation, PUSH_DISABLED_REASON } from '../src/model/labelSource.js'
import { PARCEL_LANE_SQL, isParcelLane, noBolReason } from '../src/model/parcelLane.js'
import { labelTracking, labelCount, SHIPSTATION_TRACKING_SQL, DEAD_LABEL_SQL } from '../src/model/labelEvidence.js'
import { closeReadiness } from '../src/model/closeReady.js'
import { loadTenders, loadRoutingShipments } from '../src/ingest/manhattanTender.js'
import { reconcileTender, matchStop, planTenderApply } from '../src/model/manhattanTender.js'
import { lastCheckedAt as macysRoutingLastChecked } from '../src/ingest/macysRouting.js'
import {
  fetchEdiPackages, assignBol, fetchRoutingShipments, voidRoutingShipment, markShipmentShipped,
  updateShipmentRefs, upsertRoutingAuth, fetchRoutingAuths, assignAuthToShipments, deleteRoutingAuth,
  markLabelDead, reviveLabel, fetchDeadLabels,
  fetchRoutingShipmentById,
  fetchRoutingHolds, addRoutingHold, removeRoutingHold, updateShipmentComposition, fetchShipmentsForPoDc,
  ensureMasterBol,
  fetchEmailLinks, addEmailLink, deleteEmailLink, searchEmailsForLink,
  fetchCatalogueSkus, fetchIfStatusByPo,
  fetchShipmentEdiLineage, fetchShipmentEdiSnapshots, saveShipmentEdiLineage,
  fetchFulfilmentPack, fetchFulfillmentDc,
  recordShipstationOrders, applyShipstationTracking, fetchShipstationOrders,
} from '../src/ingest/loadToDb.js'
import { checkGroupPack } from '../src/model/packCheck.js'
import { groupDepartures } from '../src/model/departures.js'
import { shipDateAdvice, rankShipDateAdvice, monthCloseCount, auditMarkedShipments } from '../src/model/shipDateAdvice.js'
import { computeSyncHealth, LIVE_SYNCS, CONDITIONAL_SYNCS } from '../src/model/syncHealth.js'
import { ASSUMPTIONS, MECHANICAL, summarize as summarizeAssumptions } from '../src/model/fieldAssumptions.js'
import { summarizeTransfer } from '../src/model/transferMeter.js'
import { INTEGRATIONS, computeIntegrationHealth, overallHealth } from '../src/model/health.js'
import { skuKeyOf, skuColorNorm } from '../src/ingest/savedSearches.js'
import { consolidateRouting, netsuiteShippedVerdict } from '../src/model/routing.js'
import { computeEdiDeliveryGaps } from '../src/model/ediDelivery.js'
import { asnCheckDue, asnSummary, ASN_CHECK_MIN_HOURS, ASN_CHECK_WINDOW_DAYS } from '../src/model/asnCartonCheck.js'
import { buildBolPdf, renderBolTo } from './bolPdf.js'
import { uploadBolPdf } from '../src/ingest/googleDrive.js'
import {
  fetchQuestEmails, loadQuestEmails, reconcileReadStatus, assignQuestEmailCharacter, markQuestEmailReadLocal, setQuestEmailLabelsLocal, dismissQuestEmail, setQuestEmailNote,
  fetchQuestEmailById, createQuestTask, createManualTask, fetchQuestTasks, fetchQuestTaskById, fetchOpenReplyTasks, completeQuestTask,
  updateTaskNeeds, updateTaskUrgency, updateTaskCharacter, updateTaskSchedule, searchQuestEmails, searchQuestTasks, logTaskActivity, fetchTaskActivity,
  fetchDayPlan, setDayPlanOrder, resetDayPlanOrder, setDayPlanItemDone,
  fetchActiveRecurringTemplates, createRecurringTaskInstance, updateTaskChecklistItem,
  fetchOpenRecurringInstances, escalateRecurringTask, deleteQuestTask,
  createEdiTask, raiseEdiTask, fetchEdiTaskStates, closeEdiTask,
} from '../src/ingest/loadToDb.js'
import { diffPoVersions, summarizePoDiff } from '../src/model/ediPoDiff.js'
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
            -- Does a carrier label exist for this fulfilment? The post-custody
            -- board needs it to tell "make the label" from "mark it packed"
            -- (src/model/postCustody.js): for a boutique parcel the label is
            -- what makes the order packable, and marking packed is what raises
            -- the invoice. A BOOLEAN, not the numbers — the board never shows
            -- them and the tracking list is long.
            -- ⚠️ TEXT[], not text. Comparing it to an empty string is a
            -- malformed array literal and 500s the whole /api/orders endpoint.
            -- (And no backticks in here — this is inside a JS template literal.)
            'labelled', COALESCE(array_length(f.tracking_numbers, 1), 0) > 0,
            'custodyOut', (SELECT MAX(e.occurred_at) FROM order_events e
                           WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'CUSTODY_OUT'),
            'custodyIn',  (SELECT MAX(e.occurred_at) FROM order_events e
                           WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'CUSTODY_IN'),
            -- "our part is done", recorded without telling NetSuite. Gates the
            -- mark-it-packed nudge for orders we must not invoice yet — see
            -- src/model/prepped.js.
            'preppedAt',     (SELECT MAX(e.occurred_at) FROM order_events e
                              WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'PREPPED'),
            'prepClearedAt', (SELECT MAX(e.occurred_at) FROM order_events e
                              WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'PREP_CLEARED'),
            'prepNote',      (SELECT e.note FROM order_events e
                              WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'PREPPED'
                              ORDER BY e.occurred_at DESC LIMIT 1),
            -- "it actually left", for the Net flow where no field can say so
            -- (src/model/netDeparture.js). Latest-of-the-pair wins.
            'departureConfirmedAt',   (SELECT MAX(e.occurred_at) FROM order_events e
                              WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'DEPARTURE_CONFIRMED'),
            'departureUnconfirmedAt', (SELECT MAX(e.occurred_at) FROM order_events e
                              WHERE e.doc_type = 'IF' AND e.doc_number = f.if_number AND e.event_type = 'DEPARTURE_UNCONFIRMED')
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
            'amountRemaining', i.amount_remaining, 'shipDate', i.ship_date,
            -- Terms are what make a balance mean something: paymentBlocked()
            -- needs them to tell "Due on receipt and owed" from "Net 30, not due
            -- yet" and from "No Payment Required". Without them a board reads
            -- every balance as a hold — the shape behind the retracted
            -- "70 departed shipments unpaid", where 105 of 109 simply weren't due.
            'terms', i.terms
          ) ORDER BY i.inv_number
        )
        FROM invoices i WHERE i.so_number = o.so_number
      ), '[]'::json) AS invoices,
      -- The partner's own ship window, off their 850. On an 850 (and ONLY an
      -- 850) business_number IS the PO number, so it joins the sales order
      -- directly — see [[po-document-timeline]] for why an 856/810 does not.
      --
      -- Newest 850 wins: partners re-transmit to move dates or units. Rows with
      -- no window at all are skipped rather than allowed to win, so a zeroing /
      -- cancel re-send can't blank a live window (the follow-up PR #12 left).
      (
        SELECT json_build_object(
          'shipNotBefore', TO_CHAR(e.ship_not_before, 'YYYY-MM-DD'),
          'cancelAfter',   TO_CHAR(e.cancel_after,   'YYYY-MM-DD')
        )
        FROM edi_transactions e
        WHERE e.type = '850_PURCHASE_ORDER'
          AND e.business_number = o.po_number
          AND (e.ship_not_before IS NOT NULL OR e.cancel_after IS NOT NULL)
        ORDER BY e.created_at DESC NULLS LAST
        LIMIT 1
      ) AS edi_window
    FROM orders o
    -- Placeholder orders are EXCLUDED here, at the single read path every work
    -- view uses (Nima, 2026-07-31: a temp order holding stock until the real one
    -- arrives — "we don't need to track it"). Filtering here rather than at
    -- ingest means the row stays in Neon and stays honest: if one is later
    -- converted to a real order, clearing the checkbox brings it straight back,
    -- and nothing had to be deleted and re-discovered.
    --
    -- IS NOT TRUE rather than a false comparison: the column is null for every
    -- CSV-sourced order, and testing equality with false would hide all of them.
    WHERE o.is_placeholder IS NOT TRUE
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
      // The ORDER's own payment terms. ⚠️ This mapper is a whitelist, so a new
      // column reaches no surface until it is named here — `SELECT o.*` above is
      // not enough. postCustody keys the Net flow on this (2026-08-11), and
      // without this line it would have read undefined on every card and quietly
      // put every order back on the old flow.
      terms: r.terms,
      amountPaid: num(r.amount_paid),
      // ⚠️ Whether each fulfilment still NEEDS SOMETHING, decided in one place
      // (src/model/netDeparture.js boardSettled) rather than by each surface. Mission
      // Quests shows only what needs work; a card that stays carries the reason, so a
      // shorter board can always explain itself instead of just being shorter.
      // Live when this landed: 181 of 214 settled, 33 kept (19 awaiting an invoice,
      // 13 not yet shipped, 1 Net-terms awaiting departure confirmation).
      fulfillments: (r.fulfillments || []).map((f) => {
        // ⚠️ The projection calls it `invoice`, not `invoiceNumber` — keying on the
        // wrong name made 201 of 214 read "still needs an invoice" when the true
        // figure is 19. Caught by comparing against the same rule run straight
        // against SQL; a plausible-looking count is exactly how this repo's counter
        // bugs have always presented.
        const v = boardSettled(
          { ...f, invoiceNumber: f.invoice, source: r.source, terms: r.terms, shipDate: f.actualShipDate },
          { netTerms })
        return { ...f, settled: v.settled, keepReason: v.reason }
      }),
      invoices: r.invoices,
      ediWindow: r.edi_window,
    }
    o.shipWindow = shipWindow(o, today)
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
// allowRescan (Nima, 2026-07-22): a repeat scan of the same direction is
// SILENTLY IGNORED by default — no blocking prompt, so scanning stays fast and
// re-reading a tag doesn't create noise. When Nima flips "Re-scan mode" on
// (a genuine re-handoff), allowRescan=true logs the repeat with its note.
export async function recordCustodyScan({ docNumber, direction, note, allowRescan = false }) {
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
    if (prior[0].n > 0 && !allowRescan) {
      // Already scanned this direction — ignore it (don't log), tell the client
      // so it can flash a quick non-blocking "already scanned" note.
      return { ignored: true, alreadyScanned: true, isDc: true, direction: dir, docNumber: doc,
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
  if (priorSameDir > 0 && !allowRescan) {
    return {
      ignored: true,
      alreadyScanned: true,
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
export async function getOrderEventsFeed({ date, docNumber, soNumber, types } = {}) {
  return fetchOrderEvents({ date, docNumber, soNumber, types })
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
           sc.status AS "shipCentralStatus",
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
             -- IF_REMOVED closes the register too, for a different reason: the
             -- fulfilment no longer exists in NetSuite (deleted/voided and usually
             -- replaced). Without it a scanned-then-deleted IF sat here forever
             -- with null SO/customer/status, since the LEFT JOIN below finds
             -- nothing and a deleted IF never departs. See reconcileFulfillments.
             bool_or(event_type IN ('CUSTODY_CLEARED','IF_REMOVED')) AS cleared
      FROM order_events
      WHERE doc_type='IF' AND event_type IN ('CUSTODY_OUT','CUSTODY_IN','CUSTODY_CLEARED','IF_REMOVED')
      GROUP BY doc_number
      HAVING bool_or(event_type IN ('CUSTODY_OUT','CUSTODY_IN'))  -- had at least one scan
    ) c
    LEFT JOIN fulfillments f ON f.if_number = c.if_number
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN shipcentral_queue sc ON sc.so_number = f.so_number
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

  // ⚠️ THE DC LANE HAD NO EQUIVALENT OF THE IF LANE'S `actual_ship_date IS NULL`
  // BELT-AND-SUSPENDERS (2026-08-06), and `NOT cleared` alone was worthless here
  // because nothing had ever written a DC CUSTODY_CLEARED: 41 live tags, 0 cleared,
  // 32 of them on POs that had wholly shipped and been invoiced. They rendered as
  // "back in our hands · sitting 14d with no movement" and dominated the register's
  // "52 back in our hands" headline.
  //
  // clearDepartedDcCustody now writes the marker at ingest, so this is the guard,
  // not the fix — and it deliberately calls the SAME dcTagDeparture the ingest side
  // calls rather than re-stating the rule in SQL. Two copies of one rule is how the
  // packed_status counters drifted (see the counter-truth audit); there is one rule
  // here and both readers ask it.
  const dcLive = await (async () => {
    if (!dcRows.length) return dcRows
    const pos = [...new Set(dcRows.map((r) => String(r.docNumber).split(':')[0]))]
    const { rows: ifs } = await pool.query(`
      SELECT o.po_number AS po, o.dc, f.if_number AS "ifNumber", f.actual_ship_date AS "actualShipDate"
      FROM fulfillments f JOIN orders o ON o.so_number = f.so_number
      WHERE o.po_number = ANY($1::text[])
    `, [pos])
    const byPo = new Map()
    for (const r of ifs) {
      if (!byPo.has(r.po)) byPo.set(r.po, [])
      byPo.get(r.po).push(r)
    }
    return dcRows.filter((r) => {
      // Same latest-OUT-vs-latest-IN test `shape` below applies, computed here
      // because the verdict needs it before shaping: a tag still out with the
      // warehouse is never closed by a ship date (see dcTagDeparture).
      const outT = r.custodyOut ? new Date(r.custodyOut).getTime() : 0
      const inT = r.custodyIn ? new Date(r.custodyIn).getTime() : 0
      const state = inT >= outT && inT > 0 ? 'returned' : 'with_warehouse'
      return !dcTagDeparture({
        docNumber: r.docNumber,
        fulfilments: byPo.get(String(r.docNumber).split(':')[0]) || [],
        state,
      }).departed
    })
  })()

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
  // Routing status per DC carton (Nima, 2026-07-22): reflect what Routing knows
  // back onto the scanned doc — is this PO-DC in the package feed, and does it
  // already have a BOL? So the Custody Register shows where routing stands.
  const [pkgs, ships] = await Promise.all([fetchEdiPackages(), fetchRoutingShipments()])
  const feedKeys = new Set(pkgs.map((p) => `${p.poNumber}|${p.dc}`))
  const bolByKey = new Map()
  for (const s of ships) for (const po of (s.memberPos || [])) bolByKey.set(`${po}|${s.dc}`, s)

  const dcResults = dcLive.map((r) => {
    const [po, abbrev] = String(r.docNumber).split(':')
    const key = `${po}|${abbrev || ''}`
    const ship = bolByKey.get(key)
    const routing = {
      inFeed: feedKeys.has(key),
      bolNumber: ship?.bolNumber || null,
      status: ship?.status || null,
    }
    return shape(r, {
      isDc: true, poNumber: po, dc: abbrev || null,
      label: `PO ${po}${abbrev ? ` · ${abbrev}` : ''}`,
      boxes: 0, boxList: [], inData: !!r.customer, routing,
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
// ── "Our part is done" (Nima, 2026-08-05) ───────────────────────────────────
// Records that the physical work on a fulfilment is finished WITHOUT marking it
// packed in NetSuite — because packed is the signal to accounting to invoice, and
// some boutique orders must not be invoiced early. Full reasoning in
// src/model/prepped.js.
//
// A plain ledger event, so it inherits the spine every other custody fact uses and
// needs no schema change. Latest-event-wins against PREP_CLEARED so a mis-click is
// undoable — a marker that can only ever be set is a trap.
export async function setFulfillmentPrepped({ ifNumber, prepped = true, note } = {}) {
  const doc = String(ifNumber || '').trim()
  if (!doc) throw new Error('ifNumber is required')
  // The SO rides along on the event as a denormalised spine ref (loose, no FK —
  // events must survive doc churn; see db/schema.sql order_events).
  const { rows: fr } = await pool.query('SELECT so_number FROM fulfillments WHERE if_number = $1', [doc])
  const soNumber = fr[0]?.so_number || null
  await insertOrderEvent({
    eventType: prepped ? PREPPED : PREP_CLEARED,
    docType: 'IF',
    docNumber: doc,
    soNumber,
    // The note answers "why isn't this packed?" a week later, which is the whole
    // point of holding it back on purpose.
    note: note?.trim() || null,
    source: 'manual',
  })
  return { ifNumber: doc, prepped }
}

// ── "Yes, it actually left" (Nima, 2026-08-13) ──────────────────────────────
// Under the Net-terms flow he marks an order Shipped when the LABEL is made, so
// NetSuite says shipped while the goods are still on the floor — and it drops out
// of his NetSuite searches at that moment, which is the visibility he lost. Every
// departure signal the app has is derived from that same keystroke, so nothing can
// answer this but a person. Full reasoning in src/model/netDeparture.js.
//
// A plain ledger event, same spine as PREPPED, no schema change, no NetSuite side
// effect, and undoable — a marker that can only ever be set is a trap.
export async function setFulfillmentDeparted({ ifNumber, departed = true, note } = {}) {
  const doc = String(ifNumber || '').trim()
  if (!doc) throw new Error('ifNumber is required')
  const { rows: fr } = await pool.query('SELECT so_number FROM fulfillments WHERE if_number = $1', [doc])
  if (!fr.length) throw new Error(`no fulfilment ${doc}`)
  await insertOrderEvent({
    eventType: departed ? DEPARTURE_CONFIRMED : DEPARTURE_UNCONFIRMED,
    docType: 'IF',
    docNumber: doc,
    soNumber: fr[0]?.so_number || null,
    note: note?.trim() || null,
    source: 'manual',
  })
  return { ifNumber: doc, departed }
}

export async function clearCustodyItem({ docType, docNumber }) {
  const dt = docType === 'DC' ? 'DC' : 'IF'
  if (!docNumber) throw new Error('docNumber required')
  await insertOrderEvent({
    eventType: 'CUSTODY_CLEARED', docType: dt, docNumber: String(docNumber),
    soNumber: null, note: 'Manually cleared from the register', source: 'manual',
  })
  return getCustodyRegister()
}

// ── Ship departures (Nima, 2026-07-16) — what is at the dock, and what holds it.
//
// ⚠️ THIS PAGE WAS SHOWING THE EXACT OPPOSITE OF ITS PURPOSE (found by the shape
// (iii)/(iv) sweep, 2026-08-04). It selected `WHERE f.packed_status IS NOT NULL`
// and its comment claimed "only rows with a packed_status at all are shown —
// everything else has already moved past this part of the pipeline". Both halves
// were inverted. That hand-keyed IF-Packed-Status field is non-null on exactly 8
// of 190 fulfilments and **all 8 have already shipped** (6 to 29 days ago), while
// the 70 IFs still physically here all have it NULL. So the page listed departed
// shipments under "Can depart today" and hid every shipment awaiting departure —
// and had all 8 been cleared it would have said "Nothing waiting on departure 🎉".
//
// This is the same dead field that made the header's `waiting` figure read 0
// (see getCredits), and the same one getLaunchBay was REWORKED to abandon back on
// 2026-07-17 — that rework simply never reached this second copy.
//
// So there is no second copy any more: departures ARE the launch bay, bucketed by
// the bay's derived state. One source, so the two pages cannot disagree about
// what is on the dock, and the objective `actual_ship_date IS NULL` scope comes
// with it. NOTE this also inherits the bay's CHINA EXCLUSION — a China/FOB order
// is collected abroad and never departs our dock, so it does not belong on a
// departures board; it is surfaced on its own `fobPickup` lane instead
// (src/model/labelGap.js).
export async function getShipDepartures({ today = new Date() } = {}) {
  return getLaunchBay({ today })
}

// ── Shipment credits (Nima, 2026-07-17) — the header counter ─────────────────
// Two figures, shown as "galactic credits" but really plain dollars:
//   • shippedThisMonth — sum of SHIPPED_VALUE ledger snapshots dated this month
//     (pinned to actual ship date, immune to later payment zeroing the invoice);
//   • waiting — outstanding balance across the ships sitting in the Launch Bay.
//
// ⚠️ `waiting` READ 0 FOREVER, and 0 in a header reads as "nothing is waiting"
// (found by audit 2026-08-04). It was gated on `f.packed_status IS NOT NULL` —
// the hand-keyed IF-Packed-Status field that getLaunchBay's own comment says it
// was REWORKED TO ABANDON because the saved search went stale. Measured: that
// field is non-null on 0 of 70 unshipped fulfilments (8 of 190 ever, all of them
// long since shipped), so the sum was STRUCTURALLY zero — it could not have
// reported a number whatever the data did. Meanwhile the bay held 11 ships with
// $7,593.60 outstanding.
//
// So `waiting` is now derived from getLaunchBay() itself rather than from a
// second, hand-written copy of "what's in the bay". That makes the sentence above
// true by construction: the two cannot drift, and the bay's real scope rules come
// along for free — notably the CHINA EXCLUSION. Summing packed-not-shipped
// invoices directly would report $98,248, but $90,654 of that is IF7414, which
// ships FOB direct from China and never sits on our dock
// (see src/model/labelGap.js). Counting it as "waiting to leave" would overstate
// the figure by 12x on a header counter.
export async function getCredits({ today = new Date() } = {}) {
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const [shipped, bay] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(NULLIF(note,'')::numeric), 0) AS total
       FROM order_events
       WHERE event_type = 'SHIPPED_VALUE' AND occurred_at >= $1`,
      [monthStart],
    ),
    getLaunchBay({ today }),
  ])
  return {
    shippedThisMonth: Number(shipped.rows[0].total),
    waiting: bay.reduce((n, s) => n + Number(s.amountRemaining || 0), 0),
    month: monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
  }
}

// ── The ledger read (2026-08-02) ─────────────────────────────────────────────
// "A repository we can go back and search through, and the basis for the
// calendar showing what occurred every day." Two ways in:
//
//   • by order   — getOrderLedger('SO12293'): everything that happened to that
//     order and to every document hanging off it.
//   • by date    — getLedger({ from, to }): what occurred in a window, which is
//     what the Calendar wants.
//
// Events are tagged `observed: true` when their date is a first-sighting rather
// than a real source timestamp (see the order_events comment in schema.sql), so
// the UI can say "seen on" instead of implying it knows the day it happened.

// occurred_at is only a first-sighting for these three — nothing upstream
// records when they actually happened.
const OBSERVED_TYPES = ['PACKED', 'INVOICED', 'PAID']

const LEDGER_FIELDS = `id, event_type AS "eventType", doc_type AS "docType",
                       doc_number AS "docNumber", so_number AS "soNumber",
                       note, source, occurred_at AS "occurredAt"`

const decorate = (rows) =>
  rows.map((r) => ({
    ...r,
    label: SPINE_LABEL.get(r.eventType) || r.eventType,
    observed: OBSERVED_TYPES.includes(r.eventType),
  }))

// One order's complete history. An event is part of it when it names the SO, or
// when it sits on a document belonging to the SO — the second half matters
// because DC routing events and some EDI events have no so_number of their own.
export async function getOrderLedger(soNumber) {
  const so = String(soNumber || '').trim()
  if (!so) return { soNumber: null, events: [] }

  const { rows: docs } = await pool.query(
    `SELECT 'IF' AS doc_type, if_number  AS doc_number FROM fulfillments WHERE so_number = $1
     UNION ALL
     SELECT 'INV',            inv_number                FROM invoices     WHERE so_number = $1`,
    [so],
  )
  const ifs = docs.filter((d) => d.doc_type === 'IF').map((d) => d.doc_number)
  const invs = docs.filter((d) => d.doc_type === 'INV').map((d) => d.doc_number)

  const { rows } = await pool.query(
    `SELECT ${LEDGER_FIELDS} FROM order_events
      WHERE so_number = $1
         OR (doc_type = 'SO'  AND doc_number = $1)
         OR (doc_type = 'IF'  AND doc_number = ANY($2))
         OR (doc_type = 'INV' AND doc_number = ANY($3))`,
    [so, ifs, invs],
  )
  return { soNumber: so, documents: { fulfillments: ifs, invoices: invs }, events: timeline(decorate(rows)) }
}

// One PO's complete document trail — the roadmap's item C, the dated
// 850 → SO → IF → 856 → 810 story for a single partner PO.
//
// The EDI pipeline view already knows a PO's *state*, but it collapses the whole
// history into one stage rank. This is the other question: not "how far along is
// it" but "what happened, and when".
//
// Assembling it is a resolution problem, because no EDI event is keyed on the PO
// except the 850 (see the eventsFromEdi comment — an 856 is keyed on its BOL and
// an 810 on our invoice number). Four routes in, all of them through a table that
// already owns the mapping rather than a denormalized copy:
//
//   • the 850          — doc_type 'PO', doc_number IS the PO
//   • its sales orders — orders.po_number, then their IFs and invoices, which
//                        pulls the whole NetSuite half of the trail in with them
//   • its ASNs         — edi_document_po_refs → the 856's own reference
//   • its 810s         — edi_document_po_refs → our invoice number
//
// The last two are many-to-many on purpose: one ASN can announce several POs and
// one PO can ship on several ASNs, so an ASN legitimately appears on more than
// one PO's timeline. It is still one transmission and one row in order_events.
export async function getPoLedger(poNumber) {
  const po = String(poNumber || '').trim()
  if (!po) return { poNumber: null, documents: {}, events: [] }

  const [{ rows: nsDocs }, { rows: ediDocs }] = await Promise.all([
    pool.query(
      `SELECT 'SO' AS doc_type, o.so_number AS doc_number FROM orders o WHERE o.po_number = $1
       UNION ALL
       SELECT 'IF', f.if_number FROM fulfillments f
         JOIN orders o ON o.so_number = f.so_number WHERE o.po_number = $1
       UNION ALL
       SELECT 'INV', i.inv_number FROM invoices i
         JOIN orders o ON o.so_number = i.so_number WHERE o.po_number = $1`,
      [po],
    ),
    // The 810's stored doc_number carries the 'INV' prefix Orderful strips, so
    // rebuild it here the same way invNumberFrom810 does — including the
    // already-prefixed case, which is real (invoice 9114 was transmitted once as
    // '9114' and once as 'INV9114') and produced 'INVINV9114' before this guard.
    // ⚠️ MIRROR, not approximate: the `~* '^(INV)?[0-9]{1,6}$'` shape test is
    // isOurInvoiceNumber, and a reference that fails it is stored verbatim
    // because prefixing it would name an invoice that doesn't exist (Nordstrom's
    // 'C13369495' → 'INVC13369495'). Diverge from the model here and the trail
    // silently loses its 810s.
    // GROUP BY, not DISTINCT, so each document also carries its first
    // transmission date — that date is what places an unresolvable partner ref
    // against the floor of the invoice records we hold (partnerRefNotes).
    pool.query(
      `SELECT CASE WHEN t.type LIKE '856%' THEN 'ASN' ELSE 'INV' END AS doc_type,
              CASE WHEN t.type LIKE '856%'            THEN t.business_number
                   WHEN t.business_number !~* '^(INV)?[0-9]{1,6}$' THEN t.business_number
                   WHEN t.business_number ILIKE 'INV%' THEN upper(t.business_number)
                   ELSE 'INV' || t.business_number END               AS doc_number,
              min(t.created_at) AS sent_at
         FROM edi_document_po_refs r
         JOIN edi_transactions t ON t.id = r.transaction_id
        WHERE r.po_number = $1
          AND t.direction = 'OUT' AND t.stream = 'LIVE'
          AND (t.type LIKE '856%' OR t.type LIKE '810%')
        GROUP BY 1, 2`,
      [po],
    ),
  ])

  const pick = (rows, type) => [...new Set(rows.filter((d) => d.doc_type === type).map((d) => d.doc_number))]
  const sos = pick(nsDocs, 'SO')
  const ifs = pick(nsDocs, 'IF')
  const asns = pick(ediDocs, 'ASN')
  // An invoice can arrive from either side — NetSuite's SO join or the 810's own
  // number — and the two overlap by design. Merge before querying so a shared
  // invoice doesn't widen the IN list twice.
  //
  // ⚠️ This is a list of INVOICE DOCUMENTS, not of our invoices: where a partner
  // bills under its own reference (Nordstrom's 'C13369495') the 810 contributes
  // that reference, so a count of this array is NOT a count of invoices raised.
  // isOurInvoiceNumber is the test if you need to separate them.
  const invs = [...new Set([...pick(nsDocs, 'INV'), ...pick(ediDocs, 'INV')])]

  // A partner reference that isn't ours can still be RESOLVED (Nima, 2026-08-03).
  // Nordstrom bills like it receives — one consolidated document per DC belonging
  // to a PO — and that document's number is on our own invoices as
  // `custbody_hb_edi_nordstrom_inv`. So 'C13369495' is not unknowable after all:
  // it covers INV11246. Of the 116 non-ours-shaped refs held, 71 resolve from
  // Neon this way; 20 more are on invoices NetSuite confirms but that predate
  // the document window; the last 25 split 12 NMG (Feb 2025, the field is
  // Nordstrom-only) + 10 cutover bare-digit shapes (never DELIVERED) + 3
  // C-refs on no invoice anywhere (all measured live 2026-08-03).
  //
  // ⚠️ ADDITIVE, and deliberately not a re-key. The partner's reference stays in
  // the list verbatim — rewriting it to one of our numbers would both name a
  // single invoice for a document that covers up to SEVEN, and repeat the
  // INVC13369495 fabrication. This only lets the trail pick up the INVOICED/PAID
  // events of the invoices sitting underneath the consolidated document.
  //
  // Beyond pulling the covered invoices in, each ref now reports what it IS —
  // resolved, older than the records we hold, or a genuine gap — because the
  // three cases previously rendered identically and only the first is benign
  // (see classifyPartnerRef in the model for the measured split).
  const foreignRefs = invs.filter((d) => !isOurInvoiceNumber(d))
  const partnerRefs = []
  let invoiceRecordsFrom = null
  if (foreignRefs.length) {
    const [{ rows: covered }, { rows: floorRows }] = await Promise.all([
      pool.query(
        `SELECT nordstrom_ref, array_agg(inv_number ORDER BY inv_number) AS invs
           FROM invoices WHERE nordstrom_ref = ANY($1) GROUP BY nordstrom_ref`,
        [foreignRefs.map((r) => r.trim().toUpperCase())],
      ),
      // The coverage floor the sync recorded for the invoice document window.
      // ⚠️ NOT min(invoices.trandate) — that table is a UNION of the document
      // window and old invoices riding in on still-open SOs (a 2024-11-19 stray
      // was live when this was built), so its min() would claim coverage of a
      // span we hold only strays from. NULL until a post-merge sync has run;
      // partnerRefNotes degrades to claims that need no floor.
      pool.query(`SELECT value AS floor FROM sync_meta WHERE key = 'invoice_documents_from'`),
    ])
    invoiceRecordsFrom = floorRows[0]?.floor || null
    const coversBy = new Map(covered.map((r) => [r.nordstrom_ref, r.invs]))
    const sentBy = new Map(ediDocs.filter((d) => d.doc_type === 'INV').map((d) => [d.doc_number, d.sent_at]))
    for (const ref of foreignRefs) {
      const covers = coversBy.get(ref.trim().toUpperCase()) || []
      partnerRefs.push({ ref, covers, sentAt: sentBy.get(ref) || null })
      for (const n of covers) if (!invs.includes(n)) invs.push(n)
    }
  }

  const { rows } = await pool.query(
    `SELECT ${LEDGER_FIELDS} FROM order_events
      WHERE (doc_type = 'PO'  AND doc_number = $1)
         OR (doc_type = 'ASN' AND doc_number = ANY($2))
         OR (doc_type = 'INV' AND doc_number = ANY($3))
         OR (doc_type = 'IF'  AND doc_number = ANY($4))
         OR (doc_type = 'SO'  AND doc_number = ANY($5))
         OR so_number = ANY($5)`,
    [po, asns, invs, ifs, sos],
  )

  return {
    poNumber: po,
    documents: { salesOrders: sos, fulfillments: ifs, invoices: invs, asns },
    partnerRefs,
    invoiceRecordsFrom,
    events: timeline(decorate(rows)),
  }
}

// A window of the ledger, newest first — the Calendar's feed and the general
// search. `q` matches a document number so "IF7413" finds its whole trail.
export async function getLedger({ from = null, to = null, type = null, docType = null, q = null, limit = 500 } = {}) {
  const params = []
  const where = []
  // Every '$?' in `sql` binds the SAME value — which is what the `q` clause
  // needs, matching one search term against two columns.
  const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('$?', `$${params.length}`)) }

  if (from) add('occurred_at >= $?', from)
  if (to) add('occurred_at < $?', to)
  if (type) add('event_type = ANY($?)', Array.isArray(type) ? type : [type])
  if (docType) add('doc_type = $?', docType)
  if (q) add('(doc_number ILIKE $? OR so_number ILIKE $?)', `%${q}%`)

  params.push(Math.min(Number(limit) || 500, 2000))
  const { rows } = await pool.query(
    `SELECT ${LEDGER_FIELDS} FROM order_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  )
  return decorate(rows)
}

// Per-day counts for the Calendar's dots — cheap enough to load a whole month.
export async function getLedgerDailyCounts({ from, to } = {}) {
  const { rows } = await pool.query(
    `SELECT occurred_at::date AS day, event_type AS "eventType", count(*)::int AS n
       FROM order_events
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR occurred_at <  $2)
      GROUP BY 1, 2 ORDER BY 1 DESC`,
    [from || null, to || null],
  )
  const byDay = new Map()
  for (const r of rows) {
    // A pg DATE arrives as a JS Date; toISOString would shift it across the
    // date line in a negative-offset timezone. Format from the local parts.
    const d = r.day instanceof Date
      ? `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, '0')}-${String(r.day.getDate()).padStart(2, '0')}`
      : String(r.day).slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, { day: d, total: 0, byType: {} })
    const e = byDay.get(d)
    e.total += r.n
    e.byType[r.eventType] = r.n
  }
  return [...byDay.values()]
}

// ── Departures = shipments, not fulfilments (Nima, 2026-08-02) ───────────────
// "Each DC has multiple IF … that inflates the number." 2026-07-30 read as 50
// departures everywhere; it was 8. See src/model/departures.js for the rule.
// The DC of an ALREADY-SHIPPED fulfilment only survives in fulfillment_dc —
// edi_fulfillment_pack drops it the moment freight leaves.
export async function getDepartures({ from = null, to = null } = {}) {
  const [dcByIf, shipments] = await Promise.all([fetchFulfillmentDc(), fetchRoutingShipments()])
  const { rows } = await pool.query(
    `SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber",
            f.actual_ship_date AS "actualShipDate", f.invoice_number AS "invoiceNumber",
            o.customer, o.source, o.po_number AS "poNumber"
       FROM fulfillments f LEFT JOIN orders o USING (so_number)
      WHERE f.actual_ship_date IS NOT NULL
        AND ($1::date IS NULL OR f.actual_ship_date >= $1)
        AND ($2::date IS NULL OR f.actual_ship_date <  $2)`,
    [from || null, to || null],
  )
  const enriched = rows.map((r) => ({ ...r, poDc: dcByIf.get(r.ifNumber)?.poDc || null }))
  return groupDepartures(enriched, shipments)
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
           i.amount_remaining AS "amountRemaining",
           a.approved_since AS "approvedSince",
           c.custody_out AS "custodyOut", c.custody_in AS "custodyIn",
           sc.status AS "shipCentralStatus"
    FROM fulfillments f
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN invoices i ON i.inv_number = f.invoice_number
    LEFT JOIN shipcentral_queue sc ON sc.so_number = f.so_number
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

// Step 7: shipments whose signed paper has never been filed.
//
// The last step of Nima's flow had no surface at all — the scan→Drive pipeline
// worked, but filing wrote nothing down, so there was no way to ask which
// shipments still owed paper. This is that question.
//
// Keyed on the FULFILMENT, because the fulfilment is the thing that physically
// left and its packing slip is the paper. The old bare-PO tags file at DC level
// instead (see filingTarget) and so can't clear an IF here — that only affects
// documents scanned before the slips carried an IF QR, which are all pre-epoch
// backlog anyway.
//
// The due/backlog split lives in the model (splitUnfiled); this just supplies
// the shipped-and-unfiled set. No LIMIT: `fulfillments` carries the open window
// only (91 shipped rows today, oldest 2026-06-05), so the whole set is small.
export async function getUnfiledPaper({ now = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber",
           f.actual_ship_date AS "shippedAt",
           o.customer, o.po_number AS "poNumber",
           CASE WHEN fd.if_number IS NOT NULL THEN 'edi' ELSE 'boutique' END AS channel,
           fd.dc
    FROM fulfillments f
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN fulfillment_dc fd ON fd.if_number = f.if_number
    WHERE f.status ILIKE '%shipped%'
      AND NOT EXISTS (
        SELECT 1 FROM order_events e
        WHERE e.event_type = 'FILED' AND e.doc_type = 'IF' AND e.doc_number = f.if_number
      )
    ORDER BY f.actual_ship_date DESC NULLS LAST
  `)
  return splitUnfiled(rows, { now })
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

// Live-sync health — did the scheduled syncs actually RUN? Separate question
// from getFreshness() above, which measures how old the source data is. A sync
// that stops looks exactly like a quiet day unless someone asks this.
export async function getSyncHealth() {
  const { rows } = await pool.query(
    `SELECT source, MAX(imported_at) AS last_at FROM import_snapshots
      WHERE source = ANY($1) GROUP BY source`,
    [[...LIVE_SYNCS, ...CONDITIONAL_SYNCS].map((s) => s.key)],
  )
  const lastBySource = Object.fromEntries(rows.map((r) => [r.source, r.last_at]))
  return computeSyncHealth(lastBySource)
}

// Health — what's configured, what's reachable, what's still arriving. Built
// after the deploy went 13h without a NetSuite sync while its cron returned 200
// on every run: the creds were simply absent, and a missing credential is not an
// error anywhere in this app (every integration skips quietly when unset).
//
// ⚠️ Sends BOOLEANS and VARIABLE NAMES only — never a credential value. The
// presence map is built here and nothing downstream can see more than that.
// The field-assumption register (src/model/fieldAssumptions.js). Static — it is a
// code fact, not a query — but served with Health so the app has one place that
// answers "which numbers here have lied before, and what did they turn out to be
// keyed on". Deliberately no table: see that file's header.
export function getFieldAssumptions() {
  return { summary: summarizeAssumptions(), entries: ASSUMPTIONS, guards: MECHANICAL }
}

export async function getHealth() {
  const present = {}
  for (const i of INTEGRATIONS) {
    for (const v of [...i.vars, ...(i.optional || [])]) present[v] = Boolean(process.env[v])
  }
  const integrations = computeIntegrationHealth(present)
  const syncs = await getSyncHealth()
  // ⚠️ WHICH DATABASE fed every number on this page. A local mirror is stale by
  // definition; the sync ages above are the ages recorded IN the snapshot, so on a
  // mirror they describe how fresh Neon was when it was cloned, not now. Reporting
  // those as live would be the field-assumption bug class applied to the whole app.
  const m = await mirrorAsOf()
  // Neon's transfer meter. Soft — a diagnostic must never blank the page it is on,
  // and this table is younger than the rest of the schema.
  let transfer = null
  try {
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, source, bytes, queries FROM transfer_log ORDER BY day`)
    transfer = summarizeTransfer(rows, { today: new Date().toISOString().slice(0, 10) })
  } catch { transfer = null }
  return {
    overall: overallHealth({ integrations, syncs }), integrations, syncs,
    fieldAssumptions: getFieldAssumptions(),
    database: {
      target: DB_TARGET,
      isMirror: IS_MIRROR,
      clonedAt: m?.at ? m.at.toISOString() : null,
      ageHours: m?.ageHours ?? null,
    },
    transfer,
  }
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

// ── inbound containers — the arrival side ────────────────────────────────────
// Its own endpoint rather than a slice of getOcPoReview: the court strip needs
// this app-wide on every page, and the allocation review is a much heavier
// payload to drag along for one count.
export async function getInboundContainers({ now = new Date() } = {}) {
  const pos = await fetchPurchaseOrders()
  const { containers, unreconciled, undated, asOf } = groupContainers(pos, { today: now })
  const late = lateContainers(containers)
  return {
    containers,
    unreconciled,
    undated,
    asOf,
    counts: {
      // Never summed — see lateContainers. `late` is the only actionable number.
      late: late.length,
      lateUnits: late.reduce((n, c) => n + c.unitsOpen, 0),
      awaiting: containers.filter((c) => c.state === 'awaiting').length,
      unreconciled: unreconciled.length,
      // Open lines with no Final Naghedi Destination, so unmatchable to any OC.
      unmatchableLines: [...containers, ...unreconciled].reduce((n, c) => n + c.unmatchableLines, 0),
    },
  }
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
  // The arrival side: the same PO rows regrouped by due date, which is what a
  // container is here (see src/model/containers.js). `containers` above is the
  // OC↔PO allocation lens and keeps its name; this is `inbound`.
  const inbound = groupContainers(pos, { today: new Date() })
  return {
    suggestedMatches, candidates, unmatchedOcs, unmatchedPos, links,
    locations, containers, unassignedOcs, inbound,
  }
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

  // Which POs are already routed. Needed because Bloomingdale's carries a ROUTING
  // deadline 3 business days ahead of its cancel date (src/model/shipWindow.js),
  // and a deadline flag that cannot see the work already done is just a false
  // positive generator — live today all 4 open Bloomingdale's POs are routed, so
  // an ungated flag would have fired 4-for-4 wrong on its first run.
  //
  // Decorated onto the orders here rather than threaded as a 4th argument to
  // computeEdiWork, which has five callers.
  const { rows: routedRows } = await pool.query(
    `SELECT DISTINCT unnest(member_pos) AS po_number, MAX(ship_date) AS ship_date
     FROM routing_shipment GROUP BY 1`)
  const routedByPo = new Map(routedRows.map((r) => [String(r.po_number), r.ship_date]))
  const orders = (pipeline.orders || []).map((o) => ({
    ...o,
    routed: routedByPo.has(String(o.businessNumber)),
    routedShipDate: routedByPo.get(String(o.businessNumber)) || null,
  }))

  return { ...pipeline, orders, manualOrders, resolutions, ediTasks, ediSupply }
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
export async function resolveEdiPo({ businessNumber, closed, cancelled, netsuiteRef, note, reviewState }) {
  if (!businessNumber?.trim()) throw new Error('businessNumber is required')
  await upsertEdiPoResolution({ businessNumber: businessNumber.trim(), closed, cancelled, netsuiteRef, note, reviewState })
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
// Every store-level fulfilment riding on a shipment, so a parcel label can name the
// PO and the store. Scoped to the shipment ids asked for, so it never scans.
//
// The DC join matters: a PO fans out to one sales order per STORE, and a shipment
// covers only the stores whose DC matches it. Without `o.dc = rs.dc` a Secaucus
// worksheet would list every store on the PO, nationwide.
async function fetchShipmentStoreCartons(ids = []) {
  const map = new Map()
  if (!ids.length) return map
  const { rows } = await pool.query(
    `SELECT rs.id AS shipment_id, o.po_number, o.store_number, o.customer,
            o.so_number, f.if_number, p.cartons, p.packed_units, p.if_units
     FROM routing_shipment rs
     JOIN orders o ON o.po_number = ANY(rs.member_pos) AND o.dc = rs.dc
     LEFT JOIN fulfillments f ON f.so_number = o.so_number
     LEFT JOIN edi_fulfillment_pack p ON p.if_number = f.if_number
     WHERE rs.id = ANY($1)
     ORDER BY rs.id, o.store_number, o.po_number`,
    [ids],
  )
  // The real carton rows — weight and dimensions per box, not a total to divide.
  const cartonsByIf = await fetchCartonsForIfs([...new Set(rows.map((r) => r.if_number).filter(Boolean))])
  for (const r of rows) {
    if (!map.has(r.shipment_id)) map.set(r.shipment_id, [])
    map.get(r.shipment_id).push({
      poNumber: r.po_number, storeNumber: r.store_number,
      soNumber: r.so_number, ifNumber: r.if_number,
      cartons: cartonsByIf.get(r.if_number) || [],
    })
  }
  return map
}

// The label worksheet as CSV, for a carrier's batch-import tool (Nima, 2026-08-05:
// "If this is something we can make as an export to import into UPS let me know").
// One row per carton, because that is one label.
// Push the parcel shipments into ShipStation so labels can be bought there instead
// of typed. NOTHING IS PURCHASED — see src/ingest/shipstationPush.js.
//
// `scope`: 'edi' (DC-direct cartons, weights and dims included) or 'boutique'
// (no packages — the box is chosen in ShipStation, like retail).
// `ifNumbers` narrows a run to named fulfilments — the break-glass path (Nima,
// 2026-08-11: "sometimes the netsuite UPS label creator has issues and we're in a
// rush and printing it in shipstation if we can push the data out would be better
// than manually creating the label ourself").
//
// The DEFAULT IS STILL NOTHING: this is per-order and human-initiated, so no
// scheduled run starts pushing Warehouse orders. `force` lifts the LOCATION
// policy only — the judgement of which system is working today is his to make.
//
// ⚠️ WHAT FORCE MUST NEVER LIFT: `labelCount > 0`. That check lives in
// src/model/shipstationEligible.js, not in the location gate, so it is outside
// force's reach by construction — and it stays that way. A second live label on a
// box already carrying one is a double charge and a wrong tracking number on the
// ASN, and certainty about NetSuite being down does not make it safe. Tested.
export async function pushToShipstation({ scope = 'edi', dryRun = false, force = false, ifNumbers = null, storeId = SHIPSTATION_STORE_ID } = {}) {
  const only = Array.isArray(ifNumbers) && ifNumbers.length
    ? new Set(ifNumbers.map((s) => String(s).trim().toUpperCase()))
    : null
  // ⚠️ Labels are made in NetSuite for now — see src/model/labelSource.js for the three
  // costs that decided it. This gates ORDER CREATION only; the read-only harvest, the
  // cost sync, the rate quotes and check:label-records all keep working. A dry run is
  // still allowed because it writes nothing and is how you see what WOULD go.
  // ⚠️ THIS GATE IS NOW PER-ORDER, NOT GLOBAL (Nima, 2026-08-07: "can we unblock
  // shipstation label for anything no the warehouse location"). The double-label
  // risk lives at the Warehouse location, where NetSuite labels on fulfil; the
  // partner locations do not. So each candidate is judged on its own location and
  // a blocked one is NAMED rather than the whole run refusing — see
  // src/model/labelSource.js for why China and a missing location stay blocked.
  const locationBlock = (location) => (
    pushingAllowed({ force, location }) ? null : (pushBlockedForLocation(location) ?? PUSH_DISABLED_REASON)
  )
  if (scope === 'boutique') {
    // ⚠️ THIS FILTERED ON `packed` UNTIL 2026-08-06, WHICH IS THE DONE PILE.
    // Nima: "We want the shipstation to only pick up our picked not packed — if it's
    // packed ShipStation done its job or the label was created elsewhere." Measured
    // that day: 9 orders live in ShipStation, all 9 Packed and 8 already carrying a
    // NetSuite tracking number, while 4 UPS `Picked` fulfilments that genuinely needed
    // labels were absent. He was seeing what he had already made.
    //
    // The status filter is deliberately WIDE now (unshipped, not china) and
    // src/model/shipstationEligible.js decides — so a fulfilment that is Packed with
    // no label anywhere still reaches a verdict and gets NAMED rather than filtered
    // away silently. `tracking_numbers` rides along because an existing label ends the
    // question regardless of what the status claims.
    //
    // ⚠️ NOT boutique-only any more (Nima, 2026-08-11). This scope is the PARCEL
    // lane, not a channel: ShopBop is an EDI partner that ships small parcel, and
    // `source = 'boutique'` alone excluded it from ShipStation entirely while the
    // EDI push could only build from a routing shipment — i.e. from a BOL ShopBop
    // must never receive. See src/model/parcelLane.js. Widening the candidates is
    // safe because eligibility still decides per fulfilment: anything that isn't
    // domestic UPS with resolvable billing comes back HELD, with its reason.
    const { rows } = await pool.query(
      // ⚠️ labelCount must count labels from BOTH sources. Asking only
      // f.tracking_numbers meant a label bought through OUR OWN push was
      // invisible to the gate meant to stop a second one: IF7507 had three
      // ShipStation labels and still read as unlabelled (2026-08-11). The
      // ALREADY_LABELLED hold is the one thing `force` can never lift, so it has
      // to be fed the whole truth. See src/model/labelEvidence.js.
      `SELECT f.if_number AS "ifNumber", o.so_number AS "soNumber", o.po_number AS "poNumber",
              o.customer, o.location, f.status,
              f.tracking_numbers AS "nsTracking",
              ${SHIPSTATION_TRACKING_SQL} AS "ssTracking",
              ${DEAD_LABEL_SQL} AS "deadTracking"
       FROM fulfillments f JOIN orders o ON o.so_number = f.so_number
       WHERE f.actual_ship_date IS NULL
         AND (o.source = 'boutique' OR ${PARCEL_LANE_SQL})
         AND COALESCE(o.location,'') NOT ILIKE '%china%'
       ORDER BY f.if_number`)
    // Location gate first, so a Warehouse fulfilment never reaches the builder.
    // Held rows carry their own reason — a boutique order at the Warehouse is not
    // a defect, it is NetSuite's to label.
    const locationHeld = []
    const pushable = []
    for (const r of rows.filter((r) => !only || only.has(String(r.ifNumber).toUpperCase()))) {
      const why = locationBlock(r.location)
      if (why) locationHeld.push({ ifNumber: r.ifNumber, soNumber: r.soNumber, reason: why })
      else pushable.push(r)
    }
    // Addresses live only in NetSuite — Neon has no address column at all. The
    // requested carrier/service too, and deliberately in a SEPARATE call (see
    // fetchBoutiqueShipMethods for why folding them together is a trap).
    const soByIf = new Map(pushable.map((r) => [r.ifNumber, r.soNumber]))
    const [addrs, methods, details] = await Promise.all([
      fetchBoutiqueAddresses(pushable.map((r) => r.ifNumber), { runSuiteQL }),
      fetchBoutiqueShipMethods(pushable.map((r) => r.ifNumber), { runSuiteQL }),
      // The service NAME and who pays, from the sales order REST record — the carrier
      // GROUP that `methods` returns cannot distinguish Fedex from DHL from UPS.
      fetchBoutiqueShipDetails(pushable.map((r) => r.ifNumber), soByIf, { runSuiteQL, restGet, refName }),
    ])
    const { orders, skipped, records } = boutiqueOrdersFor(
      pushable.map((r) => ({
        order: r, fulfilment: { ifNumber: r.ifNumber, status: r.status },
        address: addrs.get(r.ifNumber),
        labelCount: labelCount({ nsTracking: r.nsTracking, ssTracking: r.ssTracking, deadTracking: r.deadTracking }),
        // How many of this box's labels a human has declared dead. Releases the
        // PACKED_NO_LABEL hold — see src/model/shipstationEligible.js for why that
        // is safe rather than a loosening.
        deadLabelCount: (r.deadTracking || []).length,
        carrier: methods.get(r.ifNumber)?.carrier ?? null,
        shipMethod: methods.get(r.ifNumber)?.shipMethod ?? null,
        shipMethodName: details.get(r.ifNumber)?.shipMethodName ?? null,
        thirdPartyAcct: details.get(r.ifNumber)?.thirdPartyAcct ?? null,
        thirdPartyZip: details.get(r.ifNumber)?.thirdPartyZip ?? null,
        readFailed: details.get(r.ifNumber)?.readFailed ?? false,
      })),
      { storeId },
    )
    const res = await pushOrders(orders, { dryRun })
    const recorded = await rememberPush(records, res, dryRun)
    return {
      ...res, scope, skipped: [...(skipped || []), ...locationHeld],
      // `seen` is what this RUN looked at, so a per-order push reports 1 rather
      // than 25 — a count that doesn't mean its label is the bug this repo keeps
      // finding (npm run check:counters exists for exactly that shape).
      candidates: pushable.length,
      seen: only ? rows.filter((r) => only.has(String(r.ifNumber).toUpperCase())).length : rows.length,
      inScope: rows.length,
      locationHeld: locationHeld.length, recorded,
      forced: force || undefined,
    }
  }

  const routing = await getRouting()
  const list = Array.isArray(routing) ? routing : (routing.shipments || [])
  // Parcel only: freight moves on a BOL and FOB is collected abroad, both of which
  // `labels.applicable` already excludes. Shipped ones are done.
  const parcel = list.filter((s) => s.labels?.applicable && !s.shippedAt && /ups/i.test(s.carrier || ''))
  // The location gate applies here too — CHECKED, not assumed. An EDI shipment's
  // location is the partner's, so none of them should be Warehouse or China; but
  // "should be" is what the comment on the invoiced-stage promotion said, and that
  // mechanism was never running. So look it up: the member POs carry the location.
  const locByPo = new Map()
  const memberPos = [...new Set(parcel.flatMap((s) => s.memberPos || []))]
  if (memberPos.length) {
    const { rows: locRows } = await pool.query(
      'SELECT po_number, MIN(location) AS location FROM orders WHERE po_number = ANY($1) GROUP BY po_number',
      [memberPos])
    for (const r of locRows) locByPo.set(String(r.po_number), r.location)
  }
  const locationHeld = []
  const shipments = parcel.filter((s) => {
    for (const po of s.memberPos || []) {
      const why = locationBlock(locByPo.get(String(po)))
      if (why) { locationHeld.push({ bolNumber: s.bolNumber, dc: s.dc, po, reason: why }); return false }
    }
    return true
  })
  const { orders, records } = ediOrdersFor(shipments, { storeId })
  const res = await pushOrders(orders, { dryRun })
  const recorded = await rememberPush(records, res, dryRun)
  return {
    ...res, scope, shipments: shipments.length, seen: parcel.length,
    skipped: locationHeld, locationHeld: locationHeld.length,
    candidates: orders.length, recorded,
  }
}

// Write down what we just pushed. A dry run records NOTHING — it did not happen.
// Only orders ShipStation actually accepted are remembered, with the orderId it
// handed back, so a failed create never leaves a row claiming a label exists.
async function rememberPush(records = [], res = {}, dryRun = false) {
  if (dryRun || !records.length) return 0
  const idByKey = new Map((res.results || []).filter((r) => r.ok).map((r) => [r.orderKey, r.orderId]))
  const accepted = records
    .filter((r) => idByKey.has(r.orderKey))
    .map((r) => ({ ...r, shipstationId: idByKey.get(r.orderKey) }))
  return recordShipstationOrders(accepted)
}

// Read-only: pull what the carrier did back onto the orders we pushed. Never
// marks anything shipped — see src/ingest/shipstationTracking.js.
export async function syncShipstationTracking({ pages = 3, backfill = false } = {}) {
  // Orders pushed before this table existed have no row to harvest onto.
  let backfilled = 0
  if (backfill) {
    const b = await backfillPushedOrders({ pages })
    if (b.ok) backfilled = await recordShipstationOrders(b.records)
  }
  const known = await fetchShipstationOrders()
  if (!known.length) return { ok: true, known: 0, applied: 0, scanned: 0 }
  const ours = new Set(known.map((k) => k.orderKey))
  const h = await harvestTracking({ ours, pages })
  if (!h.ok) return { ok: false, error: h.error, configured: h.configured, known: known.length, applied: 0, scanned: h.scanned }
  const applied = await applyShipstationTracking(h.rows)
  return { ok: true, known: known.length, matched: h.rows.length, applied, scanned: h.scanned, backfilled }
}

export async function getLabelWorksheetCsv({ bolNumber = null } = {}) {
  const r = await getRouting()
  const list = Array.isArray(r) ? r : (r.shipments || [])
  const sheets = list
    .filter((s) => s.labels?.applicable && !s.shippedAt)
    .filter((s) => !bolNumber || String(s.bolNumber) === String(bolNumber))
    .map((s) => s.labels)
  return { csv: worksheetCsv(sheets), sheets: sheets.length, cartons: sheets.reduce((n, w) => n + w.cartons, 0) }
}

// Attach the accepted tender to each routing shipment it covers.
//
// ⚠️ Tenders are walked newest-pickup-first and an already-annotated shipment is left
// alone. Nordstrom reuses the same DC numbers every cycle, so without that the May
// tender could overwrite August's on a DC whose PO list we no longer hold. The PO
// overlap in matchStop is the primary guard; this is the tiebreak behind it.
//
// Soft-fails: the tender tables are additive and a deploy that has not migrated yet
// must not take the whole Routing board down with it.
async function annotateTenders(shipments) {
  if (!shipments.length) return
  let tenders = []
  try {
    tenders = await loadTenders({ limit: 50 })
  } catch (e) {
    console.error('tender annotation skipped:', e.message)
    return
  }
  for (const t of tenders) {
    const report = reconcileTender(t, shipments)
    if (report.outOfScope) continue // a past cycle, not a disagreement
    for (const stop of t.stops) {
      const s = matchStop(stop, shipments)
      if (!s || s.tender) continue
      const diffs = report.diffs
        .filter((d) => d.shipmentId === s.id)
        .map((d) => ({ kind: d.kind, ours: d.ours, theirs: d.theirs, detail: d.detail }))
      s.tender = {
        shipmentId: t.shipmentId,
        pickupAt: t.pickupAt,
        pickupDate: report.pickupYmd,
        pickupRaw: t.pickupRaw,
        carrier: t.carrier,
        srr: stop.srr,
        cartons: t.totalCartons,
        cartonsAgree: report.cartonsAgree,
        agrees: diffs.length === 0,
        diffs,
      }
    }
  }
}

export async function getRouting() {
  const [packages, shipments, auths, holds] = await Promise.all([
    fetchEdiPackages(), fetchRoutingShipments(), fetchRoutingAuths(), fetchRoutingHolds(),
  ])
  // Held PO-DCs are pulled OUT of consolidation so they can never be bundled
  // onto another PO's BOL; they surface in their own "held" list instead.
  const heldSet = new Set(holds.map((h) => `${h.po}|${h.dc}`))
  const active = packages.filter((p) => !heldSet.has(`${p.poNumber}|${p.dc}`))
  const groups = consolidateRouting(active)
  const held = holds.map((h) => {
    const row = packages.find((p) => String(p.poNumber) === String(h.po) && String(p.dc) === String(h.dc))
    return {
      po: h.po, dc: h.dc, note: h.note, label: `PO ${h.po} · DC ${h.dc}`,
      cartons: row?.cartons ?? null, weight: row?.weight ?? null, units: row?.units ?? null, inFeed: !!row,
    }
  })

  // Annotate every shipment with NetSuite's own verdict on whether its freight
  // has left, with the per-PO evidence attached (never one lumped flag).
  const ifsByPo = await fetchIfStatusByPo(shipments.flatMap((s) => s.memberPos || []))
  // The EDI paper trail: prefer the frozen snapshot taken at archive time, fall
  // back to the live derivation for shipments not yet archived. So a BOL's 850 →
  // 856 reference is visible before it's archived and preserved after.
  const [lineages, snapshots] = await Promise.all([
    fetchShipmentEdiLineage(shipments.map((s) => s.bolNumber)),
    fetchShipmentEdiSnapshots(),
  ])
  // Per-carton label worksheet for the DC-direct parcel shipments (Nima,
  // 2026-08-05). One address, many stores — the PO + store pair is the only thing
  // distinguishing 22 otherwise identical labels, and it is what the DC needs
  // printed to cross-dock the carton onward. See src/model/labelWorksheet.js.
  const worksheetRows = await fetchShipmentStoreCartons(shipments.filter((s) => s.shipDirect).map((s) => s.id))

  // Parcels we pushed to ShipStation, indexed by IF (Nima, 2026-08-05: "we now
  // have tracking we can add to the routing cards"). Joined on the IF rather
  // than PO+DC because rows recovered by the backfill carry no DC — the order in
  // ShipStation never knew one.
  const parcelsByIf = new Map()
  for (const p of await fetchShipstationOrders()) {
    if (!p.ifNumber) continue
    if (!parcelsByIf.has(p.ifNumber)) parcelsByIf.set(p.ifNumber, [])
    parcelsByIf.get(p.ifNumber).push(p)
  }

  for (const s of shipments) {
    s.netsuite = netsuiteShippedVerdict(s.memberPos || [], ifsByPo)
    s.labels = buildLabelWorksheet(
      {
        ...s,
        address: macysDc(s.dc),
        billing: parcelBilling({
          partner: s.partner, carrier: s.carrier,
          freightTerms: s.freightTerms, billToAccount: s.billToAccount,
        }),
      },
      worksheetRows.get(s.id) || [],
    )
    // ⚠️ A tracking number is NOT evidence the carton left — the label can be
    // bought days early, and on this lane marking shipped is itself done ahead
    // of the pickup to trigger the ASN. So this is reference, deliberately
    // reported as counts rather than as a state ("3 of 4 labelled", never
    // "shipped"). See src/ingest/shipstationTracking.js.
    const ifs = [...new Set((s.labels?.lines || []).map((l) => l.ifNumber).filter(Boolean))]
    const parcels = ifs.flatMap((n) => parcelsByIf.get(n) || [])
    s.parcels = parcels.length
      ? {
          pushed: parcels.length,
          labelled: parcels.filter((p) => p.trackingNumber && !p.voided).length,
          voided: parcels.filter((p) => p.voided).length,
          items: parcels.map((p) => ({
            orderKey: p.orderKey, ifNumber: p.ifNumber, cartonNo: p.cartonNo,
            orderNumber: p.orderNumber, trackingNumber: p.trackingNumber,
            carrier: p.carrierCode, shipDate: p.shipDate, voided: p.voided,
          })),
        }
      : null

    const live = lineages[String(s.bolNumber)] || null
    const snap = snapshots[s.id] || null
    s.edi = live
      ? { ...live, snapshotAt: snap?.capturedAt || null }
      : snap
        ? {
            asn: {
              transactionId: snap.asnTransactionId, businessNumber: snap.asnBusinessNumber,
              createdAt: snap.asnCreatedAt, deliveryStatus: snap.asnDeliveryStatus,
              ackStatus: snap.asnAckStatus,
            },
            po850: snap.poLinks || [],
            poRefs: (snap.poLinks || []).map((p) => p.po),
            fromSnapshot: true, snapshotAt: snap.capturedAt,
          }
        : null
    // An ASN went out but NetSuite still doesn't call it shipped — a real gap,
    // surfaced rather than used to auto-archive.
    s.asnAheadOfNetsuite = !!(s.edi?.asn && !s.netsuite.confirmed)

    // Can this BOL be closed out? Evidence only — see src/model/closeReady.js
    // for why both halves must agree and why nothing here closes anything.
    s.closeReady = closeReadiness({
      shippedAt: s.shippedAt,
      hasAsn: !!s.edi?.asn,
      ackStatus: s.edi?.asn?.ackStatus || null,
      netsuiteConfirmed: !!s.netsuite?.confirmed,
    })
  }

  // What Nordstrom's TMS actually ACCEPTED, against what we asked for. We choose a
  // ship_date when we submit routing; the tender email is the answer, and until now it
  // lived only in Nima's inbox. Attached per shipment as evidence — never written over
  // ship_date / carrier / routing_request_number, which are all his hand entry.
  // See src/model/manhattanTender.js.
  await annotateTenders(shipments)

  const byKey = new Map()
  for (const s of shipments) byKey.set(s.dcPoKey, s)

  // Pack check (Nima, 2026-08-02): every unit on a fulfilment must be in a
  // carton before its group can ship. Keyed by PO-DC so a group covering several
  // POs picks up each one's fulfilments.
  const packByPoDc = await fetchFulfilmentPack()

  const consolidated = groups.map((g) => {
    const dcPoKey = `${g.partner}|${g.dc}|${g.memberPos.join(',')}`
    const members = g.memberPos.flatMap((po) => packByPoDc.get(`${po}-${g.dc}`) || [])
    return { ...g, dcPoKey, shipment: byKey.get(dcPoKey) || null, pack: checkGroupPack(members) }
  })

  const liveKeys = new Set(consolidated.map((g) => g.dcPoKey))
  const detached = shipments.filter((s) => !liveKeys.has(s.dcPoKey))

  const gaps = await computeRoutingGaps({ packages: active, shipments })

  // packages returned raw too, so the view can re-consolidate over a PO subset
  // (the "consolidate by DC across selected POs" interaction) client-side.
  // heldKeys lets the client exclude held PO-DCs from that client-side rollup.
  return {
    packages, consolidated, shipments, detached, auths, gaps,
    held, heldKeys: [...heldSet], packageCount: packages.length,
    // When the Macy's routing-notification reader last ran (null = it never has).
    // ⚠️ This is what lets a card say "waiting on the notification" instead of
    // "nothing in this app reads that email" — two sentences that were the same
    // sentence for months, which is how a hand-entry lane came to look automated.
    // Cheap: one key out of sync_meta, not a Gmail call per page load.
    macysRoutingCheckedAt: await macysRoutingLastChecked(),
    // Flat, like `packages`: the view re-consolidates over a PO subset
    // client-side and must be able to recompute the pack check to match.
    fulfilmentPack: [...packByPoDc.values()].flat(),
  }
}

// ── Catalogue upload tracking ────────────────────────────────────────────────
// Partners whose open-PO SKUs must exist in the (one master) catalogue. Nordstrom
// only for now — add 'shopbop' etc. here when confirmed.
const CATALOGUE_PARTNERS = ['nordstrom']

// Shared reader: catalogue master + open PO lines for the tracked partners,
// each line flagged uploaded vs not (matched on ProductID+color = UPC grain).
async function readCatalogueGaps() {
  const cat = await fetchCatalogueSkus()
  const uploaded = new Set(cat.map((c) => c.skuKey))
  // prefill maps from the catalogue's own data (color→code, productId→desc)
  const colorCode = {}, pidDesc = {}
  for (const c of cat) {
    if (c.color && c.colorCode) colorCode[skuColorNorm(c.color)] ??= c.colorCode
    if (c.productId && c.description) pidDesc[c.productId] ??= c.description
  }
  const destClause = CATALOGUE_PARTNERS.map((_, i) => `destination ILIKE $${i + 1}`).join(' OR ')
  const { rows } = await pool.query(
    `SELECT po_number AS "poNumber", item, qty_ordered AS "qtyOrdered"
     FROM purchase_orders
     WHERE NOT COALESCE(dismissed,false) AND item ILIKE 'SN%' AND (${destClause})
     ORDER BY item, po_number`,
    CATALOGUE_PARTNERS.map((p) => `%${p}%`),
  )
  const bySku = new Map()
  for (const r of rows) {
    const s = String(r.item).trim()
    const d = s.indexOf('-')
    if (d < 0) continue
    const productId = s.slice(0, d).toUpperCase()
    const color = s.slice(d + 1)
    const key = skuKeyOf(productId, color)
    let e = bySku.get(key)
    if (!e) { e = { key, item: s, productId, color, pos: new Set(), qty: 0, uploaded: uploaded.has(key) }; bySku.set(key, e) }
    e.pos.add(r.poNumber); e.qty += Number(r.qtyOrdered) || 0
  }
  const skus = [...bySku.values()]
  return { cat, uploaded, colorCode, pidDesc, skus }
}

export async function getCatalogueGaps() {
  const { cat, colorCode, pidDesc, skus } = await readCatalogueGaps()
  const snap = await pool.query(`SELECT MAX(file_modified) AS m, MAX(imported_at) AS i FROM import_snapshots WHERE source='catalogue'`)
  const missing = skus.filter((s) => !s.uploaded).map((s) => ({
    item: s.item, productId: s.productId, color: s.color, pos: [...s.pos].sort(), qty: s.qty,
    colorCode: colorCode[skuColorNorm(s.color)] || null, description: pidDesc[s.productId] || null,
  }))
  return {
    partners: CATALOGUE_PARTNERS,
    catalogueCount: cat.length,
    lastImport: snap.rows[0].m || snap.rows[0].i || null,
    totalSkus: skus.length,
    uploaded: skus.filter((s) => s.uploaded).length,
    missingCount: missing.length,
    missing,
  }
}

// The prefilled catalogue add-file (catalogue column order + everything we have;
// GTIN/description left blank to fill). One row per missing SKU.
export async function buildCatalogueAddCsv() {
  const { missing } = { missing: (await getCatalogueGaps()).missing }
  const today = new Date().toISOString().slice(0, 10).split('-')
  const mdy = `${today[1]}/${today[2]}/${today[0]}`
  const H = ['SelectionCode', 'SelectionCodeDesc', 'ProductID', 'ProductIDDescEnglish', 'GTIN', 'GTINType', 'ChangeDate', 'GS1USColorCode', 'ShortColorDescEnglish', 'GS1USSizeCode', 'ShortSizeDescEnglish', 'ExtProductIDDescEnglish', '__Item(SKU)', '__OpenPOs', '__TotalQtyOrdered']
  const rows = [H]
  for (const m of missing) {
    rows.push(['001', 'Handbags', m.productId, m.description || '', '', 'UP', mdy, m.colorCode || '', m.color.replace(/-/g, ' '), '00000', 'No Size', '', m.item, m.pos.join(' '), m.qty])
  }
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
}

// Hold a PO-DC out of routing. If it's already on a BOL, restructure that
// shipment: drop the PO and recompute its totals from the remaining PO-DCs, or
// void it if nothing's left (the BOL number stays retired, never reused).
export async function holdRoutingPo({ po, dc, note }) {
  if (!po || !dc) throw new Error('po and dc are required')
  await addRoutingHold({ po: String(po), dc: String(dc), note })
  const affected = await fetchShipmentsForPoDc(po, dc)
  if (affected.length) {
    const packages = await fetchEdiPackages()
    for (const s of affected) {
      const remaining = (s.memberPos || []).filter((p) => String(p) !== String(po))
      if (!remaining.length) {
        await voidRoutingShipment(s.id) // nothing left to ship on this BOL
        continue
      }
      // Recompute the rolled-up totals over the remaining PO-DCs for this DC.
      const rows = packages.filter((p) => String(p.dc) === String(s.dc) && remaining.includes(String(p.poNumber)))
      const [g] = consolidateRouting(rows)
      await updateShipmentComposition(s.id, {
        memberPos: remaining,
        cartons: g?.cartons ?? null, units: g?.units ?? null,
        weightLb: g?.weightLb ?? null, cubicFeet: g?.cubicFeet ?? null,
      })
    }
  }
  return getRouting()
}

export async function releaseRoutingPo({ po, dc }) {
  await removeRoutingHold(po, dc)
  return getRouting()
}

// ── Email → document links (reusable) ────────────────────────────────────────
const GMAIL_BASE = 'https://mail.google.com/mail/u/0/#all/'
export async function getEmailLinks(docType, docNumber) {
  if (!docType || !docNumber) throw new Error('docType and docNumber are required')
  return fetchEmailLinks(docType, String(docNumber))
}
export async function addEmailLinkFor(body = {}) {
  const { docType, docNumber, subject, gmailId, threadId, fromAddr } = body
  if (!docType || !docNumber) throw new Error('docType and docNumber are required')
  // Prefer a real Gmail deep link built from the MESSAGE id (anchors Gmail to
  // that specific message in the thread); fall back to the thread id, then to a
  // pasted URL (for mail that isn't synced into the app). Using the thread id
  // opened the conversation at its newest message, not the linked one.
  const gmailUrl = (gmailId || threadId) ? `${GMAIL_BASE}${gmailId || threadId}` : (body.gmailUrl || '')
  if (!gmailUrl) throw new Error('need a Gmail message/thread id or a pasted URL')
  await addEmailLink({ docType, docNumber: String(docNumber), subject, gmailUrl, gmailId, threadId, fromAddr })
  return getEmailLinks(docType, String(docNumber))
}
export async function removeEmailLink(id, docType, docNumber) {
  await deleteEmailLink(id)
  return (docType && docNumber) ? getEmailLinks(docType, String(docNumber)) : { ok: true }
}
export async function searchLinkableEmails(q) {
  return searchEmailsForLink(q)
}

// Per-PO DC breakdown for the Kanban's "N DC tags" button. The DC assignment is
// NOT in the order/fulfillment ship-to (that's just the store) — it lives in the
// routing feed (edi_packages, authoritative w/ cartons) and the per-DC custody
// scans. Union both → { [poNumber]: [{ dc, cartons }] }. A PO not yet packed/
// scanned has no DCs here, so the button correctly stays a single PO-level tag.
export async function getPoDcs() {
  const map = {}
  const ensure = (po, dc) => {
    if (!po || !dc) return null
    const m = (map[po] ||= {})
    return (m[dc] ||= { dc, cartons: 0, stores: 0 })
  }
  // Primary + best source: per-SO DC on the order (each EDI SO is one store, so
  // grouping by DC gives the real store count). Populated once the Order
  // Pipeline export carries the DC Code / Store Number columns.
  const ord = await pool.query(
    `SELECT po_number AS po, dc, COUNT(*)::int AS stores
     FROM orders WHERE po_number IS NOT NULL AND dc IS NOT NULL AND dc <> '' GROUP BY po_number, dc`,
  )
  for (const r of ord.rows) { const e = ensure(String(r.po), String(r.dc)); if (e) e.stores += r.stores }
  // Augment with the routing feed (authoritative carton counts) …
  for (const p of await fetchEdiPackages()) { const e = ensure(String(p.poNumber), String(p.dc)); if (e) e.cartons += Number(p.cartons) || 0 }
  // … and any per-DC custody scans (covers DCs seen physically but not yet fed).
  const scans = await pool.query(`SELECT DISTINCT doc_number FROM order_events WHERE doc_type='DC' AND doc_number LIKE '%:%'`)
  for (const r of scans.rows) { const [po, dc] = String(r.doc_number).split(':'); ensure(po, dc) }

  const out = {}
  for (const [po, dcs] of Object.entries(map)) out[po] = Object.values(dcs).sort((a, b) => (a.dc < b.dc ? -1 : 1))
  return out
}

// The Scan Bay ↔ Routing bridge (Nima, 2026-07-22): a DC carton we've scanned
// back into our possession but that ISN'T in the current routing feed means we
// can't route it yet — and the Scan Bay knows exactly which PO-DC and why.
//   - 'missing'  — in possession, not in the feed at all → export it / it wasn't
//                  packed into EDI packages yet.
//   - 'stale'    — in the feed, but we scanned it back AFTER the last feed
//                  export → re-upload EDIPackagesVolume; the numbers may be old.
// Cartons that already have a BOL are flagged handled (hasShipment) so they drop
// off the "needs attention" list.
async function computeRoutingGaps({ packages, shipments }) {
  const { rows: dcRows } = await pool.query(`
    SELECT doc_number AS "docNumber",
           MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_OUT') AS out_at,
           MAX(occurred_at) FILTER (WHERE event_type='CUSTODY_IN')  AS in_at
    FROM order_events
    WHERE doc_type='DC' AND event_type IN ('CUSTODY_OUT','CUSTODY_IN','CUSTODY_CLEARED')
    GROUP BY doc_number
    HAVING bool_or(event_type IN ('CUSTODY_OUT','CUSTODY_IN')) AND NOT bool_or(event_type='CUSTODY_CLEARED')
  `)
  const snap = await pool.query(`SELECT MAX(file_modified) AS m FROM import_snapshots WHERE source='ediPackagesVolume'`)
  const feedAt = snap.rows[0].m ? new Date(snap.rows[0].m).getTime() : 0
  const inFeed = new Set(packages.map((p) => `${p.poNumber}|${p.dc}`))
  const shipped = new Set(shipments.flatMap((s) => (s.memberPos || []).map((po) => `${po}|${s.dc}`)))

  const gaps = []
  for (const r of dcRows) {
    const outT = r.out_at ? new Date(r.out_at).getTime() : 0
    const inT = r.in_at ? new Date(r.in_at).getTime() : 0
    if (!(inT > 0 && inT >= outT)) continue // only cartons currently back in our hands
    const [po, dc] = String(r.docNumber).split(':')
    if (!dc) continue
    const key = `${po}|${dc}`
    let reason = null
    if (!inFeed.has(key)) reason = 'missing'
    else if (feedAt && inT > feedAt) reason = 'stale'
    if (!reason) continue
    gaps.push({ po, dc, label: `PO ${po} · DC ${dc}`, reason, lastScanAt: new Date(inT).toISOString(), hasShipment: shipped.has(key) })
  }
  gaps.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'missing' ? -1 : 1))
  return { items: gaps, feedImportedAt: feedAt ? new Date(feedAt).toISOString() : null }
}

export async function setShipmentShipped(id, shipped = true) {
  await markShipmentShipped(id, shipped)
  // Archiving by hand freezes the EDI paper trail too, exactly as the sync's
  // auto-archive does — otherwise a manually-shipped BOL loses its 850/856
  // reference the moment those transactions age out of the Orderful window.
  if (shipped) {
    const s = await fetchRoutingShipmentById(id)
    if (s?.bolNumber) {
      const lineage = (await fetchShipmentEdiLineage([s.bolNumber]))[String(s.bolNumber)]
      if (lineage) await saveShipmentEdiLineage(id, s.bolNumber, lineage)
    }
  }
  return getRouting()
}

// ── Label / shipped-status reconciliation (Nima, 2026-07-30) ─────────────────
// Two failure modes hide in the "Packed" queue, and they need OPPOSITE actions.
// Splitting them is the whole point — lumped together they just look like a
// backlog, which is why SO12288/SO12293 sat unnoticed:
//
//   • LABELLED_NOT_SHIPPED — the IF carries a carrier tracking number but is still
//     Packed. It physically went out and someone entered tracking; only the status
//     transition was missed. Action: mark it shipped in NetSuite. Until then the
//     app (correctly) shows it as still with us, and no shipped-$ credit is stamped.
//
//   • NEEDS_LABEL — packed, no tracking at all. Genuinely still here awaiting a
//     label. Action: make the label.
//
// Aged by how long it has been sitting so the oldest surface first — that's the
// "nothing sits ignored" mission.
// ── Overdue invoices (Nima, 2026-08-04) ──────────────────────────────────────
//
// Explicitly NOT a shipping gate — he was clear that chasing an overdue invoice
// "doesn't directly fall into our job", which is why net terms past due still
// ship (see paymentGate.js). It's a DIAGNOSTIC: an invoice past due either means
// the money arrived and wasn't posted, or we never actually asked for it.
//
// On the EDI lane the second case is checkable, and that closes a gap this app
// documented as unprovable: the "invoices never sent" chip could show stuck 810s
// but NOT say the money went unasked-for, because the invoices table then began
// in 2026-05 and payment wasn't checkable from Neon. With the widened document
// window plus amount_remaining and due_date, an overdue partner invoice whose
// 810 never reached the partner IS that claim, evidenced.
//
// An 810 names our invoice one of two ways — its own business number (ours, via
// invNumberFrom810) or, for Nordstrom, a consolidated reference we store on
// invoices.nordstrom_ref. Both are checked; neither is invented.
export async function getOverdueInvoices({ today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT i.inv_number       AS "invNumber",
           i.so_number        AS "soNumber",
           i.terms,
           i.due_date         AS "dueDate",
           i.amount_remaining AS "amountRemaining",
           i.nordstrom_ref    AS "nordstromRef",
           -- The order's customer when we hold the order; otherwise the
           -- invoice's own bill-to, which is always present.
           COALESCE(o.customer, i.bill_to) AS customer,
           o.source
    FROM invoices i
    LEFT JOIN orders o ON o.so_number = i.so_number
    WHERE i.amount_remaining > 0 AND i.due_date IS NOT NULL
  `)

  // Which invoices have an 810 the partner actually RECEIVED. Delivered-only:
  // a PENDING/FAILED 810 is precisely the "never billed them" case.
  const { rows: docs } = await pool.query(`
    SELECT business_number AS "businessNumber", delivery_status AS "deliveryStatus"
    FROM edi_transactions
    WHERE type LIKE '810%' AND business_number IS NOT NULL
  `)
  const delivered = new Set()
  const seen = new Set()
  for (const d of docs) {
    const key = String(invNumberFrom810(d.businessNumber) || '').toUpperCase()
    if (!key) continue
    seen.add(key)
    if (String(d.deliveryStatus || '').toUpperCase() === 'DELIVERED') delivered.add(key)
  }

  const byInv = new Map(rows.map((r) => [String(r.invNumber).toUpperCase(), r]))
  // null = we hold no 810 record either way, reported as unknown rather than
  // counted as a missing document. An absent record is not evidence.
  const ediInvoiceDelivered = (invNumber) => {
    const inv = String(invNumber || '').toUpperCase()
    const row = byInv.get(inv)
    const refs = [inv, row?.nordstromRef ? String(row.nordstromRef).toUpperCase() : null].filter(Boolean)
    if (refs.some((k) => delivered.has(k))) return true
    if (refs.some((k) => seen.has(k))) return false
    return null
  }

  const items = overdueInvoices(rows, { today, ediInvoiceDelivered })
  return { items, summary: overdueSummary(items) }
}

export async function getLabelGaps({ today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT f.if_number      AS "ifNumber",
           f.so_number      AS "soNumber",
           f.status,
           f.packed_status  AS "packedStatus",
           f.if_date        AS "ifDate",
           f.invoice_number AS "invoiceNumber",
           f.tracking_numbers AS "trackingNumbers",
           -- A label bought in ShipStation lands in shipstation_order, NOT on the
           -- fulfilment — so asking f.tracking_numbers alone called IF7507's three
           -- real labels "needs a label" (2026-08-11). See labelEvidence.js.
           ${SHIPSTATION_TRACKING_SQL} AS "ssTracking",
           -- ...and a NetSuite label a human has declared DEAD is not evidence
           -- either: NetSuite has no void button. See labelEvidence.js.
           ${DEAD_LABEL_SQL} AS "deadTracking",
           o.customer, o.source, o.po_number AS "poNumber", o.dc, o.location,
           i.status         AS "invoiceStatus",
           i.amount_total   AS "invoiceTotal",
           i.shipping_status AS "shipGate",
           i.terms          AS "invoiceTerms",
           i.amount_remaining AS "amountRemaining",
           i.due_date       AS "invoiceDueDate",
           c.custody_in     AS "custodyIn",
           c.custody_out    AS "custodyOut",
           dcx.custody_in   AS "dcCustodyIn",
           dcx.custody_out  AS "dcCustodyOut",
           rs.ship_date     AS "routingShipDate"
    FROM fulfillments f
    LEFT JOIN orders   o ON o.so_number = f.so_number
    LEFT JOIN invoices i ON i.inv_number = f.invoice_number
    -- The custody scans are the ONLY honest evidence of when the goods were
    -- physically ready to leave, which is what dates the "mark it shipped"
    -- action (see src/model/shipDateAdvice.js for why DEPARTED and the UPS
    -- label history are both useless for this).
    LEFT JOIN (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS custody_in,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS custody_out
      FROM order_events WHERE doc_type = 'IF' AND event_type IN ('CUSTODY_IN','CUSTODY_OUT')
      GROUP BY doc_number
    ) c ON c.doc_number = f.if_number
    -- An EDI shipment is scanned per PO-DC cargo tag, NEVER per fulfilment, so
    -- its custody evidence lives under doc_type='DC' keyed '<po>:<dc>'. Measured
    -- 2026-08-03: 0 of the 50 shipped EDI IFs carry IF-level custody, while 49
    -- of them sit under a scanned cargo tag.
    LEFT JOIN (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS custody_in,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS custody_out
      FROM order_events WHERE doc_type = 'DC' AND event_type IN ('CUSTODY_IN','CUSTODY_OUT')
      GROUP BY doc_number
    ) dcx ON dcx.doc_number = o.po_number || ':' || COALESCE(o.dc, '')
    -- The authorized pickup date: on the EDI lane THIS is the date to type, not
    -- the packing scan (which precedes the retailer's truck by days of dwell).
    -- LATERAL + LIMIT 1 because a DC can carry several shipments and a plain join
    -- would silently duplicate the fulfilment row.
    LEFT JOIN LATERAL (
      SELECT r.ship_date
      FROM routing_shipment r
      WHERE r.dc = o.dc AND o.po_number = ANY(r.member_pos)
      ORDER BY r.ship_date DESC NULLS LAST, r.id DESC
      LIMIT 1
    ) rs ON TRUE
    -- Packed but not yet shipped. actual_ship_date is the belt-and-suspenders:
    -- anything with a real ship date has already departed.
    WHERE f.actual_ship_date IS NULL
      AND f.status ILIKE 'packed'
    ORDER BY f.if_date NULLS LAST
  `)

  const day = 86_400_000
  const items = rows.map((r) => {
    // Both sources, one answer (src/model/labelEvidence.js). NetSuite first, then
    // whatever ShipStation knows that NetSuite hasn't been told yet.
    const tracking = labelTracking({ nsTracking: r.trackingNumbers, ssTracking: r.ssTracking, deadTracking: r.deadTracking })
    const labelled = tracking.length > 0
    // Has step 2 happened? A labelled parcel with no invoice has NOT reached the
    // ship decision — see src/model/labelGap.js for the 9-of-9 live miss.
    const invoiced = !!r.invoiceNumber
    const ageDays = r.ifDate ? Math.floor((today - new Date(r.ifDate)) / day) : null
    // Which shipping lane is this? EDI partners (Bloomingdale's / Nordstrom /
    // ShopBop) move on LTL FREIGHT under a BOL — they will NEVER carry a UPS
    // parcel tracking number, so listing them as "needs a label" is pure noise
    // (it was 12 of the first 16 hits). Their equivalent gap is a missing BOL,
    // which the routing workspace already owns. Only the parcel lane belongs in
    // the needs-a-label list.
    // Third lane, added 2026-08-04 once Nima explained what FOB Pending Approval
    // actually is: "a shipment that is in china pending a pick up usually
    // confirmed by our china warehouse but that's with someone in our NY office."
    // We never dispatch it, so we never make its label.
    //
    // ⚠️ Keyed on `location`, NOT on the hand-set `shipping_status`. The status
    // field is the same one #47/#49 established can be trusted in ONE direction at
    // most: if it went stale or was never set, keying on it would drop this
    // shipment back into "needs a label" and re-invent the work. Location is the
    // objective signal, and the two agree on every row where both are known
    // (6 of 6; the 4 other FOB invoices carry no order at all — the null-SO
    // strays from the invoice document window).
    const edi = r.source === 'edi'
    const fob = /china/i.test(r.location || '')
    const lane = edi ? 'freight' : fob ? 'fob' : 'parcel'
    // IS PAYMENT HOLDING THIS BACK? (2026-08-04) A label is printed at PACK time,
    // before the payment gate clears, so `labelled` alone said "you forgot to mark
    // this shipped" about goods deliberately sitting here — 2 of 2 live flags were
    // false (IF7409 $2,225.60 owed, IF7413 $158, both Due-on-receipt and past due).
    // Derived from terms + what's owed, NOT from the hand-maintained shipping
    // status — see src/model/paymentGate.js for why that distinction matters.
    const gate = { terms: r.invoiceTerms, amountRemaining: r.amountRemaining, shipGate: r.shipGate }
    const heldForPayment = paymentBlocked(gate)
    return {
      ...r,
      trackingNumbers: tracking,
      lane,
      heldForPayment,
      paymentCleared: heldForPayment ? null : clearedReason(gate),
      // A payment-held IF is step 5's business (the ship gate), not step 6's
      // (mark shipped on the real date). Given its own kind rather than being
      // filtered away: if something ever DOES ship while payment is blocking,
      // that's a real exception and a silent filter would bury it.
      //
      // ⚠️ THE ORDER OF THE TESTS IS THE WHOLE FIX, and it now lives in
      // src/model/labelGap.js where it can be tested (Nima, 2026-08-04): "a label
      // is created, the next step is the creation of an invoice, and then after we
      // need to know if we can ship it." The document step comes BEFORE the payment
      // question, so an unlabelled parcel needs its label whether or not money is
      // owed. While `heldForPayment` was tested first it swallowed exactly that:
      // IF7414 ($90,654 owed, 6 days, the board's oldest item) and IF7412 ($3,140)
      // had ZERO labels and still read as "correctly parked".
      kind: labelGapKind({ labelled, lane, heldForPayment, invoiced }),
      ageDays,
      // WHICH DATE to type when marking it shipped (Nima's step 6).
      //
      // A PARCEL IF with no label hasn't gone anywhere, so dating its departure
      // would be fiction — those still get nothing. But FREIGHT never carries a
      // parcel label at all, so gating on `labelled` silently excluded the entire
      // EDI lane from step 6; that, as much as the missing per-IF custody, is why
      // no EDI fulfilment has ever been given a ship date to use.
      advice: labelled || lane === 'freight'
        ? shipDateAdvice({
          ifNumber: r.ifNumber, ifDate: r.ifDate, edi,
          custodyIn: r.custodyIn, custodyOut: r.custodyOut,
          dcCustodyIn: r.dcCustodyIn, dcCustodyOut: r.dcCustodyOut,
          routingShipDate: r.routingShipDate,
        }, { today })
        : null,
      // A labelled-but-unshipped IF is the more urgent of the two: the customer
      // already has the package while our books say it never left.
      // Derived from the same classifier as `kind`, so the sentence on the row and
      // the chip that counts it can never disagree.
      needed: labelGapNeeded({
        labelled, lane, heldForPayment, invoiced, ifNumber: r.ifNumber,
        invoiceNumber: r.invoiceNumber, invoiceTerms: r.invoiceTerms,
        amountRemaining: r.amountRemaining, labelCount: tracking.length,
      }),
    }
  })

  // Ranked by month-close, not by age: a shipment two days adrift ACROSS the
  // close costs a re-dated month, while nine days adrift inside one costs
  // nothing but tidiness. Age still decides ties, via the advice's drift.
  const labelledNotShipped = rankShipDateAdvice(items.filter((i) => i.kind === 'LABELLED_NOT_SHIPPED'))
  const needsLabel = items.filter((i) => i.kind === 'NEEDS_LABEL')
  // Ranked on the same month-close rule now that freight carries advice, so an
  // EDI shipment about to be booked into the wrong month sorts to the top of its
  // own list rather than sitting in fulfilment-date order.
  const freight = rankShipDateAdvice(items.filter((i) => i.kind === 'FREIGHT_BOL_LANE'))
  // The China/FOB pickup lane. Its own list for the same reason freight has one:
  // the action is a confirmation with the China warehouse and the NY office, not
  // anything anyone in this warehouse can do, so it must never be added to a
  // parcel number. Age still matters — this is where the largest balance on the
  // board sits (IF7414, $90,654).
  const fobPickup = items.filter((i) => i.kind === 'FOB_PICKUP')
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
  // Labelled, waiting on its invoice. Its own list so it can never be confused with
  // a shipment that actually left (9 of 9 were, on 2026-08-05).
  const needsInvoice = items.filter((i) => i.kind === 'NEEDS_INVOICE')
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
  // Correctly parked, not work: money is owed and due, so these must NOT move.
  // Surfaced so the count is visible (and so a shipped-anyway exception can't
  // hide), but never added to any actionable number — the never-lump rule.
  //
  // Since 2026-08-04 this is only ever a LABELLED shipment. A payment-held IF with
  // no label still appears under needsLabel, because the label precedes the
  // invoice in Nima's flow — so `heldForPayment` now means precisely "the package
  // is ready and the money is what's left", never "nothing to do here".
  const heldForPayment = items.filter((i) => i.kind === 'HELD_FOR_PAYMENT')
  return {
    items,
    labelledNotShipped,
    needsLabel,
    freight, // kept separate so the parcel lists stay actionable, not buried
    fobPickup,
    needsInvoiceLabelled: needsInvoice,
    heldForPayment,
    counts: {
      labelledNotShipped: labelledNotShipped.length,
      needsLabel: needsLabel.length,
      freight: freight.length,
      fobPickup: fobPickup.length,
      needsInvoiceLabelled: needsInvoice.length,
      heldForPayment: heldForPayment.length,
      // The expensive subset: marking these today books them in the wrong month.
      monthClose: monthCloseCount(labelledNotShipped),
      // Deliberately a SEPARATE number, never added to the one above (the
      // never-lump rule): a parcel shipment needs marking shipped, a freight one
      // needs its BOL date honoured. Same cost, different action.
      freightMonthClose: monthCloseCount(freight),
    },
    // Age the ACTIONABLE items only — a freight shipment awaiting its BOL
    // shouldn't inflate the parcel backlog's headline number.
    oldestAgeDays: [...labelledNotShipped, ...needsLabel].reduce((m, i) => Math.max(m, i.ageDays ?? 0), 0),
    // The retro half of step 6, deliberately kept OUT of every count above and
    // out of the court strip entirely. See getShipDateAudit.
    retro: await getShipDateAudit({ today }),
    // The exception HELD_FOR_PAYMENT's own comment promises cannot hide — and
    // which, until now, structurally could. See getShippedWhileOwing.
    shippedWhileOwing: await getShippedWhileOwing({ today }),
  }
}

// Goods that LEFT while payment was blocking them.
//
// ⚠️ THIS LIST EXISTS BECAUSE THE CODE ABOVE CLAIMED IT ALREADY DID. The
// HELD_FOR_PAYMENT branch is documented as "if something ever DOES ship while
// payment is blocking, that's a real exception and a silent filter would bury
// it" — but getLabelGaps' WHERE clause is `actual_ship_date IS NULL AND status
// = packed`, so a shipment that departed anyway leaves the query's scope
// entirely and no filter, silent or otherwise, was ever involved. A comment
// promising a safety net is not a safety net (found 2026-08-04).
//
// ⚠️ WORDED AS "STILL OWES", NOT "SHIPPED BEFORE PAYING". `amount_remaining` is
// the balance RIGHT NOW; we hold no history of what was owed on the day it left,
// so the honest claim is about today's balance on something already gone. Live
// today: 1 row — IF7263, shipped 2026-07-14, $6,887 still open on INV11335,
// which had been due since 2026-07-02.
export async function getShippedWhileOwing({ today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT f.if_number   AS "ifNumber",
           f.so_number   AS "soNumber",
           f.actual_ship_date AS "shippedOn",
           i.inv_number  AS "invoiceNumber",
           i.terms       AS "invoiceTerms",
           i.amount_remaining AS "amountRemaining",
           i.due_date    AS "invoiceDueDate",
           i.status      AS "invoiceStatus",
           i.shipping_status AS "shipGate",
           COALESCE(o.customer, i.bill_to) AS customer,
           o.source
    FROM fulfillments f
    JOIN invoices i ON i.inv_number = f.invoice_number
    LEFT JOIN orders o ON o.so_number = f.so_number
    WHERE f.actual_ship_date IS NOT NULL
      AND i.amount_remaining > 0
    ORDER BY f.actual_ship_date DESC
  `)

  const day = 86_400_000
  // Same derived gate as the packed list, so the two lists agree about what
  // "payment is blocking" means — net terms and paid-in-full never appear here,
  // exactly as they never hold a packed shipment back. That now includes the NY
  // waiver: a shipment the office approved to leave with a balance still open was
  // AUTHORIZED, so listing it as an exception would accuse someone of a decision
  // they were instructed to make. (Live: the 1 row here carries `Shipped`, not the
  // approval, so it is unaffected.)
  const items = rows
    .filter((r) => paymentBlocked({ terms: r.invoiceTerms, amountRemaining: r.amountRemaining, shipGate: r.shipGate }))
    .map((r) => ({
      ...r,
      amountRemaining: Number(r.amountRemaining),
      daysSinceShipped: r.shippedOn ? Math.floor((today - new Date(r.shippedOn)) / day) : null,
      // Was it already past due when it left? That's the closest we can honestly
      // get to "shipped against the rule" without a balance history: a due date
      // BEFORE the ship date means money was owed and due while it was going out.
      dueBeforeShipped: r.invoiceDueDate && r.shippedOn
        ? new Date(r.invoiceDueDate) < new Date(r.shippedOn)
        : null,
    }))

  return {
    items,
    counts: {
      total: items.length,
      dueBeforeShipped: items.filter((i) => i.dueBeforeShipped === true).length,
    },
    amount: items.reduce((n, i) => n + i.amountRemaining, 0),
  }
}

// Step 6, looking backwards: shipments already marked, audited against the same
// custody/routing evidence the forward list uses.
//
// The ONLY difference from getLabelGaps' query is the WHERE clause — same joins,
// same evidence chain — because the whole point is that the two lists agree about
// what counts as proof. What differs is the ACTION they imply, which is why they
// are separate lists and separate numbers (src/model/shipDateAdvice.js).
//
// `markedDate` is the fulfilment's own actual_ship_date, so shipDateAdvice audits
// the date that was used rather than measuring against today.
export async function getShipDateAudit({ today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT f.if_number        AS "ifNumber",
           f.so_number        AS "soNumber",
           f.if_date          AS "ifDate",
           f.actual_ship_date AS "markedDate",
           o.customer, o.source, o.po_number AS "poNumber", o.dc,
           c.custody_in     AS "custodyIn",
           c.custody_out    AS "custodyOut",
           dcx.custody_in   AS "dcCustodyIn",
           dcx.custody_out  AS "dcCustodyOut",
           rs.ship_date     AS "routingShipDate"
    FROM fulfillments f
    LEFT JOIN orders o ON o.so_number = f.so_number
    LEFT JOIN (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS custody_in,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS custody_out
      FROM order_events WHERE doc_type = 'IF' AND event_type IN ('CUSTODY_IN','CUSTODY_OUT')
      GROUP BY doc_number
    ) c ON c.doc_number = f.if_number
    LEFT JOIN (
      SELECT doc_number,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS custody_in,
             MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS custody_out
      FROM order_events WHERE doc_type = 'DC' AND event_type IN ('CUSTODY_IN','CUSTODY_OUT')
      GROUP BY doc_number
    ) dcx ON dcx.doc_number = o.po_number || ':' || COALESCE(o.dc, '')
    -- LATERAL + LIMIT 1: a DC can carry several routing shipments and a plain
    -- join would silently duplicate the fulfilment row.
    LEFT JOIN LATERAL (
      SELECT r.ship_date
      FROM routing_shipment r
      WHERE r.dc = o.dc AND o.po_number = ANY(r.member_pos)
      ORDER BY r.ship_date DESC NULLS LAST, r.id DESC
      LIMIT 1
    ) rs ON TRUE
    WHERE f.actual_ship_date IS NOT NULL
    ORDER BY f.actual_ship_date DESC
  `)

  // The earliest custody scan on record. Everything that shipped before it is
  // uncheckable by anyone, ever — as opposed to a shipment that left AFTER
  // scanning existed and still has no scan, which is a live gap. Read rather
  // than hard-coded: a constant would go quietly wrong the day the ledger is
  // rebuilt or backfilled.
  const { rows: [epoch] } = await pool.query(`
    SELECT MIN(occurred_at) AS first
    FROM order_events WHERE event_type IN ('CUSTODY_IN','CUSTODY_OUT')
  `)

  return auditMarkedShipments(
    rows.map((r) => ({ ...r, edi: r.source === 'edi' })),
    { today, custodyEpoch: epoch?.first || null },
  )
}

export async function setShipmentRefs(id, fields = {}) {
  await updateShipmentRefs(id, fields)
  // The Bloomingdale's authorization comes from the routing email and is typed
  // straight onto the shipment. If it's a number we haven't seen, register it as
  // a routing_auth (partner from the shipment, carrier/SCAC from what's being
  // saved) so it's a first-class auth — reusable on other DCs and eligible for a
  // Master BOL. COALESCE in the upsert means this never clobbers existing data.
  if (fields.authNumber && String(fields.authNumber).trim()) {
    const s = await fetchRoutingShipmentById(id)
    await upsertRoutingAuth({
      authNumber: String(fields.authNumber).trim(),
      partner: s?.partner || null,
      carrier: fields.carrier || s?.carrier || null,
      scac: fields.scac || s?.scac || null,
    })
  }
  return getRouting()
}

/**
 * Accept a tender: write its pickup date and carrier onto every routing shipment it
 * covers, in one press.
 *
 * ⚠️ This is the ONE place a tender writes to routing_shipment, and it exists because a
 * click is not a cron. `annotateTenders` and `check:tenders` only ever report the
 * disagreement, precisely so a background sync can never quietly rewrite a field Nima
 * typed. Pressing a button that says "the tender says Monday" is him deciding.
 *
 * A hand-entered SRR is still never overwritten, even here — see planTenderApply.
 */
export async function applyTender(tenderShipmentId) {
  const [tenders, shipments] = await Promise.all([loadTenders({ limit: 50 }), loadRoutingShipments()])
  const tender = tenders.find((t) => t.shipmentId === tenderShipmentId)
  if (!tender) throw new Error(`tender ${tenderShipmentId} not found — run \`npm run sync:tenders\``)

  const plan = planTenderApply(tender, shipments)
  if (plan.outOfScope) throw new Error(`tender ${tenderShipmentId} matches no current routing shipment`)

  for (const e of plan.edits) {
    if (Object.keys(e.set).length) await updateShipmentRefs(e.shipmentId, e.set)
  }
  return {
    applied: plan.edits.filter((e) => Object.keys(e.set).length).length,
    changes: plan.changes,
    conflicts: plan.conflicts,
    pickupDate: plan.pickupDate,
    carrier: plan.carrier,
    routing: await getRouting(),
  }
}

// ── Dead NetSuite labels ─────────────────────────────────────────────────────
// The void button NetSuite lacks, operated by hand. Nothing here infers a death.
export async function recordDeadLabel(body = {}) {
  return markLabelDead(body)
}
export async function undoDeadLabel(body = {}) {
  return reviveLabel(body)
}
export async function listDeadLabels() {
  return fetchDeadLabels()
}

export async function saveRoutingAuth(body = {}) {
  if (!body.authNumber?.trim()) throw new Error('authNumber is required')
  await upsertRoutingAuth({ ...body, authNumber: body.authNumber.trim() })
  if (Array.isArray(body.shipmentIds) && body.shipmentIds.length) {
    await assignAuthToShipments({ authNumber: body.authNumber.trim(), shipmentIds: body.shipmentIds, shipDate: body.shipDate || null })
  }
  return getRouting()
}

export async function removeRoutingAuth(authNumber) {
  await deleteRoutingAuth(authNumber)
  return getRouting()
}

// Phase 3 — VICS BOL PDF + Drive filing
// Enrich a shipment with per-PO line items (cartons/weight) for the BOL's
// Customer Order Information table, pulled from the package feed for this DC.
async function withLineItems(shipment) {
  if (!shipment) return shipment
  const pkgs = await fetchEdiPackages()
  const lineItems = (shipment.memberPos || []).map((po) => {
    const row = pkgs.find((p) => String(p.poNumber) === String(po) && String(p.dc) === String(shipment.dc))
    return { po, cartons: row?.cartons ?? '', weight: row ? Math.ceil(Number(row.weight) || 0) : '' }
  })
  // Totals track the LIVE feed, not the snapshot frozen when the BOL was
  // assigned: a re-imported EDIPackagesVolume can correct the numbers (e.g. SC
  // 19→18), and the child BOL must print the truth — exactly as the Master BOL
  // already recomputes from the current feed. Re-run the SAME consolidation the
  // Routing view uses so the two always agree; stored refs (BOL#/carrier/auth/
  // dates/pallets) are untouched. Fall back to the snapshot only if the DC has
  // vanished from the feed entirely.
  const rows = pkgs.filter(
    (p) => String(p.dc) === String(shipment.dc) && (shipment.memberPos || []).map(String).includes(String(p.poNumber)),
  )
  const [g] = consolidateRouting(rows)
  const totals = g
    ? { cartons: g.cartons, units: g.units, weightLb: g.weightLb, cubicFeet: g.cubicFeet }
    : {}
  return { ...shipment, ...totals, lineItems }
}

export async function streamShipmentBol(res, id) {
  const shipment = await withLineItems(await fetchRoutingShipmentById(id))
  if (!shipment) throw new Error('shipment not found')
  await renderBolTo(res, shipment)
}

export async function fileShipmentToDrive(id) {
  const shipment = await withLineItems(await fetchRoutingShipmentById(id))
  if (!shipment) throw new Error('shipment not found')
  const buffer = await buildBolPdf(shipment)
  const filename = `BOL_${shipment.bolNumber || 'draft'}_${shipment.dc}.pdf`
  return uploadBolPdf({
    partner: shipment.partner, pos: shipment.memberPos || [], filename, buffer,
  })
}

// ── Retro QR tags, by ship date ─────────────────────────────────────────────
//
// Nima, 2026-08-14: fulfilments printed before the packing-slip QR landed have no
// code on the paper, so they cannot be scanned in. Rather than reprint the slips, the
// same cargo tag we already print for EDI carries a QR encoding the IF — so a sticker
// on the existing page is enough.
//
// Batched BY SHIP DATE because that is how the paperwork is filed: printing a day's
// tags is simultaneously the scan codes AND the finding aid for that day's pile.
//
// ⚠️ TWO DIFFERENT QUESTIONS, and conflating them cost a round trip. We do NOT know
// which printed slips carry a QR — nothing records it, and the slip is printed by
// NetSuite, not by us. But that is not what matters. What matters is whether the
// fulfilment has ALREADY BEEN SCANNED, and that we do record: a Scan Bay scan writes
// an `order_events` row with source 'scan'. A tag for something already scanned is
// waste, so those are excluded by default.
//
// Nima: "we wont need anything that has been scanned already and my assumption was
// that it was recorded somewhere when the scan happens" — it is; I had read his
// earlier question as being about the printed slip.
//
// `includeScanned` brings them back, because a tag can be lost or a page re-filed,
// and BOTH counts are always returned so the panel can say "38 of 50 need one"
// rather than silently showing a shorter list.
export async function getTagSheet({ shipped = null, from = null, to = null, includeScanned = false } = {}) {
  if (!shipped && !from) throw new Error('a ship date is required')
  const { rows } = await pool.query(
    `SELECT f.if_number AS "ifNumber", f.so_number AS "soNumber",
            o.customer, o.po_number AS "poNumber", o.source,
            to_char(f.actual_ship_date, 'YYYY-MM-DD') AS "shippedOn",
            (SELECT COUNT(*) FROM edi_carton c WHERE c.if_number = f.if_number)::int AS cartons,
            EXISTS (SELECT 1 FROM order_events e
                     WHERE e.source = 'scan' AND e.doc_number = f.if_number) AS scanned
       FROM fulfillments f
       LEFT JOIN orders o ON o.so_number = f.so_number
      WHERE f.status = 'Shipped' AND f.actual_ship_date IS NOT NULL
        AND ($1::date IS NULL OR f.actual_ship_date::date = $1::date)
        AND ($2::date IS NULL OR f.actual_ship_date::date >= $2::date)
        AND ($3::date IS NULL OR f.actual_ship_date::date <= $3::date)
      ORDER BY f.if_number`,
    [shipped, from, to || from],
  )
  const all = rows.map((r) => ({
    ...r,
    // EDI tags reference the customer PO, boutique ones the SO — the same rule the
    // single-tag path uses, so a retro tag is indistinguishable from a fresh one.
    refByPo: r.source === 'edi',
  }))
  const alreadyScanned = all.filter((r) => r.scanned).length
  const items = includeScanned ? all : all.filter((r) => !r.scanned)
  return {
    items,
    count: items.length,
    shippedThatDay: all.length,
    alreadyScanned,
    includeScanned,
    shipped: shipped || null, from: from || null, to: to || null,
    // Still true and still worth saying: a fulfilment that has never been scanned may
    // ALREADY have a QR on its slip. This filters on scans, not on paper.
    qrKnown: false,
  }
}

/** Which ship dates have fulfilments, so the UI can offer real days not a blank box. */
export async function getShipDays({ limit = 60 } = {}) {
  const { rows } = await pool.query(
    `SELECT to_char(actual_ship_date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM fulfillments WHERE status = 'Shipped' AND actual_ship_date IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT $1`, [limit])
  return rows
}

// ── Master BOL (multi-DC via 1:1 Merge Center) ───────────────────────────────
// Aggregate every underlying shipment on an authorization into one Master BOL:
// union of POs (each PO's cartons/weight summed across its DCs), summed totals,
// ship-to the merge center. Mints the Master BOL number (once) on the auth.
async function buildMasterShipment(authNumber) {
  const auths = await fetchRoutingAuths()
  const auth = auths.find((a) => a.authNumber === authNumber)
  if (!auth) throw new Error('auth not found')
  const all = await fetchRoutingShipments()
  const members = all.filter((s) => s.authNumber === authNumber)
  if (!members.length) throw new Error('no shipments are assigned this authorization yet')

  const packages = await fetchEdiPackages()
  const perPo = new Map()
  let cartons = 0, units = 0, weight = 0, cubic = 0
  for (const s of members) {
    for (const po of (s.memberPos || [])) {
      const row = packages.find((p) => String(p.poNumber) === String(po) && String(p.dc) === String(s.dc))
      const c = row?.cartons || 0, w = Math.ceil(Number(row?.weight) || 0), u = row?.units || 0
      const cur = perPo.get(po) || { po, cartons: 0, weight: 0 }
      cur.cartons += c; cur.weight += w
      perPo.set(po, cur)
      cartons += c; units += u; weight += w
    }
    cubic += Number(s.cubicFeet) || 0
  }
  const bolNumber = await ensureMasterBol(authNumber)
  return {
    kind: 'master', isMaster: true, partner: auth.partner || members[0].partner,
    dc: 'MERGE', mergeCenter: auth.mergeCenter || members[0].mergeCenter || 'CA',
    bolNumber, authNumber, carrier: auth.carrier, scac: auth.scac,
    // Master ship date + FedEx pickup number (Nima, 2026-07-27) — printed on the
    // master BOL. Fall back to a member's ship date if the auth has none set.
    shipDate: auth.shipDate || members.find((m) => m.shipDate)?.shipDate || null,
    fedexPickupNumber: auth.fedexPickupNumber || null,
    // Manually-assigned pallet count (Nima, 2026-07-28) — the real number isn't
    // known until the shipment is physically built, so the master BOL uses this
    // instead of an estimate, and adds PALLET_LB per pallet to the freight weight.
    palletCount: auth.palletCount ?? null,
    memberPos: [...perPo.keys()], lineItems: [...perPo.values()],
    cartons, units, weightLb: weight, cubicFeet: cubic,
  }
}

export async function streamMasterBol(res, authNumber) {
  const master = await buildMasterShipment(authNumber)
  await renderBolTo(res, master, { kind: 'master' })
}

export async function fileMasterToDrive(authNumber) {
  const master = await buildMasterShipment(authNumber)
  const buffer = await buildBolPdf(master, { kind: 'master' })
  const filename = `MASTER_BOL_${master.bolNumber}.pdf`
  return uploadBolPdf({ partner: master.partner, pos: master.memberPos, filename, buffer })
}

export async function assignRoutingBol(body = {}) {
  const { partner, dc, memberPos, cartons, units, weightLb, cubicFeet } = body
  if (!partner || !dc) throw new Error('partner and dc are required')
  if (!Array.isArray(memberPos) || !memberPos.length) throw new Error('memberPos is required')
  // ⚠️ REFUSE AT THE WRITE, not just in the UI. BOL NB1731262 was minted for a
  // ShopBop PO (POJ00384244) and stored under partner "Bloomingdale's" — the
  // partner label came from partnerForDc, which resolves any non-numeric DC to
  // Bloomingdale's, and ShopBop's DC is SBX2. Hiding the button would not have
  // stopped it: the row already existed. So the rule lives where the number is
  // handed out. See src/model/parcelLane.js.
  //
  // The PO is what identifies the partner here — `partner` is the caller's own
  // (possibly wrong) label, which is exactly what went wrong the first time.
  const guard = await parcelLaneBlock(memberPos, partner)
  if (guard) throw new Error(guard)
  await assignBol({ partner, dc, memberPos, cartons, units, weightLb, cubicFeet })
  return getRouting()
}

// Look the POs up in `orders` and refuse if any belongs to a parcel-lane partner.
// Checked against the DATA rather than the passed-in partner string, because the
// mislabel is the bug: NB1731262 called a ShopBop shipment Bloomingdale's.
async function parcelLaneBlock(memberPos, partnerLabel) {
  const { rows } = await pool.query(
    `SELECT DISTINCT customer, location FROM orders WHERE po_number = ANY($1)`,
    [memberPos.map(String)],
  )
  const hit = rows.find((r) => isParcelLane(r))
  if (hit) return noBolReason(hit)
  // No rows means we cannot vouch for the POs at all; fall back to the label so a
  // ShopBop shipment whose orders haven't synced yet still can't slip through.
  if (!rows.length && isParcelLane({ customer: partnerLabel })) {
    return noBolReason({ customer: partnerLabel })
  }
  return null
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
  // A genuinely-new 850 with no NetSuite SO yet would otherwise surface nowhere
  // — ensureEdiTasks only auto-materializes SO-backed POs. Record the new
  // arrivals FIRST (banner + a durable task) so the no-SO case can't sit
  // ignored (best-effort; must not fail the sync).
  let arrivals = { newArrivals: 0 }
  try { arrivals = await recordEdiArrivals(r.insertedIds || []) }
  catch (e) { console.error('New-850 arrival detection failed:', e.message) }
  // Fresh Orderful data can shift what's open — refresh the auto-generated
  // tasks right after (best-effort; a failure here mustn't fail the sync).
  try { await ensureEdiTasks() } catch (e) { console.error('EDI task generation after sync failed:', e.message) }
  return { ...r, ...arrivals }
}

// Turn the just-inserted transaction ids into new-850 arrival alerts. Filters
// to LIVE 850s (a TEST 850 must not read as a real new PO — same rule
// fetchEdiTransactions uses), records each in edi_arrivals (idempotent), and
// creates a durable quest_task under the shared edi:<bn> instance_key so it
// collapses with any auto/manual EDI task for the same PO. Ordinarily called
// from syncEdi; the id list is the dedupe, so passing an empty array is a no-op.
export async function recordEdiArrivals(insertedIds = []) {
  if (!insertedIds.length) return { newArrivals: 0 }
  const { rows } = await pool.query(
    `SELECT id, business_number AS "businessNumber", trading_partner AS "tradingPartner", created_at AS "createdAt"
     FROM edi_transactions
     WHERE id = ANY($1) AND type = '850_PURCHASE_ORDER' AND stream = 'LIVE'`,
    [insertedIds],
  )
  let newArrivals = 0
  let rechecks = 0
  for (const t of rows) {
    const partner = (t.tradingPartner || 'EDI').trim()
    if (!t.businessNumber) continue

    // Is this a genuinely-new PO, or a RE-SEND of one we already have? Every 850
    // for this PO#, oldest→newest, with the parsed line items the diff needs
    // (backfillPo850Details ran earlier this sync, so the new one is parsed).
    const { rows: v } = await pool.query(
      `SELECT id, created_at AS "createdAt", ship_not_before AS "shipNotBefore",
              cancel_after AS "cancelAfter", line_items AS "lineItems"
       FROM edi_transactions
       WHERE business_number = $1 AND type = '850_PURCHASE_ORDER' AND stream = 'LIVE'
       ORDER BY created_at ASC`,
      [t.businessNumber],
    )
    const idx = v.findIndex((x) => x.id === t.id)
    const prior = idx > 0 ? v[idx - 1] : null

    if (!prior) {
      // ── genuinely new PO ── banner arrival + a durable "enter it" task.
      const ins = await pool.query(
        `INSERT INTO edi_arrivals (transaction_id, business_number, trading_partner, po_created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
        [t.id, t.businessNumber, t.tradingPartner, t.createdAt],
      )
      if (!ins.rows.length) continue
      newArrivals++
      const id = await createEdiTask({
        businessNumber: t.businessNumber,
        characterId: ediTaskCharacter(t.businessNumber),
        fromName: partner,
        subject: `🆕 New PO ${t.businessNumber} · ${partner}`,
        snippet: `New 850 arrived from ${partner} — enter PO ${t.businessNumber} into NetSuite.`,
        urgency: 'hi',
      })
      if (id) await logTaskActivity({ taskId: id, kind: 'created', note: `New 850 arrival · ${partner} PO ${t.businessNumber}` })
      continue
    }

    // ── a re-send ── only worth surfacing if something actually CHANGED (a
    // routine re-transmit is noise). No new-PO banner here — the banner means
    // "enter this into NetSuite"; a re-send re-raises the PO's own task instead.
    const diff = diffPoVersions(prior, t)
    if (!diff.changed) continue
    const summary = summarizePoDiff(diff)
    // If the user already parked/validated/closed it, frame it as a re-check.
    const { rows: [res] } = await pool.query(
      `SELECT review_state AS "reviewState", closed, cancelled FROM edi_po_resolutions WHERE business_number = $1`,
      [t.businessNumber],
    )
    const acted = res && (res.reviewState || res.closed || res.cancelled)
    const verb = acted ? 'Re-check' : 'Changed re-send'
    const raised = await raiseEdiTask({
      businessNumber: t.businessNumber,
      characterId: ediTaskCharacter(t.businessNumber),
      fromName: partner,
      subject: `⟳ ${verb} — PO ${t.businessNumber} · ${partner} (sent ${idx + 1}×)`,
      snippet: `${partner} re-sent PO ${t.businessNumber} with changes: ${summary.join('; ')}.` +
        (res?.reviewState === 'unallocated' ? ' Re-check whether it can now be allocated + entered.' :
         acted ? ' Re-check — it changed since you handled it.' : ''),
      urgency: 'hi',
    })
    if (raised) {
      rechecks++
      await logTaskActivity({ taskId: raised.id, kind: raised.reopened ? 'reopened' : 'created', note: `850 re-send · ${partner} PO ${t.businessNumber} · ${summary.join('; ')}` })
    }
  }
  return { newArrivals, rechecks }
}

// Undismissed new-850 arrivals, newest PO first — drives the app-wide banner.
export async function getEdiArrivals() {
  const { rows } = await pool.query(
    `SELECT transaction_id AS "transactionId", business_number AS "businessNumber",
            trading_partner AS "tradingPartner", po_created_at AS "poCreatedAt", detected_at AS "detectedAt"
     FROM edi_arrivals WHERE dismissed = false
     ORDER BY po_created_at DESC NULLS LAST, detected_at DESC`,
  )
  return rows
}

// Dismiss the banner (one arrival or all). Deliberately does NOT close the
// task — the PO still needs handling; this just clears the "since you last
// looked" heads-up.
export async function dismissEdiArrivals(transactionId) {
  if (transactionId) {
    await pool.query(`UPDATE edi_arrivals SET dismissed = true WHERE transaction_id = $1`, [transactionId])
  } else {
    await pool.query(`UPDATE edi_arrivals SET dismissed = true WHERE dismissed = false`)
  }
  return { ok: true }
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
  // Gmail write returns the message's updated label id set — persist it locally
  // so the chip shows on this response, not only after the next full sync.
  const { labelIds } = await applyLabel(id, label)
  try { await setQuestEmailLabelsLocal(id, labelIds) } catch { /* next sync reconciles */ }
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
// Urgency is DERIVED here rather than read off the row (Nima, 2026-08-05: "if the
// app can learn and set urgency with a manual overrid it be best"). The hand-set
// value survives as `urgencyOverride` and wins when present; `urgencyBasis` says
// WHY, so an urgency nobody can explain never drives the day.
//
// Everything downstream reads `t.urgency`, so the day plan's ordering
// (urgencyPriority / urgencyDeadline in src/model/routeItems.js) picks this up with
// no change of its own.
// ⚠️ `severityByDoc` is what makes 'hi' REACHABLE. Without it, hi can only come
// from a real due_at — and 0 of 34 open tasks have one, so hi would be structurally
// impossible and the scale would silently collapse to mid/lo. That is the
// unreachable-branch shape this repo keeps producing, so the caller that already
// holds order severities passes them in and getQuestTasks resolves them here.
export async function getQuestTasks({ now = Date.now(), severityByDoc = null } = {}) {
  await ensureRecurringTasks()
  const tasks = await fetchQuestTasks()
  // Default: derive severities for linked sales orders ourselves, so the API path
  // gets a working hi tier without every caller having to remember.
  const sev = severityByDoc || (await linkedDocSeverities(tasks, now))
  return tasks.map((t) => {
    const u = deriveTaskUrgency(t, { now, linkedSeverity: sev.get(t.netsuiteDocNumber) })
    return {
      ...t,
      character: getCharacterById(t.characterId),
      urgency: u.level,
      urgencyBasis: u.basis,
      urgencyDerived: u.derived,
      urgencyOverride: u.override,
    }
  })
}

// The severity of each NetSuite doc a task hangs off, so an urgent order makes its
// task urgent. Reuses computeFlags — the app's ONE definition of severity — rather
// than re-deriving "is this order in trouble" in SQL, which would drift the moment
// the flag rules changed.
async function linkedDocSeverities(tasks, now) {
  const docs = [...new Set(tasks.map((t) => t.netsuiteDocNumber).filter(Boolean))]
  if (!docs.length) return new Map()
  const today = new Date(now)
  // Only the linked docs, so this never scans the order table.
  const { rows } = await pool.query(
    `SELECT o.*,
            COALESCE((SELECT json_agg(json_build_object(
              'ifNumber', f.if_number, 'status', f.status, 'packedStatus', f.packed_status,
              'invoice', f.invoice_number, 'actualShipDate', f.actual_ship_date, 'ifDate', f.if_date))
              FROM fulfillments f WHERE f.so_number = o.so_number), '[]'::json) AS fulfillments,
            '[]'::json AS invoices
     FROM orders o WHERE o.so_number = ANY($1)`, [docs])
  const map = new Map()
  for (const r of rows) {
    const o = {
      soNumber: r.so_number, customer: r.customer, location: r.location, source: r.source,
      stage: r.stage, shippingStatus: r.shipping_status, shipDate: r.ship_date,
      cancelDate: r.cancel_date, daysPending: r.days_pending, soStatus: r.so_status,
      qtyOrdered: Number(r.qty_ordered), qtyFulfilled: Number(r.qty_fulfilled),
      isAts: r.is_ats, fulfillments: r.fulfillments, invoices: [], ediWindow: null,
    }
    const flags = computeFlags(o, today)
    map.set(r.so_number, flags.reduce((m, f) => Math.max(m, f.severity), 0))
  }
  return map
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

// Daily Flight Plan: set a task's real due time and/or estimated duration.
export async function setTaskSchedule(id, { dueAt, durationMin }) {
  await updateTaskSchedule(id, { dueAt, durationMin })
  const bits = []
  if (dueAt !== undefined) bits.push(dueAt ? `due ${new Date(dueAt).toLocaleString()}` : 'due time cleared')
  if (durationMin !== undefined) bits.push(durationMin ? `${durationMin}m estimate` : 'duration cleared')
  await logTaskActivity({ taskId: id, kind: 'scheduled', note: `Plan: ${bits.join(', ') || 'updated'}` })
  return getQuestTasks()
}

// ── Daily Flight Plan persistence (Nima, 2026-07-28) ─────────────────────────
// The plan is recomputed client-side each load from live orders/tasks/EDI; the
// server only stores the day's manual order + non-task check-offs. Date is a
// 'YYYY-MM-DD' string (the client's local day).
export async function getDayPlan(date) {
  return fetchDayPlan(date)
}
export async function reorderDayPlan(date, orderedIds) {
  await setDayPlanOrder(date, orderedIds)
  return fetchDayPlan(date)
}
export async function resetDayPlan(date) {
  await resetDayPlanOrder(date)
  return fetchDayPlan(date)
}
export async function setPlanItemDone(date, itemId, done, label) {
  await setDayPlanItemDone(date, itemId, done, label)
  return fetchDayPlan(date)
}

export async function getTaskActivity(date) {
  return fetchTaskActivity(date ? { date } : {})
}

export { NETSUITE_DOC_TYPES }

// ── Did the document actually reach the partner? (Nima, 2026-08-01) ──────────
// See src/model/ediDelivery.js. Reads the synced Orderful transactions and splits
// the two silent failures — never delivered vs delivered-and-refused — keeping
// ASNs apart from invoices.
export async function getEdiDeliveryGaps() {
  const txns = await fetchEdiTransactions()
  return computeEdiDeliveryGaps(txns)
}

// ── What will the big box cost on the WHOLESALE UPS account? (Nima, 2026-08-02) ──
//
// Nima's ask: "if we can get the rate for the big boxes in ShipStation or anywhere
// it would be great." Two sources are combined here, and they are never blended:
//
//   1. A LIVE quote on C6J610, the wholesale account. This is the number he wants,
//      and it is unavailable until he reconnects that carrier in ShipStation —
//      /v2/rates against it answers "the connection appears to be invalid". The
//      code path is complete and switches on by itself the moment it's fixed.
//   2. What C6J610 was ACTUALLY BILLED for comparable boxes, harvested from the
//      years of labels bought on it through ShipStation (npm run sync:ups-costs).
//      Real invoiced wholesale money, available today, with the caveat that older
//      actuals predate UPS's annual increases.
//
// A live 18GE01 quote is also fetched, but ONLY as a cross-check — it is the ecom
// account, and boutique freight bills to C6J610 (the tracking numbers prove it),
// so wholesaleFigure() refuses to substitute it. See src/model/upsRates.js.
export async function getUpsRate({ ifNumber, destination, serviceCode = 'ups_ground', residential = false } = {}) {
  const { fetchFulfillmentBoxes } = await import('../src/ingest/loadToDb.js')
  const { fetchActuals } = await import('../src/ingest/shipstationCosts.js')
  const { quoteAccount } = await import('../src/ingest/shipstationRates.js')
  const { WHOLESALE_ACCOUNT, quoteFromActuals, rateAnswerForBox, liveFigure } = await import('../src/model/upsRates.js')

  const boxes = await fetchFulfillmentBoxes(ifNumber)
  if (!boxes.length) {
    return { ifNumber, boxes: [], error: `no scanned-in boxes captured for ${ifNumber} — the rate comes off the box dims recorded at scan-in` }
  }

  // One history read for the whole shipment; the model does the per-box matching.
  const actuals = await fetchActuals({ account: WHOLESALE_ACCOUNT, serviceCode }, pool)
  const asOfDate = new Date().toISOString().slice(0, 10)

  const results = []
  let liveWholesaleError = null
  for (const box of boxes) {
    const figures = []

    // 1. Live wholesale — the real answer, when the connection is up.
    const wholesaleLive = await quoteAccount({ account: WHOLESALE_ACCOUNT, box, destination, residential })
    if (wholesaleLive.ok) {
      const pick = wholesaleLive.figures.find((f) => f.serviceCode === serviceCode) || wholesaleLive.figures[0]
      if (pick) figures.push(pick)
    } else {
      liveWholesaleError = wholesaleLive.error
    }

    // 2. Wholesale billed history — works today.
    const hist = quoteFromActuals(
      actuals,
      { account: WHOLESALE_ACCOUNT, serviceCode, weightLb: Number(box.weightLb), destPostal: destination?.postalCode, destState: destination?.state },
      { asOfDate },
    )
    if (hist) figures.push(hist)

    // 3. The ecom account, cross-check only.
    const ecomLive = await quoteAccount({ account: '18GE01', box, destination, residential })
    if (ecomLive.ok) {
      const pick = ecomLive.figures.find((f) => f.serviceCode === serviceCode) || ecomLive.figures[0]
      if (pick) figures.push(pick)
    }

    results.push(rateAnswerForBox(box, figures, { liveWholesaleError }))
  }

  // Shipment total, only when EVERY box produced a wholesale figure — a partial sum
  // would read as the shipment's cost while silently omitting boxes.
  const perBox = results.map((r) => (r.wholesale ? (r.wholesale.total ?? r.wholesale.median) : null))
  const complete = perBox.every((v) => typeof v === 'number')
  const total = complete ? Math.round(perBox.reduce((a, b) => a + b, 0) * 100) / 100 : null

  return {
    ifNumber,
    serviceCode,
    destination,
    account: WHOLESALE_ACCOUNT,
    boxes: results,
    wholesaleTotal: total,
    wholesaleTotalBasis: complete ? results[0].wholesale.basis : null,
    incompleteReason: complete ? null 
      : `no wholesale figure for ${perBox.filter((v) => typeof v !== 'number').length} of ${perBox.length} box(es) — a partial total would understate the shipment`,
    liveWholesaleError,
    historyRows: actuals.length,
    fix: liveWholesaleError
      ? 'ShipStation → Settings → Shipping → Carriers → NAGHEDI UPS (C6J610) Big Box → reconnect. Then GET /api/ups/connection to confirm.'
      : null,
  }
}

// Rate-tests the wholesale carrier. Deliberately does NOT trust /v2/carriers — the
// broken connection still advertises 23 healthy services from cache, which is what
// made this look fine for weeks. One free quote is the only honest check.
export async function getUpsConnection() {
  const { checkConnection } = await import('../src/ingest/shipstationRates.js')
  const { WHOLESALE_ACCOUNT } = await import('../src/model/upsRates.js')
  const [wholesale, ecom] = await Promise.all([checkConnection(WHOLESALE_ACCOUNT), checkConnection('18GE01')])
  return {
    wholesale,
    ecom,
    ready: wholesale.healthy,
    fix: wholesale.healthy ? null : 'ShipStation → Settings → Shipping → Carriers → NAGHEDI UPS (C6J610) Big Box → reconnect/re-authorize.',
  }
}

// ── Did every carton that shipped get announced? (Nima, 2026-07-31) ──────────
// The comparison is src/model/asnCartonCheck.js; the run is
// src/ingest/asnCartonSync.js. These two functions are the app's side of it: one
// reads the last run's verdict for the UI, the other decides whether the
// schedule should run it again.
//
// Read-only and cheap — Neon rows only. The run itself can't answer an HTTP
// request (one Orderful message GET per delivered ASN, 212 live), which is
// exactly why it persists.
export async function getAsnCartonCheck() {
  // The verdict comes from the last run that actually COMPLETED, and a failure
  // since then is reported alongside it rather than replacing it. Showing only
  // the newest row would throw away "710/710 as of this morning" the moment one
  // run hit a NetSuite hiccup — and "no data" is the one answer this check must
  // never give when it has an answer.
  const { rows: runs } = await pool.query(
    'SELECT * FROM asn_carton_run ORDER BY ran_at DESC FETCH FIRST 5 ROWS ONLY')
  const latest = runs[0]
  const run = runs.find((r) => !r.error)
  const failedSince = latest && latest.error ? { ranAt: latest.ran_at, error: latest.error } : null

  // Never run is its own answer, not an empty result. A check that has never
  // executed looks identical to a clean one unless it says so.
  if (!run) {
    return { neverRun: true, minHours: ASN_CHECK_MIN_HOURS, counts: null,
      headline: failedSince ? 'last run failed' : 'never run', failedSince,
      undeclared: [], phantom: [], blankSscc: [], duplicated: [] }
  }

  const { rows } = await pool.query(
    `SELECT sscc, finding, if_number, po_dc, declared_on FROM asn_carton_check
      WHERE finding <> 'matched' ORDER BY finding, if_number, sscc`)

  // Grouped by fulfilment, because you re-send an ASN for a shipment, not for a
  // single box. Same grain as undeclaredByFulfilment() in the model — done here
  // since the rows arrive flat.
  const byIf = new Map()
  for (const r of rows.filter((r) => r.finding === 'undeclared')) {
    const k = r.if_number || '(unknown IF)'
    if (!byIf.has(k)) byIf.set(k, { ifNumber: r.if_number, poDc: r.po_dc, ssccs: [] })
    byIf.get(k).ssccs.push(r.sscc)
  }
  const blank = new Map()
  for (const r of rows.filter((r) => r.finding === 'blank_sscc')) {
    const k = r.if_number || '(unknown IF)'
    if (!blank.has(k)) blank.set(k, { ifNumber: r.if_number, poDc: r.po_dc, cartons: 0 })
    blank.get(k).cartons++
  }
  const dup = new Map()
  for (const r of rows.filter((r) => r.finding === 'duplicated')) {
    if (!dup.has(r.sscc)) dup.set(r.sscc, { sscc: r.sscc, ifNumbers: [] })
    dup.get(r.sscc).ifNumbers.push(r.if_number)
  }

  const counts = run.counts || {}
  return {
    neverRun: false,
    ranAt: run.ran_at,
    status: run.status,
    // The same one-liner the CLI prints, so the tab and the terminal never
    // disagree about what the run found.
    headline: asnSummary({ status: run.status, counts }),
    counts,
    scope: {
      kind: run.scope,
      pos: run.pos,
      posRequested: run.pos_requested,
      docsDelivered: run.docs_delivered,
      docsUndelivered: run.docs_undelivered,
      fulfillments: run.fulfillments,
      shipped: run.shipped,
      messageErrors: run.message_errors,
    },
    minHours: ASN_CHECK_MIN_HOURS,
    due: asnCheckDue(run.ran_at),
    failedSince,
    undeclared: [...byIf.values()].sort((a, b) => b.ssccs.length - a.ssccs.length),
    phantom: rows.filter((r) => r.finding === 'phantom').map((r) => ({ sscc: r.sscc, declaredOn: r.declared_on || [] })),
    blankSscc: [...blank.values()],
    duplicated: [...dup.values()],
  }
}

// Run it and wait. `force` bypasses the ASN_CHECK_MIN_HOURS cadence (see the
// model for why six hours).
//
// SCOPE: activity in the last ASN_CHECK_WINDOW_DAYS, on BOTH sides — POs with a
// recent 856 and POs that shipped recently (a carton going out today on a PO
// whose last ASN is old is precisely what must not be missed). The comparison is
// still whole-PO, so nothing reads as a phantom just for being older.
//
// Not the full history, measured 2026-07-31 and deliberately: a full audit is
// ~14 minutes and reports 127 undeclared cartons on 2023-era POs (IF4256–IF5513,
// the POJ…-SBX2 era, one phantom SSCC literally "12345678910123456789"). Pinning
// years of unactionable history to a live panel is how a check stops being read.
// Run `npm run check:asn-cartons -- --all` for the audit.
export async function runAsnCartonCheck({ force = false } = {}) {
  const { rows } = await pool.query('SELECT MAX(ran_at) AS last FROM asn_carton_run')
  const last = rows[0]?.last || null
  if (!force && !asnCheckDue(last)) return { skipped: 'not due', lastRanAt: last }

  const { syncAsnCartons } = await import('../src/ingest/asnCartonSync.js')
  const r = await syncAsnCartons({ sinceDays: ASN_CHECK_WINDOW_DAYS })
  if (!r.ok) throw new Error(r.error)
  if (r.empty) return { skipped: r.reason }
  return { ok: true, status: r.run.status, counts: r.run.counts, scope: { pos: r.run.pos, shipped: r.run.shipped } }
}

// Kick it off WITHOUT waiting, which is how both callers use it.
//
// The full run is minutes of SuiteQL (the PO scope is the whole 856 history,
// chunked 50 POs at a time), and holding an HTTP request open that long is what
// makes a scheduled POST fail through Render for reasons that have nothing to do
// with the check. So: return immediately, let it finish.
//
// A failure is written to asn_carton_run.error rather than logged and lost.
// Detached work that fails silently is exactly the shape of bug this repo keeps
// paying for — a check nobody can see failing reads as a check that passed.
let asnCheckInFlight = false
export async function startAsnCartonCheck({ force = false } = {}) {
  if (asnCheckInFlight) return { skipped: 'already running' }
  const { rows } = await pool.query('SELECT MAX(ran_at) AS last FROM asn_carton_run')
  const last = rows[0]?.last || null
  if (!force && !asnCheckDue(last)) return { skipped: 'not due', lastRanAt: last, minHours: ASN_CHECK_MIN_HOURS }

  asnCheckInFlight = true
  runAsnCartonCheck({ force: true })
    .then((r) => console.log('ASN carton check:', JSON.stringify(r)))
    .catch(async (e) => {
      console.error('ASN carton check failed:', e.message)
      try {
        await pool.query(
          `INSERT INTO asn_carton_run (status, error) VALUES ('error', $1)`, [e.message])
      } catch (e2) {
        console.error('could not record the ASN check failure:', e2.message)
      }
    })
    .finally(() => { asnCheckInFlight = false })
  return { started: true, lastRanAt: last }
}

// ── Manual "refresh from NetSuite" (Nima, 2026-07-31) ────────────────────────
// The button next to Import CSV. Nima had deliberately never asked for one,
// fearing a cap on how many times we may call NetSuite — worth stating plainly
// because it changes the design: THERE IS NO DAILY CALL QUOTA. SuiteQL/REST is
// governed by CONCURRENT requests, and that allowance is shared with Celigo.
//
// So the cost of a press is not "one of a limited number of calls" — the
// scheduled cycle already runs ~8 sequential queries roughly 16× a day. The only
// real risk is colliding with Celigo, and Celigo has priority. Hence:
//
//   1. A cheap PREFLIGHT query first. If NetSuite is saturated we find out for
//      the price of one tiny read instead of starting an 8-query sync that dies
//      halfway and leaves the person guessing which half landed.
//   2. NO RETRY, ever (see netsuiteApi.js). Retrying is how a button steals
//      concurrency from the integration we're protecting.
//   3. Sequential, exactly like the cron. Parallelising would be the one change
//      that genuinely does hurt Celigo.
//   4. The heavy pull is DETACHED. Measured live 2026-07-31 a full refresh takes
//      ~93 seconds, and Render's proxy cuts a request near 100 — so holding the
//      connection open would fail on the deploy Nima actually uses while working
//      fine here. The PREFLIGHT stays synchronous, because "NetSuite is busy" is
//      the answer he asked for and it must come back instantly.
let netsuiteRefreshInFlight = false
let netsuiteRefreshLast = null   // the last finished result, for the poller
// Which step is in flight, for the progress bar on the button (Nima,
// 2026-08-11). Resolved through src/model/netsuiteRefreshSteps.js so the label
// and the total come from one list — see that file for why this is not a timer.
let netsuiteRefreshStep = null

// Fast, synchronous: is NetSuite free right now? One tiny read.
export async function preflightNetsuite() {
  const { runSuiteQL, netsuiteConfigured } = await import('../src/ingest/netsuiteApi.js')
  if (!netsuiteConfigured()) return { error: 'NetSuite is not configured on this server' }
  if (netsuiteRefreshInFlight) return { busy: true, reason: 'in_flight' }
  const pre = await runSuiteQL('SELECT id FROM transaction WHERE ROWNUM <= 1')
  if (pre.busy) return { busy: true, reason: 'celigo', retryAfter: pre.retryAfter ?? null }
  if (!pre.ok) return { error: pre.needsAuth ? 'NetSuite rejected our credentials' : (pre.error || 'the NetSuite preflight failed') }
  return { ok: true }
}

// Preflight, then let the pull run on its own. Returns as soon as it STARTS.
export async function startNetsuiteRefresh() {
  const pre = await preflightNetsuite()
  if (!pre.ok) return pre
  netsuiteRefreshInFlight = true
  netsuiteRefreshLast = null
  netsuiteRefreshStep = null
  refreshFromNetsuite({ preflighted: true, onStep: (key) => { netsuiteRefreshStep = refreshProgress(key) } })
    .then((r) => { netsuiteRefreshLast = r; console.log('NetSuite refresh:', JSON.stringify(r)) })
    .catch((e) => { netsuiteRefreshLast = { error: e?.message || String(e) } })
    .finally(() => { netsuiteRefreshInFlight = false; netsuiteRefreshStep = null })
  return { started: true }
}

// What the client polls while the button spins.
export function netsuiteRefreshStatus() {
  return { running: netsuiteRefreshInFlight, result: netsuiteRefreshLast, step: netsuiteRefreshStep }
}

export async function refreshFromNetsuite({ preflighted = false, onStep } = {}) {
  const { isBusyResponse, netsuiteConfigured, runSuiteQL } = await import('../src/ingest/netsuiteApi.js')
  // A busy signal can also arrive as a string propagated up from a sync, so the
  // same detector is applied to error text, not only to live responses.
  const busyFrom = (e) => isBusyResponse(0, e || '')

  if (!netsuiteConfigured()) return { error: 'NetSuite is not configured on this server' }
  if (!preflighted) {
    const pre = await runSuiteQL('SELECT id FROM transaction WHERE ROWNUM <= 1')
    if (pre.busy) return { busy: true, reason: 'celigo', retryAfter: pre.retryAfter ?? null }
    if (!pre.ok) return { error: pre.needsAuth ? 'NetSuite rejected our credentials' : (pre.error || 'the NetSuite preflight failed') }
  }
  try {
    const { syncFromNetsuite } = await import('../src/ingest/netsuiteSync.js')
    const { syncFulfillmentDc } = await import('../src/ingest/fulfillmentDc.js')
    const { syncEdiPackagesLive } = await import('../src/ingest/ediPackagesLive.js')

    // Same three pulls the schedule does, in the same order. Anything that comes
    // back busy stops the rest — pressing on would be the retry we just refused.
    const main = await syncFromNetsuite({ onStep })
    if (!main.ok) {
      return busyFrom(main.error)
        ? { busy: true, reason: 'celigo' }
        : { error: main.error || 'the NetSuite pull failed' }
    }

    let cartons = null
    let dcWarning = null
    try {
      onStep?.('fulfillmentDc')
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      await syncFulfillmentDc({ since })
    } catch (e) {
      // Non-fatal: this only backfills the IF→(PO,DC) link. The orders the human
      // pressed the button for are already in. Say so rather than failing.
      dcWarning = e.message
    }
    onStep?.('cartons')
    const feed = await syncEdiPackagesLive({})
    if (feed.ok) cartons = { loaded: feed.loaded ?? 0, skipped: feed.skipped || null }
    else if (busyFrom(feed.error)) return { busy: true, reason: 'celigo', partial: 'orders are in; the carton feed hit the limit' }

    return {
      ok: true,
      counts: {
        orders: main.nOrders ?? 0,
        fulfillments: main.nFul ?? 0,
        invoices: main.nInv ?? 0,
        archived: (main.archived || []).length,
      },
      cartons,
      dcWarning,
      syncedAt: new Date().toISOString(),
    }
  } catch (e) {
    return busyFrom(e?.message) ? { busy: true, reason: 'celigo' } : { error: e?.message || String(e) }
  }
}
