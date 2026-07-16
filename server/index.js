// server/index.js — tiny Express API that serves order data from Neon, and
// (in production) serves the built React client. Run: `npm run server`
// (which loads .env.local for the Neon connection).

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  getOrders, getFreshness, getShipDepartures,
  getOcPoReview, commitOcPoLink, undoOcPoLink, dismissOcPoLine,
  getEdiReview, syncEdi, linkEdiTransaction, unlinkEdiTransaction,
  getQuestEmails, syncQuestEmails, markQuestEmailRead, assignQuestEmail, applyQuestEmailLabel, dismissQuestEmailLine,
  getQuestTasks, createTaskFromQuestEmail, completeTask, getQuestEmailThread,
  setTaskNeeds, setTaskUrgency, setTaskCharacter, setTaskChecklistItem, searchQuestArchive, getTaskActivity,
} from './queries.js'
import { importBatch } from '../src/ingest/importer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json({ limit: '40mb' })) // CSV exports can be a few MB

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

app.get('/api/ship-departures', async (_req, res) => {
  try {
    res.json(await getShipDepartures())
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

// Serve the built client if it exists (SPA fallback for client-side routing).
const dist = join(__dirname, '../client/dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((_req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`▶ Tracker running at http://localhost:${PORT}`))
