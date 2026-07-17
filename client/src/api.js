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

// ── Custody scans (QR labels) — direction 'OUT' | 'IN' ──────────────────────
export async function recordCustodyScan({ docNumber, direction, note }) {
  const res = await fetch('/api/custody/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docNumber, direction, note }),
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
