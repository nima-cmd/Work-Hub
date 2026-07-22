// scripts/print-agent.js — the LOCAL print bridge (Nima, 2026-07-22).
//
// Printing is done server-side via macOS `lp`, so it only works on the machine
// the MUNBYN/Zebra are plugged into (the warehouse iMac). When Work-Hub is used
// from the Render deploy, that cloud server can't reach the printers — so this
// tiny agent runs ON the iMac and exposes just the print endpoints on
// localhost. A browser open on the iMac (even pointed at the Render URL) calls
// this agent directly to fire a label; the client falls back to it whenever the
// main server reports no printers.
//
//   npm run print-agent        # leave running in a Terminal on the iMac
//
// Reuses the exact same label renderers as the main server, so labels are
// identical. Localhost-only + permissive CORS so an https page on the same
// machine can reach it. Future: this is where a queue / multi-printer routing
// would live if the setup grows.
import { createServer } from 'node:http'
import { printCargoTag, availableSizes } from '../server/printLabel.js'

const PORT = Number(process.env.PRINT_AGENT_PORT || 7777)

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // any localhost/https origin on this machine may call the agent
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})

  if (req.method === 'GET' && req.url === '/available') {
    availableSizes().then((s) => send(res, 200, s)).catch((e) => send(res, 500, { error: e.message }))
    return
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/ping')) {
    return send(res, 200, { ok: true, agent: 'work-hub-print-agent', port: PORT })
  }

  if (req.method === 'POST' && req.url === '/print') {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', async () => {
      try {
        const { size, ...info } = JSON.parse(raw || '{}')
        send(res, 200, await printCargoTag(info, size))
      } catch (e) { send(res, 500, { error: e.message }) }
    })
    return
  }

  send(res, 404, { error: 'not found' })
})

// bind to loopback only — never expose the printer to the network
server.listen(PORT, '127.0.0.1', () => {
  console.log(`◆ Work-Hub print agent on http://localhost:${PORT}`)
  availableSizes().then((s) => {
    const ready = Object.entries(s).filter(([, v]) => v).map(([k]) => k)
    console.log(ready.length ? `  printers ready: ${ready.join(', ')}` : '  ⚠ no label printers detected on this machine')
  })
})
