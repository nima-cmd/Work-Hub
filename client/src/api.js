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
