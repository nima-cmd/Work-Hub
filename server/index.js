// server/index.js — tiny Express API that serves order data from Neon, and
// (in production) serves the built React client. Run: `npm run server`
// (which loads .env.local for the Neon connection).

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  getOrders, getFreshness, getNwFreshness, getShipDepartures, getLaunchBay, getCredits, getAffection,
  getOcPoReview, commitOcPoLink, undoOcPoLink, dismissOcPoLine,
  getEdiReview, syncEdi, linkEdiTransaction, unlinkEdiTransaction, addEdiManualOrder, removeEdiManualOrder,
  ackEdiTransaction, unackEdiTransaction, getSeasons, setSeason, createEdiTaskFor,
  setEdiSupply, clearEdiSupply, getLinksFor, createDocLink, removeDocLink, searchDocNumbers,
  resolveEdiPo, unresolveEdiPo,
  getQuestEmails, syncQuestEmails, markQuestEmailRead, assignQuestEmail, applyQuestEmailLabel, dismissQuestEmailLine, getLedgerNotes,
  getNotesFor, addNote, deleteNote, getAllNotes,
  getGmailLabels, spamQuestEmail, getCalendarEvents,
  getQuestTasks, createTaskFromQuestEmail, acknowledgeQuestEmail, setEmailNote, addManualTask, addTasksBulk, completeTask, getQuestEmailThread,
  setTaskNeeds, setTaskUrgency, setTaskCharacter, setTaskChecklistItem, searchQuestArchive, getTaskActivity,
  ensureRecurringTasks, recordCustodyScan, getOrderEventsFeed,
  recordFulfillmentBox, getCustodyRegister, clearCustodyItem,
} from './queries.js'
import { importBatch } from '../src/ingest/importer.js'
import { printCargoTag, availableSizes } from './printLabel.js'
import { authGate, issueSessionCookie, clearSessionCookie, checkPassword } from './auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json({ limit: '40mb' })) // CSV exports can be a few MB

// Access terminal (Nima, 2026-07-20): a single shared password gates the
// whole site — see server/auth.js. Login/logout are registered BEFORE the
// gate so they're always reachable; everything else (API + the built client)
// goes through authGate. No-op if SITE_PASSWORD isn't set (local dev).
app.post('/api/login', (req, res) => {
  if (checkPassword(req.body?.password)) {
    issueSessionCookie(res)
    return res.json({ ok: true })
  }
  res.status(401).json({ error: 'Incorrect passcode' })
})
app.post('/api/logout', (req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})
app.use(authGate)

app.get('/api/orders', async (_req, res) => {
  try {
    res.json(await getOrders())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/freshness', async (_req, res) => {
  try {
    res.json(await getFreshness())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Naghedi-Warehouse import freshness, read from that app's Supabase (read-only
// — uploads stay in that app; this just says whether they're current).
app.get('/api/nw-freshness', async (_req, res) => {
  try {
    res.json(await getNwFreshness())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/ship-departures', async (_req, res) => {
  try {
    res.json(await getShipDepartures())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/launch-bay', async (_req, res) => {
  try {
    res.json(await getLaunchBay())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/credits', async (_req, res) => {
  try {
    res.json(await getCredits())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/affection', async (_req, res) => {
  try {
    res.json(await getAffection())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Custody scan (QR labels): direction 'OUT' = handed to warehouse, 'IN' = back.
// Paper cargo tag (2.25×1.25) — printed straight to the MUNBYN via lp. Only
// works where the printer queue exists (the local warehouse iMac). GET reports
// availability so the UI can hide/disable the button on the cloud deploy.
app.get('/api/print-label/available', async (_req, res) => {
  res.json(await availableSizes())
})

app.post('/api/print-label', async (req, res) => {
  try {
    const { size, ...info } = req.body || {}
    res.json(await printCargoTag(info, size))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/custody/scan', async (req, res) => {
  try {
    res.json(await recordCustodyScan(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// Box capture from the Scan Bay (IN-scan carton measurement, skippable)
app.post('/api/custody/box', async (req, res) => {
  try {
    res.json(await recordFulfillmentBox(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// Custody register — IFs + DC cartons in the custody gap (scanned, not departed)
app.get('/api/custody/register', async (_req, res) => {
  try {
    res.json(await getCustodyRegister())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Manually clear a custody item off the register (departed / stale orphan)
app.post('/api/custody/clear', async (req, res) => {
  try {
    res.json(await clearCustodyItem(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// Order-events ledger feed (?date=YYYY-MM-DD, ?docNumber=IF123, ?soNumber=SO123)
app.get('/api/events', async (req, res) => {
  try {
    const { date, docNumber, soNumber } = req.query
    res.json(await getOrderEventsFeed({ date, docNumber, soNumber }))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/import', async (req, res) => {
  try {
    const files = req.body?.files || []
    res.json(await importBatch(files))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// OC↔PO allocation review — read-only compute; nothing is written until one
// of the mutation routes below is hit explicitly (matching stays manual).
app.get('/api/oc-po/review', async (_req, res) => {
  try {
    res.json(await getOcPoReview())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/oc-po/commit', async (req, res) => {
  try {
    const { ocNumber, poNumber, item, allocatedQty, note } = req.body || {}
    if (!ocNumber || !poNumber || !item || !(allocatedQty > 0)) {
      return res.status(400).json({ error: 'ocNumber, poNumber, item, and a positive allocatedQty are required' })
    }
    await commitOcPoLink({ ocNumber, poNumber, item, allocatedQty, note })
    res.json(await getOcPoReview())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/oc-po/links/:id', async (req, res) => {
  try {
    await undoOcPoLink(Number(req.params.id))
    res.json(await getOcPoReview())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { type: 'oc'|'po', ocNumber|poNumber, item, note, dismissed=true }
// dismissed:false reverses a mistaken "mark to close".
app.post('/api/oc-po/dismiss', async (req, res) => {
  try {
    const { type, ocNumber, poNumber, item, note, dismissed = true } = req.body || {}
    if (!type || !item || (type === 'oc' ? !ocNumber : !poNumber)) {
      return res.status(400).json({ error: 'type, item, and ocNumber (or poNumber) are required' })
    }
    await dismissOcPoLine({ type, ocNumber, poNumber, item, note, dismissed })
    res.json(await getOcPoReview())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// EDI (Orderful) — 850/856/810/860 pipeline per business number. Reads from
// Neon; /sync pulls fresh data from Orderful's API into Neon first.
app.get('/api/edi/review', async (_req, res) => {
  try {
    res.json(await getEdiReview())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/edi/sync', async (_req, res) => {
  try {
    res.json(await syncEdi())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Manual PO resolution: connect to a NetSuite ref and/or mark closed.
app.post('/api/edi/resolution', async (req, res) => {
  try {
    res.json(await resolveEdiPo(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/edi/resolution/:businessNumber', async (req, res) => {
  try {
    res.json(await unresolveEdiPo(req.params.businessNumber))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Manual override when an 856/810 can't auto-link to its 850 (always visibly
// flagged in the UI as manual, never treated the same as an automated match).
app.post('/api/edi/link', async (req, res) => {
  try {
    const { transactionId, businessNumber, note } = req.body || {}
    if (!transactionId || !businessNumber) {
      return res.status(400).json({ error: 'transactionId and businessNumber are required' })
    }
    res.json(await linkEdiTransaction({ transactionId, businessNumber, note }))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/edi/link/:transactionId', async (req, res) => {
  try {
    res.json(await unlinkEdiTransaction(req.params.transactionId))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Per-document acknowledgment (Nima, 2026-07-20) — clears ONE invalid/failed
// document (resent-and-accepted, or confirmed nothing to link) without
// touching the rest of the PO's open work; see /api/edi/resolution for that.
app.post('/api/edi/transactions/:transactionId/ack', async (req, res) => {
  try {
    const { linkedTransactionId, note } = req.body || {}
    res.json(await ackEdiTransaction({ transactionId: req.params.transactionId, linkedTransactionId, note }))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/edi/transactions/:transactionId/ack', async (req, res) => {
  try {
    res.json(await unackEdiTransaction(req.params.transactionId))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Doc seasons — free-text season tag on any OC/PO/EDI PO (Nima, 2026-07-20).
app.get('/api/seasons', async (_req, res) => {
  try {
    res.json(await getSeasons())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/seasons', async (req, res) => {
  try {
    res.json(await setSeason(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// Document links — attach any doc/transaction to any other (Nima, 2026-07-20).
app.get('/api/links', async (req, res) => {
  try {
    const { docType, docNumber } = req.query
    if (!docType || !docNumber) return res.status(400).json({ error: 'docType and docNumber are required' })
    res.json(await getLinksFor(docType, docNumber))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/links', async (req, res) => {
  try {
    res.json(await createDocLink(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/links/:id', async (req, res) => {
  try {
    res.json(await removeDocLink(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Search known document numbers across every record type (for the link picker).
app.get('/api/doc-numbers', async (req, res) => {
  try {
    res.json(await searchDocNumbers(req.query.q))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Assign an EDI order's inbound production PO, or mark it from-stock.
app.post('/api/edi/:businessNumber/supply', async (req, res) => {
  try {
    const { poNumber, fromStock, note } = req.body || {}
    res.json(await setEdiSupply({ businessNumber: req.params.businessNumber, poNumber, fromStock, note }))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/edi/:businessNumber/supply', async (req, res) => {
  try {
    res.json(await clearEdiSupply(req.params.businessNumber))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Make an EDI PO into a task (Nima, 2026-07-20) — the manual button for POs
// the auto-reconcile skips (no matching SO yet). Idempotent per business number.
app.post('/api/edi/:businessNumber/task', async (req, res) => {
  try {
    res.json(await createEdiTaskFor(req.params.businessNumber))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// Hand-entered EDI orders that aged out of the searches (own flagged section).
app.post('/api/edi/manual-order', async (req, res) => {
  try {
    res.json(await addEdiManualOrder(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/edi/manual-order/:id', async (req, res) => {
  try {
    res.json(await removeEdiManualOrder(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Quest emails (Gmail-to-quest hologram transmissions). Reads from Neon;
// /sync pulls fresh messages from Gmail into Neon first. Mark-read and label
// routes write to the real inbox via src/ingest/gmail.js.
app.get('/api/quest-emails', async (_req, res) => {
  try {
    res.json(await getQuestEmails())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/quest-emails/sync', async (_req, res) => {
  try {
    res.json(await syncQuestEmails())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/quest-emails/:id/read', async (req, res) => {
  try {
    res.json(await markQuestEmailRead(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// On-demand only, not part of sync — every other message in this one's
// thread, so a Re: chain shows its earlier messages when expanded.
app.get('/api/quest-emails/:id/thread', async (req, res) => {
  try {
    res.json(await getQuestEmailThread(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { characterId, fromAddress } — fromAddress lets the reassignment be
// remembered for that sender (see assignQuestEmailCharacter).
app.post('/api/quest-emails/:id/character', async (req, res) => {
  try {
    const { characterId, fromAddress } = req.body || {}
    if (!characterId) return res.status(400).json({ error: 'characterId is required' })
    res.json(await assignQuestEmail({ id: req.params.id, characterId, fromAddress }))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/quest-emails/:id/label', async (req, res) => {
  try {
    const { label } = req.body || {}
    if (!label) return res.status(400).json({ error: 'label is required' })
    res.json(await applyQuestEmailLabel({ id: req.params.id, label }))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { dismissed=true } — dismissed:false reverses a mistaken dismiss.
app.post('/api/quest-emails/:id/dismiss', async (req, res) => {
  try {
    const { dismissed = true } = req.body || {}
    res.json(await dismissQuestEmailLine(req.params.id, dismissed))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Quest tasks — a transmission promoted to something durable (keeps its
// character/subject/snippet even after the source transmission cycles out).
app.get('/api/quest-tasks', async (_req, res) => {
  try {
    res.json(await getQuestTasks())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/quest-emails/:id/create-task', async (req, res) => {
  try {
    res.json(await createTaskFromQuestEmail(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// The Datapad ledger — every email note, standalone (Nima, 2026-07-20).
app.get('/api/ledger-notes', async (_req, res) => {
  try {
    res.json(await getLedgerNotes())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Universal notes (Nima, 2026-07-20) — the generic Datapad-on-anything API.
// GET with no query = every note (Datapad); GET ?docType&docNumber = the
// inline widget on a specific card.
app.get('/api/notes', async (req, res) => {
  try {
    const { docType, docNumber } = req.query
    res.json(docType && docNumber ? await getNotesFor(docType, docNumber) : await getAllNotes())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/notes', async (req, res) => {
  try {
    res.json(await addNote(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/notes/:id', async (req, res) => {
  try {
    await deleteNote(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// The user's Gmail labels (for the label picker).
app.get('/api/gmail/labels', async (_req, res) => {
  try {
    res.json(await getGmailLabels())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Upcoming Google Calendar events (in-app calendar + holocalls).
app.get('/api/calendar/events', async (_req, res) => {
  try {
    res.json(await getCalendarEvents())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Spam: Gmail SPAM label + dismissed locally, one click.
app.post('/api/quest-emails/:id/spam', async (req, res) => {
  try {
    res.json(await spamQuestEmail(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Note ledger: save (or clear with empty text) the summary note on an email.
app.post('/api/quest-emails/:id/note', async (req, res) => {
  try {
    res.json(await setEmailNote(req.params.id, req.body?.note ?? ''))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// One-click acknowledge: records a created-and-completed acknowledgment task.
app.post('/api/quest-emails/:id/acknowledge', async (req, res) => {
  try {
    res.json(await acknowledgeQuestEmail(req.params.id))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// A task Nima writes himself (no source email).
app.post('/api/quest-tasks', async (req, res) => {
  try {
    res.json(await addManualTask(req.body || {}))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Bulk task creation from selected orders / PO groups (Mission Quests).
app.post('/api/quest-tasks/bulk', async (req, res) => {
  try {
    res.json(await addTasksBulk(req.body?.tasks || []))
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message })
  }
})

// body: { done=true } — done:false reopens a task.
app.post('/api/quest-tasks/:id/complete', async (req, res) => {
  try {
    const { done = true } = req.body || {}
    res.json(await completeTask(Number(req.params.id), done))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { needsType: 'none'|'reply'|'acknowledgment'|'file'|'netsuite_doc', needsNote, netsuiteDocType, netsuiteDocNumber }
app.post('/api/quest-tasks/:id/needs', async (req, res) => {
  try {
    const { needsType = 'none', needsNote, netsuiteDocType, netsuiteDocNumber } = req.body || {}
    res.json(await setTaskNeeds({ id: Number(req.params.id), needsType, needsNote, netsuiteDocType, netsuiteDocNumber }))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { urgency: 'hi'|'mid'|'lo'|null }
app.post('/api/quest-tasks/:id/urgency', async (req, res) => {
  try {
    const { urgency } = req.body || {}
    res.json(await setTaskUrgency(Number(req.params.id), urgency))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { characterId }
app.post('/api/quest-tasks/:id/character', async (req, res) => {
  try {
    const { characterId } = req.body || {}
    if (!characterId) return res.status(400).json({ error: 'characterId is required' })
    res.json(await setTaskCharacter(Number(req.params.id), characterId))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// body: { itemKey, done } — for 'verified'-mode tasks' manual checklist items.
app.post('/api/quest-tasks/:id/checklist', async (req, res) => {
  try {
    const { itemKey, done } = req.body || {}
    if (!itemKey) return res.status(400).json({ error: 'itemKey is required' })
    res.json(await setTaskChecklistItem(Number(req.params.id), itemKey, !!done))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Journal — ?date=YYYY-MM-DD scopes to one day (Transmissions' Activity
// section and the Calendar view); omitted for a general recent feed.
app.get('/api/quest-activity', async (req, res) => {
  try {
    res.json(await getTaskActivity(req.query.date))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Archive search — reads past dismissed/done, unlike every other quest route.
app.get('/api/quest-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (!q) return res.json({ emails: [], tasks: [] })
    res.json(await searchQuestArchive(q))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Scheduled trigger for the recurring-task engine (Gmail sync + the 9am/2pm
// reminder + the daily CSV-freshness check) — meant to be called by an
// external scheduler, not a browser. Render's own Cron Jobs have no free
// tier, so this is hit by a GitHub Actions workflow instead (see
// .github/workflows/recurring-check.yml) — which, as a side benefit, also
// keeps a free Render web service from spinning down after 15 min idle.
// Gated on a shared secret (CRON_SECRET) since it's unauthenticated otherwise
// — set the SAME value in both Render's env vars and the GitHub Actions
// repo secret.
app.post('/api/internal/recurring-check', async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  try {
    let email = null
    try {
      const r = await syncQuestEmails()
      email = { fetched: r.fetched, upserted: r.upserted, autoClosed: r.autoClosed }
    } catch (e) {
      console.error('Gmail sync failed (recurring tasks still checked):', e.message)
    }
    const recurringCreated = await ensureRecurringTasks()
    res.json({ ok: true, email, recurringCreated })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// Serve the built client if it exists (SPA fallback for client-side routing).
const dist = join(__dirname, '../client/dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((_req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`▶ Tracker running at http://localhost:${PORT}`))
