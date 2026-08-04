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
export async function resolveEdiPo({ businessNumber, closed, cancelled, netsuiteRef, note, reviewState }) {
  const res = await fetch('/api/edi/resolution', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessNumber, closed, cancelled, netsuiteRef, note, reviewState }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

export async function unresolveEdiPo(businessNumber) {
  const res = await fetch(`/api/edi/resolution/${encodeURIComponent(businessNumber)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// New-850 arrival alerts — undismissed POs the cron detected as freshly arrived.
export async function fetchEdiArrivals() {
  const res = await fetch('/api/edi/arrivals')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// transactionId omitted → dismiss all (clears the whole banner).
export async function dismissEdiArrival(transactionId) {
  const res = await fetch('/api/edi/arrivals/dismiss', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transactionId ? { transactionId } : {}),
  })
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

// ── Daily Flight Plan (Nima, 2026-07-28) ─────────────────────────────────────
const jsonPost = async (url, body, method = 'POST') => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Set a task's real due time (ISO string | null) and/or estimate (min | null).
export async function setTaskSchedule(id, { dueAt, durationMin } = {}) {
  return jsonPost(`/api/quest-tasks/${id}/schedule`, { dueAt, durationMin })
}

// The day's persisted overrides (manual order + non-task check-offs).
export async function fetchDayPlan(date) {
  const res = await fetch(`/api/plan/${date}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
export async function reorderDayPlan(date, order) {
  return jsonPost(`/api/plan/${date}/reorder`, { order })
}
export async function resetDayPlan(date) {
  return jsonPost(`/api/plan/${date}/order`, undefined, 'DELETE')
}
export async function setPlanItemDone(date, itemId, done, label) {
  return jsonPost(`/api/plan/${date}/item/${encodeURIComponent(itemId)}/done`, { done, label })
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

// Departures counted as SHIPMENTS — one BOL is one departure however many item
// fulfilments it covers. Without this the Calendar showed 50 departures on
// 2026-07-30 when eight trucks left.
export async function fetchDepartures(opts = {}) {
  const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v)).toString()
  const res = await fetch('/api/departures' + (qs ? `?${qs}` : ''))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return (await res.json()).departures || []
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

// Pull the carton feed straight from NetSuite, then hand back the refreshed
// board. Returns { synced, routing } — the caller wants both: the board to
// render, and what changed to report.
export async function refreshRoutingFeed() {
  const res = await fetch('/api/routing/refresh', { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
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

export async function setShipmentShipped(id, shipped = true) {
  const res = await fetch(`/api/routing/shipment/${id}/shipped`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shipped }),
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

// Per-PO DC breakdown (routing feed ∪ custody scans) for the DC-tag button.
export async function fetchPoDcs() {
  const res = await fetch('/api/po-dcs')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Label / shipped-status reconciliation (Nima, 2026-07-30). Splits the Packed
// queue into its two OPPOSITE actions — "you already shipped this, go mark it"
// vs "this is still here, make a label" — plus the freight/BOL lane, which is
// kept separate because it never carries a parcel tracking number.
export async function fetchLabelGaps() {
  const res = await fetch('/api/label-gaps')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Outbound EDI documents that never reached the partner (Nima, 2026-08-01).
// NetSuite marks the fulfilment 856-synced while Orderful still holds the
// transaction undelivered, so nothing complains — this is the only place it shows.
export async function fetchEdiDeliveryGaps() {
  const res = await fetch('/api/edi-delivery-gaps')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Pull fresh data from NetSuite on demand (Nima, 2026-07-31) — the button next
// to Import CSV. 409 means NetSuite is at its concurrent-request limit, i.e.
// Celigo is mid-run and has priority; that is a wait, not a failure, so it's
// returned as a distinct `busy` shape rather than thrown as an error.
// Starts the pull and returns immediately — a full refresh is ~93s, too long to
// hold a request open through Render. Poll netsuiteRefreshStatus for the result.
export async function refreshNetsuite() {
  const res = await fetch('/api/netsuite/refresh', { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (res.status === 409) return { busy: true, ...body }
  if (!res.ok) throw new Error(body.error || `API ${res.status}`)
  return body
}

export async function netsuiteRefreshStatus() {
  const res = await fetch('/api/netsuite/refresh')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Carton-level ASN reconciliation (Nima, 2026-07-31) — every carton that shipped
// vs every SSCC on a DELIVERED 856. The sibling of the pack check one level down:
// that one asks whether every unit made it into a box, this asks whether every box
// that left was announced. Reads the last scheduled run; the run is a sync.
export async function fetchAsnCartons() {
  const res = await fetch('/api/asn-cartons')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Forces a run, ignoring the 6-hour cadence. Slow on purpose — it may have 856
// bodies to harvest and two SuiteQL queries to make.
export async function refreshAsnCartons() {
  const res = await fetch('/api/asn-cartons/refresh', { method: 'POST' })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Catalogue upload tracking (Nima, 2026-07-27)
export async function fetchCatalogueGaps() {
  const res = await fetch('/api/catalogue/gaps')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
export const catalogueAddFileUrl = () => '/api/catalogue/add-file.csv'

// Scanner → Drive (Nima, 2026-07-29). Segment the scan client-side, ask the
// server for the filing plan, then upload each split.
export async function planScanFiling(segments) {
  const res = await fetch('/api/scan/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}
// `ifNumber`/`soNumber`/`po`/`dc` are the identity the plan already resolved.
// They ride along so the server can record the filing against the right
// document — without them the upload succeeds and the ledger learns nothing,
// which is the state step 7 was in until now.
export async function fileScannedDoc({ partner, pos, filename, pdfBase64, root, ifNumber, soNumber, po, dc }) {
  const res = await fetch('/api/scan/file-to-drive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partner, pos, filename, pdfBase64, root, ifNumber, soNumber, po, dc }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `API ${res.status}`)
  return res.json()
}

// Step 7's queue — { due, backlog, counts, since }.
export async function fetchUnfiledPaper() {
  const res = await fetch('/api/filing/unfiled')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Inbound containers — { containers, unreconciled, undated, counts }.
export async function fetchInboundContainers() {
  const res = await fetch('/api/inbound/containers')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}


// Did the scheduled syncs actually RUN? Distinct from fetchFreshness, which
// reports how old the source data is — a stopped sync looks like a quiet day.
export async function fetchSyncHealth() {
  const res = await fetch('/api/sync-health')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// The order ledger. Window mode: { from, to, type[], docType, q, limit }.
export async function fetchLedger(opts = {}) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.set(k, v)
  }
  const qs = p.toString()
  const res = await fetch('/api/ledger' + (qs ? `?${qs}` : ''))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// One order's complete history — every event naming the SO or any document
// hanging off it, oldest first.
export async function fetchOrderLedger(soNumber) {
  const res = await fetch('/api/ledger?so=' + encodeURIComponent(soNumber))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// One PO's complete document trail — the dated 850 → SO → IF → 856 → 810 story,
// resolved across both the NetSuite and the EDI sides.
export async function fetchPoLedger(poNumber) {
  const res = await fetch('/api/ledger?po=' + encodeURIComponent(poNumber))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Per-day ledger counts for the Calendar's dots.
export async function fetchLedgerDaily({ from = null, to = null } = {}) {
  const p = new URLSearchParams()
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const qs = p.toString()
  const res = await fetch('/api/ledger/daily' + (qs ? `?${qs}` : ''))
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Health — what's configured, what's arriving. Returns booleans and variable
// NAMES only; the server never sends a credential value.
export async function fetchHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

// Overdue invoices — a DIAGNOSTIC, never a shipping gate (Nima, 2026-08-04:
// "while it doesn't directly fall into our job it's nice to know"). An overdue
// invoice means either the money arrived and wasn't posted, or we never asked
// for it — and on the EDI lane the second is checkable against the 810.
export async function fetchOverdueInvoices() {
  const res = await fetch('/api/overdue-invoices')
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}
