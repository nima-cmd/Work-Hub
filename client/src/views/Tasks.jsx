import { useState } from 'react'
import { TaskItem, taskOrigin, ORIGIN_LABEL } from '../lib.jsx'

// Tasks view (Nima, 2026-07-21) — the dedicated task list, a peer to
// Transmissions and EDI. Every quest_task in one place, grouped by where it
// came from (Protocol / Transmission / EDI / Manual), each expandable in place
// with mark-done, Gmail, its linked NetSuite doc, and doc-links. This is the
// single home a task click from any panel jumps to, and where the SO/EDI
// "◉ Task" links land — so you can always see a task already exists instead of
// building it twice.

const ORIGIN_ORDER = ['transmission', 'edi', 'protocol', 'manual']

export default function Tasks({ tasks = [], onNavigate = () => {}, onRefresh }) {
  const [filter, setFilter] = useState('open')   // 'open' | 'all'
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState(null)

  const needle = q.trim().toLowerCase()
  const shown = tasks.filter((t) => {
    if (filter === 'open' && t.status !== 'open') return false
    if (!needle) return true
    return [t.subject, t.snippet, t.character?.name, t.fromName, t.netsuiteDocNumber]
      .some((s) => (s || '').toLowerCase().includes(needle))
  })

  const openCount = tasks.filter((t) => t.status === 'open').length
  const doneCount = tasks.length - openCount

  const groups = ORIGIN_ORDER
    .map((key) => ({ key, label: ORIGIN_LABEL[key], items: shown.filter((t) => taskOrigin(t) === key) }))
    .filter((g) => g.items.length)

  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))

  return (
    <div className="tasksView">
      <div className="tasksBar">
        <div className="tasksStats">
          <span className="tstat"><b>{openCount}</b> open</span>
          <span className="tstat done"><b>{doneCount}</b> done</span>
        </div>
        <div className="tasksFilters">
          <button className={filter === 'open' ? 'btn' : 'btnGhost'} onClick={() => setFilter('open')}>Open</button>
          <button className={filter === 'all' ? 'btn' : 'btnGhost'} onClick={() => setFilter('all')}>All</button>
        </div>
        <input className="tasksSearch" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {!groups.length && <div className="empty">{filter === 'open' ? 'No open tasks — the crew is idle.' : 'No tasks match.'}</div>}

      {groups.map((g) => (
        <section key={g.key} className="taskGroup">
          <div className="taskGroupHead">{g.label} <span className="sectorCount">{g.items.length}</span></div>
          <div className="taskGroupList">
            {g.items.map((t) => (
              <TaskItem key={t.id} t={t} expanded={openId === t.id} onToggle={toggle}
                        onRefresh={onRefresh} onNavigate={onNavigate} showOpen={false} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
