// server/queries.js — read orders (+ their fulfillments) from Neon and enrich
// each with the SAME pipeline flags the CLI analyzer uses, so UI and analyzer
// never disagree.

import { pool } from '../src/db.js'
import { computeFlags } from '../src/model/pipeline.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'
import { SOURCE_LABELS, REQUIRED_SOURCES } from '../src/ingest/detect.js'
import {
  fetchOrderConfirmations, fetchPurchaseOrders, fetchOcPoLinks,
  upsertOcPoLink, deleteOcPoLink, dismissOrderConfirmation, dismissPurchaseOrder,
} from '../src/ingest/loadToDb.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { computeContainerView } from '../src/model/ocPoContainers.js'
import { computeEdiPipeline } from '../src/model/ediPipeline.js'
import { fetchEdiTransactions, syncOrderful, fetchEdiDocumentPoRefs } from '../src/ingest/orderful.js'
import {
  fetchEdiFulfillments, fetchEdiManualLinks, upsertEdiManualLink, deleteEdiManualLink,
} from '../src/ingest/loadToDb.js'
import { insertOrderEvent, fetchOrderEvents } from '../src/ingest/loadToDb.js'
import {
  fetchQuestEmails, loadQuestEmails, reconcileReadStatus, assignQuestEmailCharacter, markQuestEmailReadLocal, dismissQuestEmail,
  fetchQuestEmailById, createQuestTask, fetchQuestTasks, fetchQuestTaskById, fetchOpenReplyTasks, completeQuestTask,
  updateTaskNeeds, updateTaskUrgency, updateTaskCharacter, searchQuestEmails, searchQuestTasks, logTaskActivity, fetchTaskActivity,
  fetchActiveRecurringTemplates, createRecurringTaskInstance, updateTaskChecklistItem,
} from '../src/ingest/loadToDb.js'
import { fetchInboxMessages, markMessageRead, applyLabel, fetchThread, getProfile } from '../src/ingest/gmail.js'
import { getCharacterById, CHARACTERS } from '../src/model/characters.js'
import { NETSUITE_DOC_TYPES, normalizeDocNumber } from '../src/model/netsuiteDocs.js'

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
export async function recordCustodyScan({ docNumber, direction, note }) {
  const dir = String(direction || '').toUpperCase()
  if (dir !== 'OUT' && dir !== 'IN') throw new Error(`direction must be OUT or IN, got: ${direction}`)
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

  const event = await insertOrderEvent({
    eventType: dir === 'OUT' ? 'CUSTODY_OUT' : 'CUSTODY_IN',
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
    fulfillment,
  }
}

// The ledger feed — custody scans (and future derived transitions), scoped to
// a day for the Calendar or unscoped for a recent-history view.
export async function getOrderEventsFeed({ date, docNumber, soNumber } = {}) {
  return fetchOrderEvents({ date, docNumber, soNumber })
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
    if (!snap) return { key, label, status: 'missing', ageHours: null, fileModified: null, importedAt: null }
    const ageHours = snap.file_modified ? (now - new Date(snap.file_modified).getTime()) / 3.6e6 : null
    const status =
      ageHours == null ? 'unknown' : ageHours > STALE_HOURS ? 'stale' : ageHours > WARN_HOURS ? 'warn' : 'fresh'
    return { key, label, status, ageHours, fileModified: snap.file_modified, importedAt: snap.imported_at }
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
  const [transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs] = await Promise.all([
    fetchEdiTransactions(), fetchEdiFulfillments(), fetchEdiSourcedOrders(), fetchEdiManualLinks(), fetchEdiDocumentPoRefs(),
  ])
  return computeEdiPipeline(transactions, fulfillments, netsuiteOrders, manualLinks, documentPoRefs)
}

export async function linkEdiTransaction({ transactionId, businessNumber, note }) {
  await upsertEdiManualLink({ transactionId, businessNumber, note })
  return getEdiReview()
}

export async function unlinkEdiTransaction(transactionId) {
  await deleteEdiManualLink(transactionId)
  return getEdiReview()
}

export async function syncEdi() {
  if (!process.env.ORDERFUL_API_KEY) throw new Error('ORDERFUL_API_KEY is not set in .env.local')
  return syncOrderful(process.env.ORDERFUL_API_KEY)
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

// ── Recurring tasks ──────────────────────────────────────────────────────────
// Verifiers a 'verified'-mode task can reference by key. Add more here as new
// recurring tasks need real (code-checkable) completion gates.
const VERIFIERS = {
  csv_freshness_workhub: async () => {
    const fresh = await getFreshness()
    const bad = fresh.sources.filter((s) => s.status === 'stale' || s.status === 'missing')
    return { ok: bad.length === 0, detail: bad.length ? `Work-Hub source(s) still need re-upload: ${bad.map((s) => s.label).join(', ')}` : 'ok' }
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
export async function ensureRecurringTasks() {
  const templates = await fetchActiveRecurringTemplates()
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  let created = 0
  for (const t of templates) {
    const slots = t.scheduleType === 'daily_times' ? (t.scheduleTimes || []) : ['']
    for (const slot of slots) {
      if (t.scheduleType === 'daily_times') {
        const [hh, mm] = slot.split(':').map(Number)
        const slotTime = new Date(now)
        slotTime.setHours(hh, mm, 0, 0)
        if (now < slotTime) continue // this slot hasn't happened yet today
      }
      const instanceKey = `${t.key}:${dateStr}${slot ? ':' + slot : ''}`
      const characterId = t.characterId || CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id
      const taskId = await createRecurringTaskInstance({
        recurringKey: t.key, instanceKey, characterId, subject: t.title, snippet: t.description,
        completionMode: t.completionMode, verifyKey: t.verifyKey, urgency: t.urgency, checklist: t.checklistItems,
      })
      if (!taskId) continue // already existed
      await logTaskActivity({ taskId, kind: 'created', note: `Recurring: ${t.title}` })
      created++
    }
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
