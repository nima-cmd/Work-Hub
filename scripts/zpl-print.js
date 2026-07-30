#!/usr/bin/env node
// scripts/zpl-print.js — send raw ZPL straight to a thermal printer over TCP 9100.
//
// This replaces DropPrint. NetSuite's "Print Label" hands you a .zpl file, and the
// ONLY thing that has to happen next is "send these bytes to the printer" — macOS
// can't RENDER ZPL through the normal print pipeline, but it can absolutely stream
// it raw, which is what port 9100 is for.
//
// Why not DropPrint: it's a hidden LSUIElement agent with no Dock icon, no visible
// success/failure, a licence that needs re-authenticating, and it prints via a CUPS
// queue that can silently jam (which is exactly what happened 2026-07-27 — three
// oversized jobs disabled the queue and everything after it queued forever). This
// talks to the printer directly, prints nothing without saying so, and logs every job.
//
// Usage:
//   node scripts/zpl-print.js label.zpl              # print one file
//   node scripts/zpl-print.js --check                # reachability only, prints nothing
//   node scripts/zpl-print.js --peek label.zpl       # show what WOULD be sent, print nothing
//   node scripts/zpl-print.js --watch ~/Downloads    # auto-print .zpl dropped in a folder
//   cat label.zpl | node scripts/zpl-print.js -      # from stdin
//
// Printer: --host/--port, else ZPL_PRINTER_HOST/ZPL_PRINTER_PORT, else the default
// below (the Zebra on the warehouse LAN, verified listening on 9100 2026-07-30).

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_HOST = process.env.ZPL_PRINTER_HOST || '192.168.1.126'
const DEFAULT_PORT = Number(process.env.ZPL_PRINTER_PORT || 9100)
const LOG = path.join(os.homedir(), '.work-hub-zpl-print.log')

const args = process.argv.slice(2)

// A flag that TAKES a value (--host x). Consumes both.
const valueFlag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return null
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) { args.splice(i, 1); return true }
  args.splice(i, 2)
  return v
}
// A boolean flag (--peek). Must NOT consume the next arg, or `--peek label.zpl`
// eats the filename and the file silently never gets read.
const boolFlag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

const host = valueFlag('--host') || DEFAULT_HOST
const port = Number(valueFlag('--port') || DEFAULT_PORT)
const check = boolFlag('--check')
const peek = boolFlag('--peek')
const force = boolFlag('--force')
// --watch is optional-value: bare means ~/Downloads, else the given dir.
const watchDir = args.includes('--watch') ? valueFlag('--watch') : null
const target = args[0]

function log(line) {
  const stamp = new Date().toISOString()
  try { fs.appendFileSync(LOG, `${stamp} ${line}\n`) } catch { /* logging must never block a print */ }
}

// Open a TCP socket and confirm the printer is listening — no data sent.
function probe() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port })
    const done = (ok, why) => { s.destroy(); resolve({ ok, why }) }
    s.setTimeout(4000)
    s.on('connect', () => done(true))
    s.on('timeout', () => done(false, 'timed out'))
    s.on('error', (e) => done(false, e.code || e.message))
  })
}

// Stream bytes to the printer. Resolves once the socket has flushed and closed —
// port 9100 is fire-and-hose, so a clean close is the only success signal we get.
function send(buffer) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port })
    s.setTimeout(10_000)
    s.on('connect', () => s.end(buffer))
    s.on('close', () => resolve())
    s.on('timeout', () => { s.destroy(); reject(new Error('timed out talking to the printer')) })
    s.on('error', (e) => reject(new Error(`${e.code || e.message} connecting to ${host}:${port}`)))
  })
}

// A sanity gate so we never hose the printer with a PDF again. The Jul-27 jam was
// ~690KB jobs on a raw queue: real ZPL is a few KB of text starting with ^XA / ~.
function inspect(buffer, name) {
  const head = buffer.subarray(0, 400).toString('latin1')
  const looksZpl = /(\^XA|~[A-Z]{2}|\^FX)/.test(head)
  const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-'
  const labels = (buffer.toString('latin1').match(/\^XA/g) || []).length
  return {
    looksZpl, isPdf, labels,
    kb: (buffer.length / 1024).toFixed(1),
    warn: isPdf
      ? `${name} is a PDF, not ZPL — sending it raw is exactly what jammed the queue on Jul 27. Print PDFs normally instead.`
      : !looksZpl
        ? `${name} doesn't look like ZPL (no ^XA/~ commands found). Refusing to send it blind.`
        : buffer.length > 256 * 1024
          ? `${name} is ${(buffer.length / 1024).toFixed(0)}KB — very large for ZPL. Check it's not an image dump.`
          : null,
  }
}

async function printFile(file, { force = false } = {}) {
  const buffer = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file)
  const name = file === '-' ? '<stdin>' : path.basename(file)
  const info = inspect(buffer, name)

  console.log(`📄 ${name} — ${info.kb} KB, ${info.labels || '?'} label format(s)`)
  if (info.warn) {
    console.log(`⚠️  ${info.warn}`)
    if (!force && (info.isPdf || !info.looksZpl)) {
      console.log('   Not sent. Re-run with --force if you\'re certain.')
      log(`REFUSED ${name} (${info.kb}KB): ${info.warn}`)
      return false
    }
  }
  if (peek) {
    console.log('--- first 400 bytes (nothing sent) ---')
    console.log(buffer.subarray(0, 400).toString('latin1'))
    return true
  }
  await send(buffer)
  console.log(`✅ sent to ${host}:${port} — ${info.labels || 1} label(s) should print`)
  log(`PRINTED ${name} ${info.kb}KB labels=${info.labels} -> ${host}:${port}`)
  return true
}

// ── main ─────────────────────────────────────────────────────────────────────
if (check) {
  const r = await probe()
  console.log(r.ok
    ? `✅ printer reachable at ${host}:${port} (raw ZPL port is listening)`
    : `❌ cannot reach ${host}:${port} — ${r.why}`)
  console.log('   Nothing was printed.')
  process.exit(r.ok ? 0 : 1)
}

if (watchDir) {
  const dir = watchDir === true ? path.join(os.homedir(), 'Downloads') : watchDir.replace(/^~/, os.homedir())
  const r = await probe()
  console.log(r.ok ? `✅ printer ${host}:${port} reachable` : `⚠️  printer ${host}:${port} NOT reachable (${r.why}) — will still watch`)
  console.log(`👀 watching ${dir} for .zpl files — Ctrl-C to stop`)
  console.log(`   log: ${LOG}`)
  const seen = new Set()
  fs.watch(dir, async (_event, filename) => {
    if (!filename || !/\.zpl$/i.test(filename)) return
    const full = path.join(dir, filename)
    if (seen.has(full)) return
    seen.add(full)
    setTimeout(() => seen.delete(full), 5000) // debounce: editors/browsers fire twice
    // let the browser finish writing before we read it
    await new Promise((r2) => setTimeout(r2, 400))
    try {
      if (!fs.existsSync(full) || fs.statSync(full).size === 0) return
      await printFile(full, { force })
    } catch (e) {
      console.log(`❌ ${filename}: ${e.message}`)
      log(`ERROR ${filename}: ${e.message}`)
    }
  })
} else if (target) {
  try {
    const ok = await printFile(target, { force })
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.log(`❌ ${e.message}`)
    log(`ERROR ${target}: ${e.message}`)
    process.exit(1)
  }
} else {
  console.log(`Send raw ZPL to a thermal printer (default ${DEFAULT_HOST}:${DEFAULT_PORT}).

  node scripts/zpl-print.js label.zpl           print one file
  node scripts/zpl-print.js --check             reachability only, prints nothing
  node scripts/zpl-print.js --peek label.zpl    show what would be sent
  node scripts/zpl-print.js --watch ~/Downloads auto-print dropped .zpl files
  cat label.zpl | node scripts/zpl-print.js -   from stdin

  --host H --port P   override the printer
  --force             send even if it doesn't look like ZPL`)
}
