import { useState } from 'react'
import { TaskItem, taskOrigin, ORIGIN_LABEL } from '../lib.jsx'

// Ledger (Nima, 2026-07-28) — the chronicle of COMPLETED work. Tasks only ever
// disappeared behind the Tasks "All" toggle (mixed in with open ones); there was
// no archive you could scroll as a record of "what got done, and when". This is
// that record: every done quest_task, newest first, grouped by the day it was
// completed. Pure client-side over the tasks payload the app already loads
// (fetchQuestTasks returns done tasks too, each with completedAt) — no new
// endpoint. Reuses TaskItem so each entry still expands with its Gmail link,
// linked NetSuite doc, and doc-links, exactly like the Tasks tab.

// Group key = local YYYY-MM-DD so entries fall on the day they were finished in
// Nima's timezone (not UTC). Undated done tasks (shouldn't happen — completedAt
// is always stamped — but be safe) collect under "Undated".
function dayKey(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key) {
  if (!key) return 'Undated'
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today - date) / 86_400_000)
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff > 1 ? `${diff}d ago` : ''
  const full = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
  return rel ? `${full} · ${rel}` : full
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

export default function Ledger({ tasks = [], onNavigate = () => {}, onRefresh }) {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState(null)

  const needle = q.trim().toLowerCase()
  const done = tasks
    .filter((t) => t.status === 'done')
    .filter((t) => {
      if (!needle) return true
      return [t.subject, t.snippet, t.character?.name, t.fromName, t.netsuiteDocNumber, ORIGIN_LABEL[taskOrigin(t)]]
        .some((s) => (s || '').toLowerCase().includes(needle))
    })
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))

  // Group into ordered day buckets (already newest-first from the sort above).
  const days = []
  const byKey = new Map()
  for (const t of done) {
    const key = dayKey(t.completedAt)
    let g = byKey.get(key)
    if (!g) { g = { key, items: [] }; byKey.set(key, g); days.push(g) }
    g.items.push(t)
  }

  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))

  return (
    <div className="ledgerView">
      <div className="tasksBar">
        <div className="tasksStats">
          <span className="tstat done"><b>{done.length}</b> completed</span>
          <span className="tstat"><b>{days.length}</b> {days.length === 1 ? 'day' : 'days'}</span>
        </div>
        <input className="tasksSearch" placeholder="Search the ledger…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {!done.length && <div className="empty">Nothing logged yet — completed work will chronicle here.</div>}

      {days.map((g) => (
        <section key={g.key || 'undated'} className="ledgerDay">
          <div className="ledgerDayHead">
            <span className="ledgerDayLabel">{dayLabel(g.key)}</span>
            <span className="sectorCount">{g.items.length}</span>
          </div>
          <div className="taskGroupList">
            {g.items.map((t) => (
              <div key={t.id} className="ledgerRow">
                <span className="ledgerTime">{fmtTime(t.completedAt)}</span>
                <div className="ledgerEntry">
                  <TaskItem t={t} expanded={openId === t.id} onToggle={toggle}
                            onRefresh={onRefresh} onNavigate={onNavigate} showOpen={false} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
