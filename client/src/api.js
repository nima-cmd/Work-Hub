// Talks to the Express API. In dev this is proxied to :3001 by Vite;
// in production the same server serves both, so the relative path just works.
export async function fetchOrders() {
  const res = await fetch('/api/orders')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function fetchFreshness() {
  const res = await fetch('/api/freshness')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Naghedi-Warehouse import freshness (read from that app's Supabase).
export async function fetchNwFreshness() {
  const res = await fetch('/api/nw-freshness')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function fetchShipDepartures() {
  const res = await fetch('/api/ship-departures')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Launch Bay — pending departures as ships (grounded by status colour;
// approved-to-ship floats; a stale float is the "forgot to mark shipped" delay).
export async function fetchLaunchBay() {
  const res = await fetch('/api/launch-bay')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Cargo tags printed server-side via lp on the warehouse iMac (no browser
// dialog). Two sizes: '4x6' (Zebra thermal) and '2.25x1.25' (MUNBYN). The
// availability map says which sizes can print from this host so the UI hides
// buttons whose printer isn't reachable (e.g. the cloud deploy).
// Printing runs server-side via `lp`, so it only works where the printers are.
// The main server handles it on the iMac (local dev / npm run server). On the
// Render deploy the cloud server has no printers, so we fall back to a LOCAL
// print agent (scripts/print-agent.js) that the user runs on the iMac — a
// browser on that machine can reach it at localhost even from the https site.
const PRINT_AGENT = `http://localhost:${window.__PRINT_AGENT_PORT__ || 7777}`
let _printProvider // { base, sizes } — resolved once: main API, else the agent

async function resolvePrintProvider() {
  if (_printProvider) return _printProvider
  // 1) main server (same origin) — the local-server / dev case
  try {
    const r = await fetch('/api/print-label/available')
    if (r.ok) {
      const sizes = await r.json()
      if (Object.values(sizes).some(Boolean)) return (_printProvider = { base: '', sizes })
    }
  } catch { /* fall through to the agent */ }
  // 2) local print agent — the cloud-deploy-on-the-iMac case
  try {
    const r = await fetch(`${PRINT_AGENT}/available`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) return (_printProvider = { base: PRINT_AGENT, sizes: await r.json() })
  } catch { /* no agent running */ }
  return (_printProvider = { base: '', sizes: {} })
}

export async function fetchLabelSizes() {
  return (await resolvePrintProvider()).sizes
}

export async function printCargoTag(info, size) {
  const { base } = await resolvePrintProvider()
  const url = base ? `${base}/print` : '/api/print-label'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...info, size }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Shipment credits (header counter) and character affection (relationships).
export async function fetchCredits() {
  const res = await fetch('/api/credits')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function fetchAffection() {
  const res = await fetch('/api/affection')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// files: [{ name, text, lastModified }]
export async function importCsv(files) {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// OC↔PO allocation review — matching stays manual, so every call below either
// just reads, or performs the ONE explicit action a person requested.
export async function fetchOcPoReview() {
  const res = await fetch('/api/oc-po/review')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function commitOcPo({ ocNumber, poNumber, item, allocatedQty, note }) {
  const res = await fetch('/api/oc-po/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ocNumber, poNumber, item, allocatedQty, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function undoOcPoLink(id) {
  const res = await fetch(`/api/oc-po/links/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// type: 'oc' | 'po'; dismissed=false reverses a mistaken "mark to close".
export async function dismissOcPo({ type, ocNumber, poNumber, item, note, dismissed = true }) {
  const res = await fetch('/api/oc-po/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ocNumber, poNumber, item, note, dismissed }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// EDI (Orderful) — read-only mirror of the 850/856/810 pipeline. /sync pulls
// fresh transactions from Orderful into Neon before /review is re-read.
export async function fetchEdiReview() {
  const res = await fetch('/api/edi/review')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function syncEdi() {
  const res = await fetch('/api/edi/sync', { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Manual PO resolution — connect a PO to its NetSuite ref and/or mark closed.
export async function resolveEdiPo({ businessNumber, closed, cancelled, netsuiteRef, note }) {
  const res = await fetch('/api/edi/resolution', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessNumber, closed, cancelled, netsuiteRef, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function unresolveEdiPo(businessNumber) {
  const res = await fetch(`/api/edi/resolution/${encodeURIComponent(businessNumber)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Manual override when an 856/810 can't auto-link to its 850.
export async function linkEdiTransaction({ transactionId, businessNumber, note }) {
  const res = await fetch('/api/edi/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, businessNumber, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function unlinkEdiTransaction(transactionId) {
  const res = await fetch(`/api/edi/link/${transactionId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Per-document acknowledgment — clears one invalid/failed document (linked to
// its valid replacement, or confirmed nothing to link) without closing the PO.
export async function ackEdiTransaction({ transactionId, linkedTransactionId, note }) {
  const res = await fetch(`/api/edi/transactions/${transactionId}/ack`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedTransactionId, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function unackEdiTransaction(transactionId) {
  const res = await fetch(`/api/edi/transactions/${transactionId}/ack`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Doc seasons — free-text season tag on any OC/PO/EDI PO (doc_type keeps
// them separate — see db/schema.sql doc_seasons).
export async function fetchSeasons() {
  const res = await fetch('/api/seasons')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function saveSeason({ docType, docNumber, season }) {
  const res = await fetch('/api/seasons', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docType, docNumber, season }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Make an EDI PO into a task (the manual "＋ Task" button). Idempotent per PO.
export async function createEdiTask(businessNumber) {
  const res = await fetch(`/api/edi/${encodeURIComponent(businessNumber)}/task`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Search known document numbers across every record type (link picker).
export async function fetchDocNumbers(q) {
  const res = await fetch(`/api/doc-numbers?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Document links — attach any doc/transaction to any other.
export async function fetchLinksFor(docType, docNumber) {
  const res = await fetch(`/api/links?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(docNumber)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function addDocLink({ aType, aNumber, bType, bNumber, label }) {
  const res = await fetch('/api/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aType, aNumber, bType, bNumber, label }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function deleteDocLink(id) {
  const res = await fetch(`/api/links/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Assign an EDI order's inbound production PO (or mark from-stock).
export async function setEdiSupply({ businessNumber, poNumber, fromStock, note }) {
  const res = await fetch(`/api/edi/${encodeURIComponent(businessNumber)}/supply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poNumber, fromStock, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function clearEdiSupply(businessNumber) {
  const res = await fetch(`/api/edi/${encodeURIComponent(businessNumber)}/supply`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Manually-entered EDI orders (shipped/aged out of the searches). Always shown
// in their own section, flagged as unconfirmed.
export async function addEdiManualOrder({ businessNumber, tradingPartner, note }) {
  const res = await fetch('/api/edi/manual-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessNumber, tradingPartner, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function removeEdiManualOrder(id) {
  const res = await fetch(`/api/edi/manual-order/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Quest emails (Gmail-to-quest hologram transmissions). /sync pulls fresh
// messages from Gmail; read/character/label actions write back to the real
// inbox, so — like EDI/Allocations — every call returns the full refreshed
// list rather than needing a separate refetch.
export async function fetchQuestEmails() {
  const res = await fetch('/api/quest-emails')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function syncQuestEmails() {
  const res = await fetch('/api/quest-emails/sync', { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function markQuestEmailRead(id) {
  const res = await fetch(`/api/quest-emails/${id}/read`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function assignQuestEmailCharacter({ id, characterId, fromAddress }) {
  const res = await fetch(`/api/quest-emails/${id}/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, fromAddress }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function applyQuestEmailLabel({ id, label }) {
  const res = await fetch(`/api/quest-emails/${id}/label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function dismissQuestEmail(id, dismissed = true) {
  const res = await fetch(`/api/quest-emails/${id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dismissed }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Quest tasks — a transmission promoted to something durable. Creating one
// dismisses the source transmission (see createTaskFromQuestEmail), so its
// response includes the refreshed emails list alongside the new tasks list.
export async function fetchQuestTasks() {
  const res = await fetch('/api/quest-tasks')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function createQuestTask(emailId) {
  const res = await fetch(`/api/quest-emails/${emailId}/create-task`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// The user's Gmail labels (label picker).
export async function fetchGmailLabels() {
  const res = await fetch('/api/gmail/labels')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Spam — Gmail SPAM label + dismissed here, one click.
export async function spamQuestEmail(id) {
  const res = await fetch(`/api/quest-emails/${id}/spam`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// The Datapad ledger — all email notes, standalone.
export async function fetchLedgerNotes() {
  const res = await fetch('/api/ledger-notes')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Note ledger — save/clear the personal summary note on an email.
export async function saveQuestEmailNote(emailId, note) {
  const res = await fetch(`/api/quest-emails/${emailId}/note`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// One-click acknowledge — a created-and-completed acknowledgment task.
export async function acknowledgeQuestEmail(emailId) {
  const res = await fetch(`/api/quest-emails/${emailId}/acknowledge`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// A task the user writes themselves (no source email).
export async function createManualTask(fields) {
  const res = await fetch('/api/quest-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Bulk-create tasks from selected orders / PO groups (Mission Quests).
export async function createTasksBulk(tasks) {
  const res = await fetch('/api/quest-tasks/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function completeQuestTask(id, done = true) {
  const res = await fetch(`/api/quest-tasks/${id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function setTaskNeeds({ id, needsType, needsNote, netsuiteDocType, netsuiteDocNumber }) {
  const res = await fetch(`/api/quest-tasks/${id}/needs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ needsType, needsNote, netsuiteDocType, netsuiteDocNumber }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function setTaskUrgency(id, urgency) {
  const res = await fetch(`/api/quest-tasks/${id}/urgency`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urgency }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function setTaskCharacter(id, characterId) {
  const res = await fetch(`/api/quest-tasks/${id}/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function setTaskChecklistItem(id, itemKey, done) {
  const res = await fetch(`/api/quest-tasks/${id}/checklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey, done }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// On-demand thread context — fetched only when a transmission is expanded.
export async function fetchQuestEmailThread(id) {
  const res = await fetch(`/api/quest-emails/${id}/thread`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function searchQuestArchive(q) {
  const res = await fetch(`/api/quest-search?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// date: 'YYYY-MM-DD', omit for a general recent feed.
export async function fetchQuestActivity(date) {
  const res = await fetch(`/api/quest-activity${date ? `?date=${date}` : ''}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Upcoming Google Calendar events (in-app calendar + holocalls).
export async function fetchCalendarEvents() {
  const res = await fetch('/api/calendar/events')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// ── Custody scans (QR labels) — direction 'OUT' | 'IN' ──────────────────────
export async function recordCustodyScan({ docNumber, direction, note, allowRescan }) {
  const res = await fetch('/api/custody/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docNumber, direction, note, allowRescan }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Box capture — carton weight + L×W×H for an IF (all but ifNumber optional).
export async function recordFulfillmentBox(box) {
  const res = await fetch('/api/custody/box', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(box),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Custody register — IFs scanned into custody but not yet departed.
export async function fetchCustodyRegister() {
  const res = await fetch('/api/custody/register')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Clear a custody item off the register (departed, or a stale/orphaned scan).
export async function clearCustodyItem({ docType, docNumber }) {
  const res = await fetch('/api/custody/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docType, docNumber }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Permanently delete a custody scan — by event id (one scan) or by doc (all of
// that IF/DC carton's custody events). Destructive; the UI warns first.
export async function deleteCustodyScan({ id, docType, docNumber }) {
  const res = await fetch('/api/custody/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, docType, docNumber }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Order-events ledger feed. opts: { date, docNumber, soNumber } (all optional)
export async function fetchOrderEvents(opts = {}) {
  const params = new URLSearchParams(Object.entries(opts).filter(([, v]) => v))
  const qs = params.toString()
  const res = await fetch('/api/events' + (qs ? `?${qs}` : ''))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Universal notes — the note-on-anything system (Nima, 2026-07-20).
export async function fetchNotesFor(docType, docNumber) {
  const res = await fetch(`/api/notes?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(docNumber)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function fetchAllNotes() {
  const res = await fetch('/api/notes')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function addNote({ docType, docNumber, note, linkedDocType, linkedDocNumber }) {
  const res = await fetch('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docType, docNumber, note, linkedDocType, linkedDocNumber }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function deleteNote(id) {
  const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// ── EDI routing + BOL (Nima, 2026-07-22) ─────────────────────────────────────
export async function fetchRouting() {
  const res = await fetch('/api/routing')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

export async function assignRoutingBol(shipment) {
  const res = await fetch('/api/routing/assign-bol', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shipment),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function voidRoutingShipment(id) {
  const res = await fetch(`/api/routing/shipment/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Phase 2 — reference capture
export async function setShipmentRefs(id, fields) {
  const res = await fetch(`/api/routing/shipment/${id}/refs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function saveRoutingAuth(body) {
  const res = await fetch('/api/routing/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function deleteRoutingAuth(authNumber) {
  const res = await fetch(`/api/routing/auth/${encodeURIComponent(authNumber)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Phase 3 — VICS BOL PDF + Drive filing
export function bolPdfUrl(shipmentId) {
  return `/api/routing/shipment/${shipmentId}/bol.pdf`
}

export async function fileBolToDrive(shipmentId) {
  const res = await fetch(`/api/routing/shipment/${shipmentId}/file-to-drive`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Manual PO holds — pull a PO-DC out of routing
export async function holdRoutingPo({ po, dc, note }) {
  const res = await fetch('/api/routing/hold', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ po, dc, note }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function releaseRoutingPo(po, dc) {
  const res = await fetch(`/api/routing/hold/${encodeURIComponent(po)}/${encodeURIComponent(dc)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Master BOL (multi-DC via merge center)
export function masterBolPdfUrl(authNumber) {
  return `/api/routing/auth/${encodeURIComponent(authNumber)}/master-bol.pdf`
}
export async function fileMasterToDrive(authNumber) {
  const res = await fetch(`/api/routing/auth/${encodeURIComponent(authNumber)}/master-to-drive`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Email → document links (reusable across docs)
export async function fetchEmailLinks(docType, docNumber) {
  const res = await fetch(`/api/email-links?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(docNumber)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
export async function searchLinkableEmails(q) {
  const res = await fetch(`/api/email-links/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
export async function addEmailLink(body) {
  const res = await fetch('/api/email-links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}
export async function deleteEmailLink(id, docType, docNumber) {
  const res = await fetch(`/api/email-links/${id}?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(docNumber)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
