import { useState, useEffect, useRef } from 'react'
import {
  fetchQuestEmails, syncQuestEmails, markQuestEmailRead,
  assignQuestEmailCharacter, applyQuestEmailLabel, dismissQuestEmail,
  fetchQuestTasks, createQuestTask, acknowledgeQuestEmail, saveQuestEmailNote, completeQuestTask, fetchGmailLabels, spamQuestEmail,
  setTaskNeeds, setTaskUrgency, setTaskCharacter, setTaskChecklistItem, fetchQuestEmailThread, searchQuestArchive, fetchQuestActivity,
  fetchFreshness, fetchNwFreshness, importCsv, createManualTask, fetchAffection,
} from '../api.js'
import { imagesFor } from '../data/characterImages.js'
import { speakLine, taskContext } from '../../../src/model/dialogue.js'
import TradingCard from '../lib/TradingCard.jsx'
import { fmtAge, LinkedText } from '../lib.jsx'

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}

const isUrl = (s) => /^https?:\/\//i.test((s || '').trim())
const gmailLink = (threadId, id) => `https://mail.google.com/mail/u/0/#all/${threadId || id}`
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
export default function Transmissions({ onNavigate } = {}) {
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

  // CSV-freshness state for Bugs' verified task: live per-source status +
  // NetSuite links, an in-task import, and her thank-you once things update
  // (Nima, 2026-07-17: "link and import live in the Bugs Task").
  const [fresh, setFresh] = useState(null)
  const [nwFresh, setNwFresh] = useState(null) // Naghedi-Warehouse Supabase freshness
  const [thanks, setThanks] = useState(null) // { taskId, msg }
  const [importing, setImporting] = useState(false)
  const [newTask, setNewTask] = useState(null) // null = form closed; object = open draft
  const [noteDraft, setNoteDraft] = useState(null) // { id, text } — the datapad entry being edited
  const [gmailLabels, setGmailLabels] = useState([]) // the user's real Gmail labels, for the picker
  const [inboxFilter, setInboxFilter] = useState('all') // 'all' (3-day window incl. read) | 'unread'
  const [affection, setAffection] = useState([])
  const importRef = useRef(null)
  const importTaskRef = useRef(null) // which task's import button opened the picker

  function load() {
    fetchQuestEmails().then(setReview).catch((e) => setErr(e.message))
    fetchQuestTasks().then(setTasks).catch((e) => setErr(e.message))
    fetchQuestActivity(todayStr()).then(setActivity).catch(() => {})
    fetchFreshness().then(setFresh).catch(() => {})
    fetchNwFreshness().then(setNwFresh).catch(() => {})
    fetchAffection().then(setAffection).catch(() => {})
    fetchGmailLabels().then(setGmailLabels).catch(() => {}) // best-effort; picker hides if empty
  }
  useEffect(load, [])

  // Bugs' thank-you, in her voice: enthusiastic if the whole board went
  // green, still appreciative (but pointing at what's left) if not.
  function bugsThanks(task, freshNow) {
    const still = (freshNow?.sources || []).filter((s) => s.status === 'stale' || s.status === 'missing')
    const name = task.character?.name || 'Your messenger'
    if (!still.length) {
      return name === 'Bugs Bunny'
        ? '“Eh, thanks Doc! All the manifests are current — that’s what I call a good haul. 🥕”'
        : `${name} says: “Thank you! Every export is current — all clear.”`
    }
    const list = still.map((s) => s.label).join(', ')
    return name === 'Bugs Bunny'
      ? `“Thanks Doc — that one’s in! Still waitin’ on: ${list}. 🥕”`
      : `${name} says: “Thanks — got it! Still waiting on: ${list}.”`
  }

  async function onTaskImportFiles(e) {
    const files = [...e.target.files]
    e.target.value = ''
    const task = importTaskRef.current
    if (!files.length || !task) return
    setImporting(true)
    setErr(null)
    setThanks(null)
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, text: await f.text(), lastModified: f.lastModified })),
      )
      const r = await importCsv(payload)
      const unrec = r.files.filter((f) => !f.recognized)
      const freshNow = await fetchFreshness()
      setFresh(freshNow)
      setThanks({
        taskId: task.id,
        msg:
          bugsThanks(task, freshNow) +
          (unrec.length ? ` (Not recognized: ${unrec.map((u) => u.name).join(', ')})` : ''),
      })
    } catch (e2) {
      setErr('Import failed: ' + e2.message)
    } finally {
      setImporting(false)
    }
  }

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

  async function onLabel(email, picked) {
    // picked comes from the label dropdown; '__new__' asks for a name and the
    // server get-or-creates it in Gmail (so new labels are born here too).
    const label = picked === '__new__' ? window.prompt('New Gmail label name:') : picked
    if (!label) return
    setBusy(email.id)
    setErr(null)
    try {
      setReview(await applyQuestEmailLabel({ id: email.id, label }))
      fetchGmailLabels().then(setGmailLabels).catch(() => {})
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  // One click, gone from both places: Gmail's own SPAM label + dismissed here.
  async function onSpam(email) {
    if (!window.confirm(`Mark as spam and clear? "${email.subject}"`)) return
    setBusy(email.id)
    setErr(null)
    try {
      const r = await spamQuestEmail(email.id)
      setReview({ emails: r.emails, characters: r.characters })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Explicit mark-read (writes Gmail + local) without opening the message.
  async function onMarkRead(email) {
    setBusy(email.id)
    setErr(null)
    try {
      const r = await markQuestEmailRead(email.id)
      setReview({ emails: r.emails, characters: r.characters })
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
    fetchAffection().then(setAffection).catch(() => {}) // completing a quest deepens the bond
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

  // One-click "seen and understood" (Nima, 2026-07-18): records a task that is
  // created AND completed in one motion, then dismisses the transmission — no
  // create-task → open → mark-done round trip for emails that only need an ack.
  async function onAcknowledge(email) {
    setBusy(email.id)
    setErr(null)
    try {
      const r = await acknowledgeQuestEmail(email.id)
      setReview({ emails: r.emails, characters: r.characters })
      setTasks(r.tasks)
      refreshActivity()
      fetchAffection().then(setAffection).catch(() => {})
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Note ledger (Nima, 2026-07-18): a personal summary/highlight per email,
  // for quick reference later — searchable, survives re-syncs, empty clears.
  async function onSaveNote() {
    if (!noteDraft) return
    setBusy(noteDraft.id)
    setErr(null)
    try {
      const r = await saveQuestEmailNote(noteDraft.id, noteDraft.text)
      setReview({ emails: r.emails, characters: r.characters })
      setNoteDraft(null)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function onSubmitManualTask(e) {
    e.preventDefault()
    if (!newTask?.subject?.trim()) return
    setBusy('new-task')
    setErr(null)
    try {
      setTasks(await createManualTask(newTask))
      setNewTask(null)
      refreshActivity()
    } catch (e2) {
      setErr(e2.message)
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
      {/* shared picker for the in-task CSV import (Bugs' freshness task) */}
      <input ref={importRef} type="file" accept=".csv" multiple hidden onChange={onTaskImportFiles} />

      {/* crew banner (Nima, 2026-07-20) — full cards live in their own Crew
          tab now; this is just a quick-glance strip up top. */}
      {!!affection.length && (
        <div className="crewBanner crewScroll" onClick={() => onNavigate?.('crew')} title="Open the Crew tab">
          {affection.map((a) => {
            const img = imagesFor(a.characterId)[0]
            return (
              <span key={a.characterId} className="crewChip">
                {img ? <img src={img} alt="" /> : <i>◈</i>}
                <b>{a.character?.name?.split(' ')[0] || ''}</b>
              </span>
            )
          })}
        </div>
      )}

      <div className="allocStats">
        <button className={'pill' + (inboxFilter === 'all' ? ' fresh' : '')} onClick={() => setInboxFilter('all')}>
          {review.emails.length} recent
        </button>
        <button className={'pill' + (inboxFilter === 'unread' ? ' fresh' : '') + (unreadCount ? ' danger' : '')} onClick={() => setInboxFilter('unread')}>
          {unreadCount} unread
        </button>
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
                        <p className="holoSnippet"><LinkedText text={t.snippet} /></p>
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
        {review.emails.filter((e) => inboxFilter === 'all' || e.isUnread).map((e) => {
          const isOpen = expanded.has(e.id)
          return (
            <div key={e.id} className={'hologram' + (e.isUnread ? ' unread' : ' read')}>
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
                  {/* Every control lives UP HERE next to the name (Nima,
                      2026-07-18) — usable from the compressed view, no
                      scrolling past a long thread to act on a transmission. */}
                  <div className="holoActions holoActionsTop">
                    <select
                      className="qtyInput compactSel" value={e.characterId || ''} disabled={busy === e.id}
                      title="Reassign messenger"
                      onChange={(ev) => onReassign(e, ev.target.value)}
                    >
                      {review.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button className="btn" disabled={busy === e.id} title="Seen & understood — records a completed acknowledgment" onClick={() => onAcknowledge(e)}>✓ Acknowledge</button>
                    <a className="btnGhost" href={gmailLink(e.threadId, e.id)} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>↗ Gmail</a>
                    <button className="btnGhost" disabled={busy === e.id} onClick={() => onCreateTask(e)}>＋ Task</button>
                    {e.isUnread && (
                      <button className="btnGhost" disabled={busy === e.id} onClick={() => onMarkRead(e)}>Mark read</button>
                    )}
                    <select
                      className="qtyInput compactSel" style={{ width: 110 }} value="" disabled={busy === e.id}
                      title="Apply one of your Gmail labels"
                      onChange={(ev) => { onLabel(e, ev.target.value); ev.target.value = '' }}
                    >
                      <option value="" disabled>Label…</option>
                      {gmailLabels.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
                      <option value="__new__">＋ New label…</option>
                    </select>
                    <button className="btnGhost" disabled={busy === e.id}
                            onClick={() => setNoteDraft(noteDraft?.id === e.id ? null : { id: e.id, text: e.note || '' })}>
                      ✎ Datapad
                    </button>
                    <button className="btnGhost" disabled={busy === e.id} onClick={() => onSpam(e)}>Spam</button>
                    <button className="btnGhost" disabled={busy === e.id} onClick={() => onDismiss(e)}>Dismiss</button>
                  </div>
                  {noteDraft?.id === e.id && (
                    <div className="noteEditor">
                      <textarea
                        value={noteDraft.text} autoFocus
                        onChange={(ev) => setNoteDraft({ id: e.id, text: ev.target.value })}
                        placeholder="Highlight the important bits — PO numbers, what was agreed, what to remember…"
                      />
                      <div className="confirmActions">
                        <button className="importBtn" disabled={busy === e.id} onClick={onSaveNote}>Save note</button>
                        <button className="linkBtn" onClick={() => setNoteDraft(null)}>cancel</button>
                        {e.note && <button className="linkBtn" disabled={busy === e.id} onClick={() => { setNoteDraft({ id: e.id, text: '' }); }}>clear text</button>}
                      </div>
                    </div>
                  )}
                  {/* The message itself as a Star Wars comms readout (Nima,
                      2026-07-18) — avatar/name/cards stay untouched; only the
                      MESSAGE gets the targeting-frame + relay meta line. */}
                  <div className="commFrame">
                    <div className="commMeta">
                      <span>{e.isUnread ? '⦿ Incoming transmission' : 'Transmission log'}</span>
                      <span>Relay: GMAIL</span>
                      <span>From: {e.fromName || e.fromAddress || 'unknown'}</span>
                    </div>
                    <div className="holoSubject">{e.subject}</div>
                    {e.note && <div className="ledgerNote">📌 {e.note}</div>}
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

                    </div>
                  )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <section style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ margin: 0 }}>Tasks {tasks && <span className="count">{tasks.filter((t) => t.status === 'open').length}</span>}</h2>
          <button
            className="btn"
            onClick={() => setNewTask(newTask ? null : { subject: '', snippet: '', urgency: '', needsType: 'none', characterId: '' })}
          >
            {newTask ? '✕ Cancel' : '✎ New task'}
          </button>
        </div>
        <p className="hint">Transmissions you've claimed as tasks — plus any you write yourself. Each keeps its messenger's image even after the original email is gone.</p>

        {newTask && (
          <form className="hologram" style={{ padding: 14, marginBottom: 12 }} onSubmit={onSubmitManualTask}>
            <div className="holoName" style={{ marginBottom: 8 }}>New task</div>
            <input
              className="qtyInput" style={{ width: '100%', marginBottom: 8 }} autoFocus
              placeholder="What needs doing? (subject)"
              value={newTask.subject} onChange={(e) => setNewTask({ ...newTask, subject: e.target.value })}
            />
            <textarea
              className="qtyInput" style={{ width: '100%', minHeight: 54, marginBottom: 8, resize: 'vertical' }}
              placeholder="Details (optional)"
              value={newTask.snippet} onChange={(e) => setNewTask({ ...newTask, snippet: e.target.value })}
            />
            <div className="holoActions" style={{ flexWrap: 'wrap' }}>
              <select className="qtyInput" style={{ width: 140 }} value={newTask.urgency}
                onChange={(e) => setNewTask({ ...newTask, urgency: e.target.value })}>
                {URGENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select className="qtyInput" style={{ width: 190 }} value={newTask.needsType}
                onChange={(e) => setNewTask({ ...newTask, needsType: e.target.value })}>
                {NEEDS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select className="qtyInput" style={{ width: 190 }} value={newTask.characterId}
                onChange={(e) => setNewTask({ ...newTask, characterId: e.target.value })}>
                <option value="">Messenger (random)</option>
                {review.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn" disabled={busy === 'new-task' || !newTask.subject.trim()}>
                {busy === 'new-task' ? 'Creating…' : 'Create task'}
              </button>
            </div>
          </form>
        )}

        {!tasks?.length && <div className="empty">No tasks yet — “New task” above, or “Create task” on a transmission.</div>}
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
                      {t.threadId && (
                        <a className="linkBtn" href={gmailLink(t.threadId)} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>↗ Gmail</a>
                      )}
                      <span className="cust">{new Date(t.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {/* In-character delivery line (Nima, 2026-07-17): the messenger
                      SPEAKS the handoff. Deterministic per task, context-aware —
                      urgent tasks get leaned on, recurring get the daily-ritual
                      voice, done tasks get the send-off. */}
                  <p className="holoSpeech">“{speakLine(t.characterId, taskContext(t), t.id)}”</p>
                  {/* the directive itself, framed as a comms readout */}
                  <div className="commFrame">
                    <div className="commMeta">
                      <span>{t.status === 'done' ? '✓ Directive complete' : '⦿ Active directive'}</span>
                      <span>Origin: {t.recurringKey ? 'PROTOCOL' : t.emailId ? 'COMM RELAY' : 'MANUAL LOG'}</span>
                      {t.urgency && <span>Priority: {t.urgency.toUpperCase()}</span>}
                    </div>
                    <div className="holoSubject">{t.subject}</div>
                    <p className="holoSnippet"><LinkedText text={t.snippet} /></p>
                  </div>
                  {/* Bugs' CSV-freshness task: live per-source status, each with its
                      NetSuite saved-search link, plus an import right here so the
                      whole loop (open search → export → import → verified) never
                      leaves the task. Thank-you appears once an import lands. */}
                  {t.verifyKey === 'csv_freshness_workhub' && fresh && (
                    <div className="holoActions" style={{ flexWrap: 'wrap', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                      <p className="hint" style={{ margin: '0 0 2px' }}>Work-Hub exports (auto-verified — import below and these update):</p>
                      {fresh.sources.map((s) => (
                        <div key={s.key} className="freshRow" style={{ padding: '2px 0', width: '100%' }}>
                          <span className={'dot ' + s.status} />
                          <span className="fname">{s.label}</span>
                          <span className={'fage ' + s.status}>
                            {s.status === 'missing' ? 'not uploaded' : fmtAge(s.ageHours)}
                          </span>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer" className="linkBtn" style={{ marginLeft: 4 }}>
                              Open in NetSuite ↗
                            </a>
                          )}
                        </div>
                      ))}
                      {t.status === 'open' && (
                        <div className="holoActions" style={{ marginTop: 4 }}>
                          <button
                            className="btn" disabled={importing}
                            onClick={() => { importTaskRef.current = t; importRef.current?.click() }}
                          >
                            {importing ? 'Importing…' : '⤓ Import the CSVs here'}
                          </button>
                        </div>
                      )}
                      {importing && thanks?.taskId !== t.id && <div className="progressBar" style={{ width: '100%' }}><div /></div>}
                      {thanks?.taskId === t.id && (
                        <div className="scanResult good" style={{ marginTop: 6, width: '100%' }}>{thanks.msg}</div>
                      )}

                      {/* Naghedi-Warehouse imports, auto-checked via its Supabase.
                          Uploads stay in THAT app (its import pipelines do the
                          processing) — the link opens it; this just watches. */}
                      {nwFresh?.configured && (
                        <>
                          <p className="hint" style={{ margin: '8px 0 2px' }}>
                            Naghedi-Warehouse imports (auto-verified from its database — upload over there):
                          </p>
                          {nwFresh.sources.map((s) => (
                            <div key={s.key} className="freshRow" style={{ padding: '2px 0', width: '100%' }}>
                              <span className={'dot ' + s.status} />
                              <span className="fname">{s.label}</span>
                              <span className={'fage ' + s.status}>
                                {s.status === 'unknown'
                                  ? 'couldn’t check'
                                  : s.status === 'missing'
                                    ? 'never imported'
                                    : fmtAge(s.ageHours)}
                                {(s.status === 'stale' || s.status === 'missing') && ' · needs updating'}
                              </span>
                              <a href={s.url} target="_blank" rel="noreferrer" className="linkBtn" style={{ marginLeft: 4 }}>
                                Upload in Naghedi-Warehouse ↗
                              </a>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}

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
                          {c.url && (
                            <a href={c.url} target="_blank" rel="noreferrer" className="linkBtn" style={{ marginLeft: 0 }}>
                              Open ↗
                            </a>
                          )}
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
