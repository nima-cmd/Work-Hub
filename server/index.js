// server/index.js — tiny Express API that serves order data from Neon, and
// (in production) serves the built React client. Run: `npm run server`
// (which loads .env.local for the Neon connection).

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { getOrders, getFreshness } from './queries.js'
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

app.post('/api/import', async (req, res) => {
  try {
    const files = req.body?.files || []
    res.json(await importBatch(files))
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
