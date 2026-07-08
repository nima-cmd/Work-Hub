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
