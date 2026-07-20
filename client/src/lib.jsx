// Shared bits used across all three views.
import { useEffect, useState } from 'react'
import { fetchLabelSizes, printCargoTag, fetchNotesFor, addNote, deleteNote } from './api.js'
import { NETSUITE_DOC_TYPES } from '../../src/model/netsuiteDocs.js'

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

// The universal note-on-anything widget (Nima, 2026-07-20) — a small
// textarea + save + list, meant to drop onto any card that has a doc type
// and number (EDI PO, SO row, fulfillment, task). Keeps its own notes loaded
// so callers don't need to thread note state through.
export function NoteWidget({ docType, docNumber }) {
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
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
      setNotes(await addNote({ docType, docNumber, note: draft.trim() }))
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    await deleteNote(id)
    setNotes((prev) => prev.filter((n) => n.id !== id))
  }

  if (!docType || !docNumber) return null
  return (
    <div className="noteWidget">
      <button type="button" className="linkBtn" onClick={() => setOpen((o) => !o)}>
        ✎ Notes{notes.length ? ` (${notes.length})` : ''}
      </button>
      {open && (
        <div className="noteWidgetBody">
          {notes.map((n) => (
            <div key={n.id} className="noteWidgetEntry">
              <span>{n.note}</span>
              <button type="button" className="linkBtn" onClick={() => remove(n.id)}>✕</button>
            </div>
          ))}
          <form onSubmit={save} className="noteWidgetForm">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note…" rows={2} />
            <button type="submit" className="btn" disabled={busy || !draft.trim()}>Save</button>
          </form>
        </div>
      )}
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
  ON_HOLD_APPROVAL: 'On Hold',
  OPEN_NEEDS_FULFILLMENT: 'Open',
  PICKED_NEEDS_PACK: 'Picked',
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

// Human-friendly age from hours.
export function fmtAge(hours) {
  if (hours == null) return 'unknown'
  if (hours < 1) return '<1h old'
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}
