// Shared bits used across all three views.
import { useEffect, useState } from 'react'
import { fetchLabelSizes, printCargoTag, fetchNotesFor, addNote, deleteNote, fetchLinksFor, addDocLink, deleteDocLink, fetchDocNumbers, completeQuestTask, createManualTask } from './api.js'
import { NETSUITE_DOC_TYPES, normalizeDocNumber } from '../../src/model/netsuiteDocs.js'
import { channelMeta } from '../../src/model/channels.js'
import { speakLine, taskContext } from '../../src/model/dialogue.js'
import { imagesFor } from './data/characterImages.js'

// Channel tag + colored customer name (Nima, 2026-07-20) — one consistent
// color per account across every view, so Nordstrom/Bloomingdale's/Shopbop/
// boutique/e-com stand out at a glance. channelMeta derives from location
// (authoritative) with a customer-name fallback.
export function ChannelTag({ order, className }) {
  const m = channelMeta(order)
  return (
    <span className={'channelTag' + (className ? ' ' + className : '')}
          style={{ color: m.color, borderColor: m.color, background: m.color + '22' }}>
      {m.label}
    </span>
  )
}

// The customer name, colored by channel. Falls back to nothing if no name.
export function CustomerName({ order, className }) {
  if (!order?.customer) return null
  return (
    <span className={className} style={{ color: channelMeta(order).color, fontWeight: 600 }}>
      {order.customer}
    </span>
  )
}

export { channelMeta }

// Task-composer option lists — shared so any view that creates tasks offers the
// same "what's required to complete this" (needs) and urgency choices as the
// Transmissions new-task form. NETSUITE_DOC_TYPES comes from the model.
export { NETSUITE_DOC_TYPES }
export const NEEDS_OPTIONS = [
  { value: 'none', label: 'Nothing needed yet' },
  { value: 'reply', label: 'Reply needed' },
  { value: 'acknowledgment', label: 'Acknowledgment needed' },
  { value: 'file', label: 'File needed' },
  { value: 'netsuite_doc', label: 'NetSuite document needed' },
]
export const URGENCY_OPTIONS = [
  { value: '', label: 'No urgency set' },
  { value: 'lo', label: 'Low' },
  { value: 'mid', label: 'Medium' },
  { value: 'hi', label: 'High' },
]

// Season badge (Nima, 2026-07-20) — free-text season tag ('Summer 2026',
// 'Core', …) on any OC/PO. Presentational + self-editing; the parent view
// owns the seasons lookup (one bulk fetch, see fetchSeasons in api.js) and
// passes the current value + a save callback so many badges on one page
// don't each fire their own request just to render.
export function SeasonBadge({ season, onSave, highlightCore }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(season || '')
  const [busy, setBusy] = useState(false)

  function startEdit(e) {
    e.stopPropagation()
    setDraft(season || '')
    setEditing(true)
  }

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await onSave(draft.trim())
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <form className="seasonBadge editing" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <input className="qtyInput" style={{ width: 110 }} value={draft} autoFocus placeholder="e.g. Summer 2026"
               onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
        <button type="submit" className="linkBtn" disabled={busy}>save</button>
        <button type="button" className="linkBtn" onClick={() => setEditing(false)}>✕</button>
      </form>
    )
  }
  return (
    <span className={'seasonBadge' + (highlightCore && season === 'Core' ? ' core' : '') + (season ? '' : ' unset')}
          onClick={startEdit} title="Click to set the season">
      {season || '+ season'}
    </span>
  )
}

// Doc types a note can cross-link TO (Nima, 2026-07-20: "cross linking between
// an email/transmission and these documents"). Free-text ref per type — for an
// email it's the Gmail id/subject, for a NetSuite doc its number.
export const LINK_DOC_TYPES = [
  { value: 'EMAIL', label: 'Email / transmission' },
  { value: 'SO', label: 'Sales Order' },
  { value: 'IF', label: 'Fulfillment' },
  { value: 'INV', label: 'Invoice' },
  { value: 'EDI_PO', label: 'EDI PO' },
  { value: 'PO', label: 'Purchase Order' },
  { value: 'OC', label: 'Order Confirmation' },
  { value: 'TASK', label: 'Task' },
]
const LINK_TYPE_LABEL = Object.fromEntries(LINK_DOC_TYPES.map((t) => [t.value, t.label]))

// Document links (Nima, 2026-07-20) — the thing NetSuite can't do: attach any
// doc/transaction to any other. Bidirectional, so a link added from an email
// shows on the sales order and vice versa. `selfLabel` (e.g. an email's
// subject) rides along as the link's label so the counterpart reads nicely.
export function DocLinks({ docType, docNumber, selfLabel, compact = false }) {
  const [links, setLinks] = useState([])
  const [open, setOpen] = useState(compact)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !docType || !docNumber) return
    fetchLinksFor(docType, docNumber).then(setLinks).catch(() => {})
  }, [open, docType, docNumber])

  // Search real document numbers as you type (debounced) — pick, don't type.
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    let live = true
    const t = setTimeout(() => {
      fetchDocNumbers(q).then((r) => { if (live) setResults(r.filter((x) => !(x.type === docType && x.number === docNumber))) }).catch(() => {})
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [q, docType, docNumber])

  async function link(target) {
    setBusy(true)
    try {
      await addDocLink({
        aType: docType, aNumber: docNumber, bType: target.type, bNumber: target.number,
        label: selfLabel || null,
      })
      setLinks(await fetchLinksFor(docType, docNumber))
      setQ(''); setResults([])
    } finally { setBusy(false) }
  }

  async function remove(id) {
    await deleteDocLink(id)
    setLinks((prev) => prev.filter((l) => l.id !== id))
  }

  if (!docType || !docNumber) return null
  const body = (
    <div className="noteWidgetBody">
      {links.map((l) => (
        <div key={l.id} className="noteWidgetEntry">
          <span>
            <span className="linkChip">{LINK_TYPE_LABEL[l.otherType] || l.otherType}</span> {l.otherNumber}
            {l.label && <span className="noteLink"> · {l.label}</span>}
          </span>
          <button type="button" className="linkBtn" onClick={() => remove(l.id)}>✕</button>
        </div>
      ))}
      <div className="docLinkPicker">
        <input className="qtyInput" value={q} disabled={busy}
               placeholder="Search a document to attach… (SO / IF / INV / PO / OC)"
               onChange={(e) => setQ(e.target.value)} />
        {!!results.length && (
          <div className="docLinkResults">
            {results.map((r) => (
              <button type="button" key={r.type + r.number} className="docLinkResult" disabled={busy}
                      onClick={() => link(r)}>
                <span className="linkChip">{LINK_TYPE_LABEL[r.type] || r.type}</span> {r.number}
                {r.label && <span className="noteLink"> · {r.label}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
  if (compact) return <div className="noteWidget">{body}</div>
  return (
    <div className="noteWidget">
      <button type="button" className="linkBtn" onClick={() => setOpen((o) => !o)}>
        🔗 Links{links.length ? ` (${links.length})` : ''}
      </button>
      {open && body}
    </div>
  )
}

// The universal note-on-anything widget (Nima, 2026-07-20) — a small
// textarea + save + list, meant to drop onto any card that has a doc type
// and number (EDI PO, SO row, fulfillment, task, a delayed Launch Bay order).
// A note can optionally CROSS-LINK to another doc (e.g. the email that
// explains a delay). `defaultOpen` starts it expanded (side panels), `compact`
// drops the toggle button and always shows the body.
export function NoteWidget({ docType, docNumber, defaultOpen = false, compact = false }) {
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [linkType, setLinkType] = useState('')
  const [linkNum, setLinkNum] = useState('')
  const [open, setOpen] = useState(defaultOpen || compact)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !docType || !docNumber) return
    fetchNotesFor(docType, docNumber).then(setNotes).catch(() => {})
  }, [open, docType, docNumber])

  async function save(e) {
    e.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    try {
      setNotes(await addNote({
        docType, docNumber, note: draft.trim(),
        linkedDocType: linkType || null,
        linkedDocNumber: linkType && linkNum.trim() ? linkNum.trim() : null,
      }))
      setDraft(''); setLinkType(''); setLinkNum('')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    await deleteNote(id)
    setNotes((prev) => prev.filter((n) => n.id !== id))
  }

  if (!docType || !docNumber) return null
  const body = (
    <div className="noteWidgetBody">
      {notes.map((n) => (
        <div key={n.id} className="noteWidgetEntry">
          <span>
            {n.note}
            {n.linkedDocNumber && <span className="noteLink"> · ↳ {n.linkedDocType} {n.linkedDocNumber}</span>}
          </span>
          <button type="button" className="linkBtn" onClick={() => remove(n.id)}>✕</button>
        </div>
      ))}
      <form onSubmit={save} className="noteWidgetForm">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note (e.g. why it's delayed)…" rows={2} />
        <div className="noteLinkRow">
          <select className="qtyInput" value={linkType} onChange={(e) => setLinkType(e.target.value)}>
            <option value="">Link a doc… (optional)</option>
            {LINK_DOC_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {linkType && (
            <input className="qtyInput" style={{ width: 130 }} value={linkNum}
                   placeholder={linkType === 'EMAIL' ? 'email id / subject' : 'e.g. SO1213'}
                   onChange={(e) => setLinkNum(e.target.value)} />
          )}
          <button type="submit" className="btn" disabled={busy || !draft.trim()}>Save</button>
        </div>
      </form>
    </div>
  )
  if (compact) return <div className="noteWidget">{body}</div>
  return (
    <div className="noteWidget">
      <button type="button" className="linkBtn" onClick={() => setOpen((o) => !o)}>
        ✎ Notes{notes.length ? ` (${notes.length})` : ''}
      </button>
      {open && body}
    </div>
  )
}

// Cargo-tag print buttons — one per label size that can actually print from
// this host, each going STRAIGHT to its printer via the server (no browser
// dialog). '4x6' → Zebra thermal; '2.25x1.25' → MUNBYN. Availability is
// fetched once per session and shared, so buttons whose printer isn't
// reachable (e.g. the cloud deploy) simply don't render.
const SIZE_LABEL = { '4x6': '4×6', '2.25x1.25': '2.25″' }
let _labelSizes // Promise<{[size]: boolean}>, memoized

function OneLabelButton({ info, size }) {
  const [state, setState] = useState(null) // null | 'printing' | 'ok' | 'err'
  const [msg, setMsg] = useState('')
  async function onPrint() {
    setState('printing'); setMsg('')
    try {
      await printCargoTag(info, size)
      setState('ok')
      setTimeout(() => setState(null), 2500)
    } catch (e) {
      setState('err'); setMsg(e.message)
    }
  }
  return (
    <button className="linkBtn" title={`Print the ${SIZE_LABEL[size]} cargo tag`} disabled={state === 'printing'} onClick={onPrint}>
      🖨 {state === 'printing' ? `${SIZE_LABEL[size]}…` : state === 'ok' ? `✓ ${SIZE_LABEL[size]}` : state === 'err' ? `⚠ ${SIZE_LABEL[size]}` : SIZE_LABEL[size]}
      {state === 'err' && msg && <span style={{ color: 'var(--hi)' }}> — {msg}</span>}
    </button>
  )
}

export function LabelButtons({ info }) {
  const [sizes, setSizes] = useState({})
  useEffect(() => {
    if (!_labelSizes) _labelSizes = fetchLabelSizes().catch(() => ({}))
    _labelSizes.then(setSizes)
  }, [])
  const available = ['4x6', '2.25x1.25'].filter((s) => sizes[s])
  if (!available.length) return null
  if (!info?.ifNumber) return null
  return (
    <span className="tagBtns">
      {available.map((s) => <OneLabelButton key={s} info={info} size={s} />)}
    </span>
  )
}


export const STAGE_ORDER = [
  'ON_HOLD_APPROVAL',
  'OPEN_NEEDS_FULFILLMENT',
  'PICKED_NEEDS_PACK',
  'PACKED_PENDING_NEXT',
  'INVOICED_PENDING_PAYMENT',
  'APPROVED_FOR_SHIPPING',
  'SHIPPED',
]

export const STAGE_SHORT = {
  ON_HOLD_APPROVAL: 'Pending Approval',
  OPEN_NEEDS_FULFILLMENT: 'Pending Fulfillment',
  PICKED_NEEDS_PACK: 'Item Fulfillments',
  PACKED_PENDING_NEXT: 'Packed',
  INVOICED_PENDING_PAYMENT: 'Invoiced',
  APPROVED_FOR_SHIPPING: 'Approved',
  SHIPPED: 'Shipped',
}

// severity → css class (3 act now, 2 caution, 1 watch, 0 none)
export const sevClass = (s) =>
  s >= 3 ? 'sev-hi' : s >= 2 ? 'sev-mid' : s >= 1 ? 'sev-lo' : 'sev-none'

export function Flags({ flags }) {
  if (!flags?.length) return null
  return (
    <div className="flags">
      {flags.map((f, i) => (
        <span key={i} className={'flag ' + sevClass(f.severity)}>
          {f.label}
        </span>
      ))}
    </div>
  )
}

export const ifList = (o) =>
  (o.fulfillments || []).map((f) => f.ifNumber).filter(Boolean).join(', ')

// The one document worth showing for this order's current stage: the IF#
// while it's still moving through fulfillment, the invoice # once it's
// past that (falls back to IF# if no invoice is on file yet).
const INVOICED_OR_LATER = new Set([
  'INVOICED_PENDING_PAYMENT',
  'APPROVED_FOR_SHIPPING',
  'SHIPPED',
])
export function docRef(o) {
  const ifs = ifList(o)
  // The Pending Orders search's "Invoice for IF" column gives the precise
  // per-fulfillment pairing (which invoice was actually generated against
  // which IF) — it's known the moment NetSuite creates the invoice, before
  // the order search even reports the order as "Invoiced". Prefer it over
  // the order-level invoices join whenever it's present.
  const perIf = (o.fulfillments || []).map((f) => f.invoice).filter(Boolean).join(', ')
  if (perIf) return perIf
  if (INVOICED_OR_LATER.has(o.stage)) {
    const invs = (o.invoices || []).map((i) => i.invNumber).filter(Boolean).join(', ')
    return invs || ifs || ''
  }
  return ifs || ''
}

// The date the current-stage document entered its state — for an Item
// Fulfillment, NetSuite's date IS the day it was moved into that status
// (e.g. the day it was printed/picked). Surfacing it answers "how long has
// this been sitting with us needing our part?". Latest IF date wins.
export function docDate(o) {
  const dates = (o.fulfillments || []).map((f) => f.ifDate).filter(Boolean)
  if (!dates.length) return ''
  return fmtShortDate(dates.slice().sort().at(-1)) // ISO 'YYYY-MM-DD' sorts lexically
}

function fmtShortDate(s) {
  // Take the date part only and build from Y/M/D so a 'YYYY-MM-DD' value
  // (UTC midnight) isn't shifted back a day when rendered in a US timezone.
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return `${Number(m[2])}/${Number(m[3])}`
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

// EDI channel badge (ShopBop / Nordstrom / Bloomingdale's), or the character
// who delivered a transmission-derived task.
export function SourceBadge({ source, character }) {
  if (source === 'edi') return <span className="badge edi">EDI</span>
  if (source === 'transmission') return <span className="badge transmission">{character?.name || 'Task'}</span>
  return null
}

// Quest tasks (Gmail/Slack transmissions promoted to durable tasks) merged
// into the same "needs attention" surface as NetSuite orders (Nima,
// 2026-07-15: "the transmission should live along all other tasks we have").
// No NetSuite stage applies, so severity comes from urgency instead — an
// open task with no urgency set still defaults to "lo" so it isn't invisible.
const URGENCY_SEVERITY = { hi: 3, mid: 2, lo: 1 }
export const taskSeverity = (t) => URGENCY_SEVERITY[t.urgency] || 1
export const taskDaysPending = (t) => Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86_400_000)

const NEEDS_LABEL = {
  none: 'Review', reply: 'Reply needed', acknowledgment: 'Acknowledge',
  file: 'File needed', netsuite_doc: 'NetSuite doc needed',
}
export const taskNextAction = (t) => {
  if (t.needsType === 'netsuite_doc' && t.netsuiteDocNumber) return `NetSuite doc needed: ${t.netsuiteDocNumber}`
  const base = NEEDS_LABEL[t.needsType] || 'Review'
  return t.needsNote ? `${base}: ${t.needsNote}` : base
}

// Normalizes an open quest_task into the same shape Dashboard/Kanban cards
// expect from an order, so both can render through one code path.
export function taskToCard(t) {
  return {
    soNumber: `TASK-${t.id}`,
    customer: t.fromName || t.fromAddress || 'Unknown sender',
    source: 'transmission',
    character: t.character,
    stage: null,
    severity: taskSeverity(t),
    daysPending: taskDaysPending(t),
    nextAction: taskNextAction(t),
    flags: [],
    fulfillments: [],
    invoices: [],
  }
}

// Renders `[label](url)` markdown-style links inside plain task/email text as
// real clickable anchors (Nima, 2026-07-20: task messages should link straight
// to the Airtable base / NetSuite export / import assistant they reference).
// Everything else renders as plain text — no other markdown is supported.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
export function LinkedText({ text }) {
  if (!text) return null
  const parts = []
  let last = 0, m
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <a key={m.index} href={m[2]} target="_blank" rel="noreferrer" className="taskLink" onClick={(e) => e.stopPropagation()}>
        {m[1]} ↗
      </a>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

// Which surface a task came from — drives the origin groups in the Tasks view
// and the "where does this belong" labels everywhere else.
export function taskOrigin(t) {
  if (String(t.instanceKey || '').startsWith('edi:')) return 'edi'
  if (t.recurringKey) return 'protocol'
  if (t.emailId) return 'transmission'
  return 'manual'
}
export const ORIGIN_LABEL = {
  protocol: 'Protocols · recurring duties',
  transmission: 'Transmissions · from the comm relay',
  edi: 'EDI relay · open PO work',
  manual: 'Manual · logged by hand',
}
// The view a task's linked NetSuite doc opens into.
const DOC_VIEW = { SO: 'table', IF: 'table', INV: 'table', PO: 'allocations', OC: 'allocations', EDI_PO: 'edi' }

// One expandable task — the shared card used by the Tasks view, the Flight
// Deck task monitor, and (soon) the Command chips. Collapsed: messenger face +
// spoken line + subject + urgency. Expanded: the snippet, Mark done, a Gmail
// deep link, its linked NetSuite doc, and an "open in Tasks" jump so a click
// in any panel is never a dead end.
export function TaskItem({ t, expanded, onToggle, onRefresh, onNavigate, showOpen = true }) {
  const [busy, setBusy] = useState(false)
  const img = imagesFor(t.characterId)[0]
  const sev = t.urgency === 'hi' ? 3 : t.urgency === 'mid' ? 2 : 1

  async function markDone(e) {
    e.stopPropagation()
    setBusy(true)
    try { await completeQuestTask(t.id, true); onRefresh?.() } finally { setBusy(false) }
  }

  return (
    <div className={'taskItem ' + sevClass(sev) + (expanded ? ' taskItemOpen' : '')}
         onClick={() => onToggle?.(t.id)}>
      <div className="tiAvatar">{img ? <img src={img} alt="" /> : <span className="tiGlyph">◈</span>}</div>
      <div className="tiBody">
        <div className="tiTop">
          <b>{t.character?.name || t.fromName || 'Unknown Messenger'}</b>
          {t.status === 'done' && <span className="flag sev-lo">done</span>}
          {t.status === 'open' && t.urgency && (
            <span className={'flag ' + (t.urgency === 'hi' ? 'sev-hi' : t.urgency === 'mid' ? 'sev-mid' : 'sev-lo')}>{t.urgency}</span>
          )}
        </div>
        <div className="tiSpeech">“{speakLine(t.characterId, taskContext(t), t.id)}”</div>
        <div className="tiSubject"><LinkedText text={t.subject} /></div>
        {expanded && (
          <div className="tiExpand" onClick={(e) => e.stopPropagation()}>
            {t.snippet && <p className="tiSnippet"><LinkedText text={t.snippet} /></p>}
            <div className="tiActions">
              {t.status === 'open' && <button className="btn" disabled={busy} onClick={markDone}>✓ Mark done</button>}
              {t.threadId && (
                <a className="btnGhost" href={`https://mail.google.com/mail/u/0/#all/${t.threadId}`}
                   target="_blank" rel="noreferrer">↗ Gmail</a>
              )}
              {t.netsuiteDocNumber && DOC_VIEW[t.netsuiteDocType] && (
                <button className="btnGhost" onClick={() => onNavigate?.(DOC_VIEW[t.netsuiteDocType])}>
                  ↗ {t.netsuiteDocType} {t.netsuiteDocNumber}
                </button>
              )}
              {showOpen && onNavigate && <button className="btnGhost" onClick={() => onNavigate('tasks')}>↗ open in Tasks</button>}
            </div>
            <DocLinks docType="TASK" docNumber={String(t.id)} selfLabel={t.subject} />
          </div>
        )}
      </div>
    </div>
  )
}

// Index of existing tasks by their linked NetSuite doc, so any view can tell
// "a task already exists for this SO/IF" and link to it instead of letting you
// silently create a duplicate. Key = "TYPE:NORMALIZED_NUMBER".
export function buildTaskDocIndex(tasks = []) {
  const idx = new Map()
  for (const t of tasks) {
    if (!t.netsuiteDocNumber || !t.netsuiteDocType) continue
    const key = `${t.netsuiteDocType}:${t.netsuiteDocNumber}`
    // an open task wins over a done one for the same doc
    if (idx.get(key) !== 'open') idx.set(key, t.status)
  }
  return idx
}

// The 3-state task control for a NetSuite doc (mirrors the EDI card's button):
// ◉ Task (open, jump to it) · ✓ Task (done, jump) · ＋ Task (create). Creating
// files a doc-linked manual task so it shows up indexed and never doubles up.
export function TaskLink({ docType, docNumber, index, onCreated, onNavigate, label }) {
  const [busy, setBusy] = useState(false)
  if (!docNumber) return null
  const norm = normalizeDocNumber(docType, docNumber) || docNumber
  const status = index?.get(`${docType}:${norm}`)
  async function create(e) {
    e.stopPropagation()
    setBusy(true)
    try {
      await createManualTask({
        subject: `Follow up · ${docNumber}${label ? ` · ${label}` : ''}`,
        needsType: 'netsuite_doc', netsuiteDocType: docType, netsuiteDocNumber: docNumber, urgency: 'mid',
      })
      onCreated?.()
    } finally { setBusy(false) }
  }
  if (status === 'open') return <button className="linkBtn taskLinkBtn open" title="A task is open for this doc" onClick={(e) => { e.stopPropagation(); onNavigate?.('tasks') }}>◉ Task</button>
  if (status === 'done') return <button className="linkBtn taskLinkBtn done" title="This doc's task was completed" onClick={(e) => { e.stopPropagation(); onNavigate?.('tasks') }}>✓ Task</button>
  return <button className="linkBtn taskLinkBtn" disabled={busy} onClick={create} title="Create a task for this doc">＋ Task</button>
}

// Human-friendly age from hours.
export function fmtAge(hours) {
  if (hours == null) return 'unknown'
  if (hours < 1) return '<1h old'
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}
