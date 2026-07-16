import { useState, useEffect, useRef } from 'react'
import {
  fetchQuestEmails, syncQuestEmails, markQuestEmailRead,
  assignQuestEmailCharacter, applyQuestEmailLabel, dismissQuestEmail,
  fetchQuestTasks, createQuestTask, completeQuestTask,
  setTaskNeeds, setTaskUrgency, setTaskCharacter, setTaskChecklistItem, fetchQuestEmailThread, searchQuestArchive, fetchQuestActivity,
} from '../api.js'
import { imagesFor } from '../data/characterImages.js'

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}

const isUrl = (s) => /^https?:\/\//i.test((s || '').trim())
const todayStr = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

// Mirrors src/model/netsuiteDocs.js — PO/SO/IF/TO prefixes are confirmed
// elsewhere in this codebase; IR/IT are best-guess pending Nima confirming
// against live NetSuite (the NetSuite MCP connector was down when this was built).
const NETSUITE_DOC_TYPES = [
  { value: 'PO', label: 'Purchase Order' },
  { value: 'SO', label: 'Sales Order' },
  { value: 'IF', label: 'Item Fulfillment' },
  { value: 'IR', label: 'Item Receipt' },
  { value: 'IT', label: 'Inventory Transfer' },
  { value: 'TO', label: 'Transfer Order' },
]

const NEEDS_OPTIONS = [
  { value: 'none', label: 'Nothing needed yet' },
  { value: 'reply', label: 'Reply needed' },
  { value: 'acknowledgment', label: 'Acknowledgment needed' },
  { value: 'file', label: 'File needed' },
  { value: 'netsuite_doc', label: 'NetSuite document needed' },
]
const URGENCY_OPTIONS = [
  { value: '', label: 'No urgency set' },
  { value: 'lo', label: 'Low' },
  { value: 'mid', label: 'Medium' },
  { value: 'hi', label: 'High' },
]
const URGENCY_SEV = { hi: 'sev-hi', mid: 'sev-mid', lo: 'sev-lo' }

// Shared avatar so the hologram scan-in/distortion animation looks identical
// wherever it's used — a task is meant to keep the same "who delivered this"
// identity as its source transmission. `small` is for dense single-line
// contexts (the activity journal) where the full square portrait would be
// disproportionate.
function HoloAvatar({ characterId, name, small }) {
  const imgs = imagesFor(characterId)
  return imgs.length
    ? (
      <div className={'holoImgWrap' + (small ? ' sm' : '')}>
        <img src={imgs[0]} alt={name || ''} className="holoImg" />
        {/* Same image again, clipped to a thin band that sweeps via CSS
            (holoWarpBand) — creates the "scanline warps the image, doesn't
            erase it" look without ever hiding the photo underneath. */}
        <img src={imgs[0]} alt="" aria-hidden="true" className="holoImgWarp" />
      </div>
    )
    : <div className={'holoPlaceholder' + (small ? ' sm' : '')}>{initials(name)}</div>
}

// Inbound Gmail messages, presented as sci-fi "hologram" transmissions from a
// roster character (src/model/characters.js) — Nima's "Help me Obi-Wan
// Kenobi" framing (2026-07-15). Whole inbox is in scope; narrowing happens
// later via dismiss/labels as it's used day to day, not a pre-built taxonomy.
export default function Transmissions() {
  const [review, setReview] = useState(null)
  const [tasks, setTasks] = useState(null)
  const [err, setErr] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const [markedRead, setMarkedRead] = useState(() => new Set())
  const [busy, setBusy] = useState(null)
  const [threads, setThreads] = useState({}) // emailId -> prior messages, fetched on demand
  const [threadLoading, setThreadLoading] = useState(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [activity, setActivity] = useState(null)
  const syncingRef = useRef(false) // reentrancy guard for the poll timer below

  function load() {
    fetchQuestEmails().then(setReview).catch((e) => setErr(e.message))
    fetchQuestTasks().then(setTasks).catch((e) => setErr(e.message))
    fetchQuestActivity(todayStr()).then(setActivity).catch(() => {})
  }
  useEffect(load, [])

  async function onSync() {
    if (syncingRef.current) return
    syncingRef.current = true
    setSyncing(true)
    setSyncMsg(null)
    setErr(null)
    try {
      const r = await syncQuestEmails()
      setSyncMsg(
        `Scanned ${r.fetched} unread message(s), ${r.upserted} new or updated` +
        (r.reconciled ? ` — ${r.reconciled} previously-unread email(s) have since been read and dropped off.` : '') +
        (r.autoClosed ? ` — ${r.autoClosed} reply-needed task(s) auto-closed (reply detected).` : '.'),
      )
      setReview({ emails: r.emails, characters: r.characters })
      if (r.autoClosed) {
        fetchQuestTasks().then(setTasks).catch(() => {})
        fetchQuestActivity(todayStr()).then(setActivity).catch(() => {})
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      syncingRef.current = false
      setSyncing(false)
    }
  }

  // Auto-checks while this view is open so you don't have to click "Check for
  // new transmissions" yourself — only runs while the tab/app is open, not a
  // true background job (this repo has no always-on deployed server).
  const POLL_MS = 5 * 60 * 1000
  useEffect(() => {
    const id = setInterval(onSync, POLL_MS)
    return () => clearInterval(id)
  }, [])

  async function runRead(id) {
    setMarkedRead((s) => new Set(s).add(id)) // optimistic — avoids re-firing on repeated expand/collapse
    try {
      // markQuestEmailRead's response is the server's freshly-filtered
      // (unread-only) list, which would now EXCLUDE this email and make the
      // card vanish mid-read. Patch just its isUnread flag locally instead —
      // it stays visible/actionable until the next sync or dismiss, which is
      // when "unread only" should actually take it out of view.
      await markQuestEmailRead(id)
      setReview((r) => ({ ...r, emails: r.emails.map((e) => (e.id === id ? { ...e, isUnread: false } : e)) }))
    } catch (e) {
      setErr(e.message)
      setMarkedRead((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }

  async function loadThread(email) {
    setThreadLoading(email.id)
    try {
      const msgs = await fetchQuestEmailThread(email.id)
      setThreads((t) => ({ ...t, [email.id]: msgs }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setThreadLoading(null)
    }
  }

  function toggle(email) {
    const isOpening = !expanded.has(email.id)
    setExpanded((s) => {
      const next = new Set(s)
      isOpening ? next.add(email.id) : next.delete(email.id)
      return next
    })
    if (!isOpening) return
    if (email.isUnread && !markedRead.has(email.id)) runRead(email.id)
    if (email.threadId && !threads[email.id]) loadThread(email)
  }

  async function onReassign(email, characterId) {
    setBusy(email.id)
    setErr(null)
    try {
      setReview(await assignQuestEmailCharacter({ id: email.id, characterId, fromAddress: email.fromAddress }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onLabel(email) {
    const label = window.prompt('Gmail label to apply to this message:')
    if (!label) return
    setBusy(email.id)
    setErr(null)
    try {
      setReview(await applyQuestEmailLabel({ id: email.id, label }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onDismiss(email) {
    if (!window.confirm('Dismiss this transmission? It stays untouched in Gmail — just hidden here.')) return
    setBusy(email.id)
    setErr(null)
    try {
      setReview(await dismissQuestEmail(email.id))
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  function refreshActivity() {
    fetchQuestActivity(todayStr()).then(setActivity).catch(() => {})
  }

  // Promotes a transmission to a durable task — it keeps the character/
  // subject/snippet, and the source transmission is dismissed (its job as a
  // transmission is done; the task is what persists from here).
  async function onCreateTask(email) {
    setBusy(email.id)
    setErr(null)
    try {
      const r = await createQuestTask(email.id)
      setReview({ emails: r.emails, characters: r.characters })
      setTasks(r.tasks)
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onCompleteTask(task, done) {
    setBusy(`task-${task.id}`)
    setErr(null)
    try {
      setTasks(await completeQuestTask(task.id, done))
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onNeedsChange(task, patch) {
    setBusy(`task-${task.id}`)
    setErr(null)
    try {
      setTasks(await setTaskNeeds({
        id: task.id,
        needsType: patch.needsType ?? task.needsType,
        needsNote: patch.needsNote ?? task.needsNote,
        netsuiteDocType: patch.netsuiteDocType ?? task.netsuiteDocType,
        netsuiteDocNumber: patch.netsuiteDocNumber ?? task.netsuiteDocNumber,
      }))
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onUrgencyChange(task, urgency) {
    setBusy(`task-${task.id}`)
    setErr(null)
    try {
      setTasks(await setTaskUrgency(task.id, urgency || null))
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onTaskCharacterChange(task, characterId) {
    setBusy(`task-${task.id}`)
    setErr(null)
    try {
      setTasks(await setTaskCharacter(task.id, characterId))
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onChecklistToggle(task, itemKey, done) {
    setBusy(`task-${task.id}`)
    setErr(null)
    try {
      setTasks(await setTaskChecklistItem(task.id, itemKey, done))
      refreshActivity()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onUndismiss(email) {
    setBusy(email.id)
    setErr(null)
    try {
      await dismissQuestEmail(email.id, false)
      setSearchResults((r) => (r ? { ...r, emails: r.emails.map((e) => (e.id === email.id ? { ...e, dismissed: false } : e)) } : r))
      load() // may now show up in the active transmissions list, if still unread
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Archive search — deliberately separate from the active lists above, since
  // it's meant to surface dismissed emails and done tasks too.
  async function onSearch(ev) {
    ev.preventDefault()
    if (!searchQ.trim()) return setSearchResults(null)
    setSearching(true)
    setErr(null)
    try {
      setSearchResults(await searchQuestArchive(searchQ.trim()))
    } catch (e) {
      setErr(e.message)
    } finally {
      setSearching(false)
    }
  }

  if (err && !review) return <div className="banner error">⚠ Couldn’t load transmissions: {err}</div>
  if (!review) return <div className="banner">Loading transmissions…</div>

  const unreadCount = review.emails.filter((e) => e.isUnread).length

  return (
    <div className="allocWrap">
      {err && <div className="banner error">⚠ {err}</div>}
      {syncMsg && <div className="banner ok">{syncMsg}</div>}

      <div className="allocStats">
        <span className="pill">{review.emails.length} transmissions</span>
        <span className="pill danger">{unreadCount} unread</span>
        <button className="btnGhost" disabled={syncing} onClick={onSync}>
          {syncing ? 'Scanning…' : '↻ Check for new transmissions'}
        </button>
      </div>

      <form onSubmit={onSearch} style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        <input
          className="qtyInput" style={{ width: 320 }}
          placeholder="Search all transmissions & tasks (incl. dismissed/done)"
          value={searchQ} onChange={(ev) => setSearchQ(ev.target.value)}
        />
        <button className="btnGhost" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        {searchResults && (
          <button className="btnGhost" type="button" onClick={() => { setSearchResults(null); setSearchQ('') }}>Clear</button>
        )}
      </form>

      {searchResults && (
        <section style={{ marginBottom: 28 }}>
          <h2>Search results <span className="count">{searchResults.emails.length + searchResults.tasks.length}</span></h2>
          {!searchResults.emails.length && !searchResults.tasks.length && <div className="empty">No matches.</div>}
          {!!searchResults.emails.length && (
            <>
              <p className="hint">Emails (including dismissed)</p>
              <div className="holoList">
                {searchResults.emails.map((e) => (
                  <div key={e.id} className="hologram">
                    <div className="holoCardBody">
                      <HoloAvatar characterId={e.characterId} name={e.character?.name} />
                      <div className="holoContent">
                        <div className="holoHead">
                          <div>
                            <div className="holoName">{e.character?.name || 'Unknown Messenger'}</div>
                          </div>
                          <div className="holoMeta">
                            {e.dismissed && <span className="flag">dismissed</span>}
                            <span className="cust">{e.receivedAt ? new Date(e.receivedAt).toLocaleString() : ''}</span>
                          </div>
                        </div>
                        <div className="holoSubject">{e.subject}</div>
                        <p className="holoSnippet">{e.snippet}</p>
                        {e.dismissed && (
                          <div className="holoActions">
                            <button className="btnGhost" disabled={busy === e.id} onClick={() => onUndismiss(e)}>Undismiss</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {!!searchResults.tasks.length && (
            <>
              <p className="hint">Tasks (including done)</p>
              <div className="holoList">
                {searchResults.tasks.map((t) => (
                  <div key={t.id} className={'hologram taskCard' + (t.status === 'done' ? ' done' : '')}>
                    <div className="holoCardBody">
                      <HoloAvatar characterId={t.characterId} name={t.character?.name} />
                      <div className="holoContent">
                        <div className="holoHead">
                          <div>
                            <div className="holoName">{t.character?.name || 'Unknown Messenger'}</div>
                          </div>
                          <div className="holoMeta">
                            <span className={'flag ' + (t.status === 'done' ? 'sev-lo' : 'sev-mid')}>{t.status}</span>
                          </div>
                        </div>
                        <div className="holoSubject">{t.subject}</div>
                        <p className="holoSnippet">{t.snippet}</p>
                        {t.status === 'done' && (
                          <div className="holoActions">
                            <button className="btnGhost" disabled={busy === `task-${t.id}`} onClick={() => onCompleteTask(t, false)}>Reopen</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {!review.emails.length && (
        <div className="empty">No transmissions yet — click "Check for new transmissions" to scan your inbox.</div>
      )}

      <div className="holoList">
        {review.emails.map((e) => {
          const isOpen = expanded.has(e.id)
          return (
            <div key={e.id} className={'hologram' + (e.isUnread ? ' unread' : '')}>
              <div className="holoCardBody">
                <HoloAvatar characterId={e.characterId} name={e.character?.name} />
                <div className="holoContent">
                  <div className="holoHead" onClick={() => toggle(e)}>
                    <div>
                      <div className="holoName">{e.character?.name || 'Unknown Messenger'}</div>
                      <div className="holoUniverse">{e.character?.universe}</div>
                    </div>
                    <div className="holoMeta">
                      {e.isUnread && <span className="badge edi">NEW</span>}
                      <span className="cust">{e.receivedAt ? new Date(e.receivedAt).toLocaleString() : '—'}</span>
                      <span>{isOpen ? '▾' : '▸'}</span>
                    </div>
                  </div>
                  <div className="holoSubject">{e.subject}</div>
                  {isOpen && (
                    <div className="holoBody">
                      <p className="holoSnippet" style={{ whiteSpace: 'pre-wrap' }}>{e.body || e.snippet}</p>
                      <div className="cust">From {e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress || 'unknown sender'}</div>

                      {threadLoading === e.id && <p className="hint">Loading earlier messages in this thread…</p>}
                      {!!threads[e.id]?.length && (
                        <div className="holoThread">
                          <p className="hint">Earlier in this thread ({threads[e.id].length})</p>
                          {threads[e.id].map((m) => (
                            <div key={m.id} className="holoThreadMsg">
                              <div className="cust">
                                {m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress || 'unknown sender'}
                                {m.receivedAt && ` · ${new Date(m.receivedAt).toLocaleString()}`}
                              </div>
                              <p className="holoSnippet" style={{ whiteSpace: 'pre-wrap' }}>{m.body || m.snippet}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="holoActions">
                        <select
                          className="qtyInput" style={{ width: 190 }} value={e.characterId || ''} disabled={busy === e.id}
                          onChange={(ev) => onReassign(e, ev.target.value)}
                        >
                          {review.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button className="btn" disabled={busy === e.id} onClick={() => onCreateTask(e)}>Create task</button>
                        <button className="btnGhost" disabled={busy === e.id} onClick={() => onLabel(e)}>Apply label</button>
                        <button className="btnGhost" disabled={busy === e.id} onClick={() => onDismiss(e)}>Dismiss</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <section style={{ marginTop: 28 }}>
        <h2>Tasks {tasks && <span className="count">{tasks.filter((t) => t.status === 'open').length}</span>}</h2>
        <p className="hint">Transmissions you've claimed as tasks — each keeps its messenger's image even after the original email is gone.</p>
        {!tasks?.length && <div className="empty">No tasks yet — use "Create task" on a transmission to start one.</div>}
        <div className="holoList">
          {tasks?.map((t) => (
            <div key={t.id} className={'hologram taskCard' + (t.status === 'done' ? ' done' : '')}>
              <div className="holoCardBody">
                <HoloAvatar characterId={t.characterId} name={t.character?.name} />
                <div className="holoContent">
                  <div className="holoHead">
                    <div>
                      <div className="holoName">{t.character?.name || 'Unknown Messenger'}</div>
                      <div className="holoUniverse">{t.character?.universe}</div>
                    </div>
                    <div className="holoMeta">
                      {t.urgency && <span className={'flag ' + URGENCY_SEV[t.urgency]}>{t.urgency}</span>}
                      <span className={'flag ' + (t.status === 'done' ? 'sev-lo' : 'sev-mid')}>{t.status === 'done' ? 'done' : 'open'}</span>
                      <span className="cust">{new Date(t.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="holoSubject">{t.subject}</div>
                  <p className="holoSnippet">{t.snippet}</p>
                  {t.completionMode === 'verified' && !!t.checklist?.length && (
                    <div className="holoActions" style={{ flexWrap: 'wrap', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                      <p className="hint" style={{ margin: '0 0 2px' }}>Manual checklist (can't be auto-verified from here):</p>
                      {t.checklist.map((c) => (
                        <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <input
                            type="checkbox" checked={!!c.done} disabled={busy === `task-${t.id}`}
                            onChange={(ev) => onChecklistToggle(t, c.key, ev.target.checked)}
                          />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  )}

                  <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                    <select
                      className="qtyInput" style={{ width: 190 }} value={t.characterId || ''} disabled={busy === `task-${t.id}`}
                      onChange={(ev) => onTaskCharacterChange(t, ev.target.value)}
                    >
                      {review.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>

                  {t.completionMode === 'standard' && (<>
                  <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                    <select
                      className="qtyInput" style={{ width: 140 }} value={t.urgency || ''} disabled={busy === `task-${t.id}`}
                      onChange={(ev) => onUrgencyChange(t, ev.target.value)}
                    >
                      {URGENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select
                      className="qtyInput" style={{ width: 190 }} value={t.needsType || 'none'} disabled={busy === `task-${t.id}`}
                      onChange={(ev) => {
                        const needsType = ev.target.value
                        // The doc-type sub-select below defaults its DISPLAY to
                        // 'SO' when unset — persist that default immediately so
                        // it's actually saved, not just shown, the moment this
                        // switches to netsuite_doc (otherwise a number typed
                        // before ever touching that select saves unprefixed).
                        onNeedsChange(t, needsType === 'netsuite_doc' ? { needsType, netsuiteDocType: t.netsuiteDocType || 'SO' } : { needsType })
                      }}
                    >
                      {NEEDS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>

                  {/* reply: no free text — closes itself once a reply is detected in the thread; manual override available */}
                  {t.needsType === 'reply' && (
                    <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                      <span className="hint" style={{ margin: 0 }}>
                        Send your reply in Gmail — this auto-closes next sync once a reply is detected in the thread.
                      </span>
                      {t.status === 'open' && (
                        <button className="btnGhost" disabled={busy === `task-${t.id}`} onClick={() => onCompleteTask(t, true)}>
                          I already replied — mark done
                        </button>
                      )}
                    </div>
                  )}

                  {/* acknowledgment: optional free note on what was acknowledged */}
                  {t.needsType === 'acknowledgment' && (
                    <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                      <input
                        className="qtyInput" style={{ width: 260 }} placeholder="Note (optional)"
                        defaultValue={t.needsNote || ''} disabled={busy === `task-${t.id}`}
                        onBlur={(ev) => onNeedsChange(t, { needsNote: ev.target.value })}
                      />
                    </div>
                  )}

                  {/* file: a REFERENCE only (link or where-to-find-it note) — the app never stores the file itself */}
                  {t.needsType === 'file' && (
                    <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                      <input
                        className="qtyInput" style={{ width: 260 }} placeholder="Where to find it (link or note) — not stored here"
                        defaultValue={t.needsNote || ''} disabled={busy === `task-${t.id}`}
                        onBlur={(ev) => onNeedsChange(t, { needsNote: ev.target.value })}
                      />
                      {isUrl(t.needsNote) && <a href={t.needsNote} target="_blank" rel="noreferrer" className="btnGhost">Open ↗</a>}
                    </div>
                  )}

                  {/* netsuite_doc: type + number, normalized server-side (e.g. "1213" under Sales Order saves as "SO1213") */}
                  {t.needsType === 'netsuite_doc' && (
                    <div className="holoActions" style={{ flexWrap: 'wrap' }}>
                      <select
                        className="qtyInput" style={{ width: 170 }} value={t.netsuiteDocType || 'SO'} disabled={busy === `task-${t.id}`}
                        onChange={(ev) => onNeedsChange(t, { netsuiteDocType: ev.target.value })}
                      >
                        {NETSUITE_DOC_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <input
                        className="qtyInput" style={{ width: 140 }} placeholder="e.g. 1213 or SO1213"
                        defaultValue={t.netsuiteDocNumber || ''} disabled={busy === `task-${t.id}`}
                        onBlur={(ev) => onNeedsChange(t, { netsuiteDocNumber: ev.target.value })}
                      />
                      {t.netsuiteDocNumber && <span className="mono">{t.netsuiteDocNumber}</span>}
                    </div>
                  )}
                  </>) /* end completionMode === 'standard' */}

                  <div className="holoActions">
                    {t.status === 'open'
                      ? <button className="btn" disabled={busy === `task-${t.id}`} onClick={() => onCompleteTask(t, true)}>Mark done</button>
                      : <button className="btnGhost" disabled={busy === `task-${t.id}`} onClick={() => onCompleteTask(t, false)}>Reopen</button>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>Today's activity {activity && <span className="count">{activity.length}</span>}</h2>
        <p className="hint">A running log of what happened today — created, completed, reopened, reassigned. Also shows up on the Calendar.</p>
        {!activity?.length && <div className="empty">Nothing logged yet today.</div>}
        {!!activity?.length && (
          <div className="holoList">
            {activity.map((a) => (
              <div key={a.id} className="hologram" style={{ padding: 10 }}>
                <div className="holoHead" style={{ cursor: 'default' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <HoloAvatar characterId={a.characterId} name={null} small />
                    <div className="cust">{a.subject}</div>
                  </div>
                  <div className="holoMeta">
                    <span className="flag">{a.kind.replace('_', ' ')}</span>
                    <span className="cust">{new Date(a.createdAt).toLocaleTimeString()}</span>
                  </div>
                </div>
                {a.note && <p className="holoSnippet" style={{ margin: '6px 0 0' }}>{a.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
