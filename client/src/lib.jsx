// Shared bits used across all three views.
import { useEffect, useState } from 'react'
import { fetchLabelSizes, printCargoTag, fetchNotesFor, addNote, deleteNote, fetchLinksFor, addDocLink, deleteDocLink, fetchDocNumbers, completeQuestTask, createManualTask, pushToShipstation, confirmDeparted } from './api.js'
import { parseDocUrl, linkKey, KIND_LABEL } from '../../src/model/docLinkUrl.js'
import { NETSUITE_DOC_TYPES, normalizeDocNumber } from '../../src/model/netsuiteDocs.js'
import { isDocNumber } from '../../src/model/netsuiteLinks.js'
import { traceTypeFor } from '../../src/model/trace.js'
import { useTraceDrawer } from './traceDrawerContext.js'
import { channelMeta } from '../../src/model/channels.js'
import { speakLine, taskContext } from '../../src/model/dialogue.js'
import { imagesFor } from './data/characterImages.js'
import { dcBreakdown } from '../../src/model/dc.js'
import { cardCustody } from '../../src/model/custody.js'

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
// A URL is unreadable at full length in a 340px card. Show host + the tail of the path.
function prettyUrl(url) {
  try {
    const u = new URL(url)
    const tail = u.pathname.replace(/\/(edit|view)$/, '').split('/').filter(Boolean).pop() || ''
    return u.hostname.replace(/^www\./, '') + (tail ? ` · ${tail.slice(0, 12)}` : '')
  } catch { return String(url).slice(0, 40) }
}

export function DocLinks({ docType, docNumber, selfLabel, compact = false }) {
  const [links, setLinks] = useState([])
  const [open, setOpen] = useState(compact)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [urlErr, setUrlErr] = useState(null)

  useEffect(() => {
    if (!open || !docType || !docNumber) return
    fetchLinksFor(docType, docNumber).then(setLinks).catch(() => {})
  }, [open, docType, docNumber])

  // Attach a Google Doc / Drive file by pasting its link (Nima, 2026-08-20: "link to any
  // google docs if possible"). The far end is not a document in this system, so it is
  // stored with a `url` and keyed on the Drive FILE ID — see src/model/docLinkUrl.js for
  // why the raw URL is the wrong identity.
  async function linkUrl(e) {
    e.preventDefault(); e.stopPropagation()
    const parsed = parseDocUrl(urlDraft)
    if (!parsed.ok) { setUrlErr(parsed.error); return }
    setUrlErr(null); setBusy(true)
    try {
      await addDocLink({
        aType: docType, aNumber: docNumber,
        bType: 'LINK', bNumber: linkKey(parsed),
        label: KIND_LABEL[parsed.kind] || 'Link',
        url: parsed.url,
      })
      setLinks(await fetchLinksFor(docType, docNumber))
      setUrlDraft('')
    } catch (err) { setUrlErr(err.message) } finally { setBusy(false) }
  }

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
          {/* ⚠️ An external link must be CLICKABLE — a Google Doc you cannot open is a
              string, not a link. Internal doc links stay plain text, since there is no
              URL to go to. */}
          {l.url ? (
            <a href={l.url} target="_blank" rel="noreferrer" className="docLinkOut">
              <span className="linkChip">{l.label || 'Link'}</span>
              <span className="noteLink">{prettyUrl(l.url)}</span>
            </a>
          ) : (
            <span>
              <span className="linkChip">{LINK_TYPE_LABEL[l.otherType] || l.otherType}</span> {l.otherNumber}
              {l.label && <span className="noteLink"> · {l.label}</span>}
            </span>
          )}
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
      <form className="docLinkUrl" onSubmit={linkUrl}>
        <input className="qtyInput" value={urlDraft} disabled={busy}
               placeholder="…or paste a Google Doc / Drive link"
               onChange={(e) => { setUrlDraft(e.target.value); setUrlErr(null) }} />
        <button type="submit" className="btnGhost" disabled={busy || !urlDraft.trim()}>Attach</button>
      </form>
      {urlErr && <div className="docLinkErr">{urlErr}</div>}
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
    <button className="cardAct actPrint" title={`Print the ${SIZE_LABEL[size]} cargo tag`} disabled={state === 'printing'} onClick={onPrint}>
      🖨 {state === 'printing' ? `${SIZE_LABEL[size]}…` : state === 'ok' ? `✓ ${SIZE_LABEL[size]}` : state === 'err' ? `⚠ ${SIZE_LABEL[size]}` : SIZE_LABEL[size]}
      {state === 'err' && msg && <span style={{ color: 'var(--hi)' }}> — {msg}</span>}
    </button>
  )
}

// "Open in NetSuite" (Nima, 2026-08-13). A plain anchor to the server, which looks the
// document up and 302s — the client never builds a NetSuite URL, because doing so would
// need the account id and a second copy of the recordtype→page table that could drift
// from the server's. See src/model/netsuiteLinks.js.
//
// ⚠️ A real <a href>, deliberately, not an onClick+fetch. It gets middle-click, ⌘-click,
// "copy link address" and the browser's own loading state for free, and a NetSuite page
// is somewhere you want in a NEW tab with your place on the board kept.
//
// ── THE CLICK IS SPLIT (Nima, 2026-08-20) ───────────────────────────────────────
//
// Asked which should win when the trace drawer wanted this same click, Nima chose:
// the NUMBER opens the drawer, the ↗ keeps going to NetSuite. So nothing anyone
// relies on moved — the arrow does exactly what the whole link used to do — and
// "tell me about this" became the obvious click on all 46 of these across 13 views.
//
// ⚠️ Only for documents we can actually TRACE (SO · IF · INV, via traceTypeFor).
// A PO, an item receipt or a transfer order keeps the old undivided behaviour,
// because splitting a click to reveal a drawer that would 400 is worse than not
// splitting it. Same rule outside the provider (no drawer mounted at all).
export function NsLink({ doc, children, title, linkOnly = false }) {
  const drawer = useTraceDrawer()
  if (!doc) return null
  // ⚠️ Degrades to plain text rather than rendering a link that 400s. A task card's
  // reference is free text and need not be a document number at all, and a link that
  // reliably fails is worse than no link — it teaches you to stop trusting the ones
  // that work.
  if (!isDocNumber(doc)) return <>{children || doc}</>

  const nsHref = `/api/netsuite/open?doc=${encodeURIComponent(doc)}`
  // The card is clickable in places; opening a document should never also toggle a
  // selection or expand a row underneath it.
  const stop = (e) => e.stopPropagation()
  const netsuite = (
    <a className="nsLinkMark" href={nsHref} target="_blank" rel="noreferrer"
       title={`Open ${doc} in NetSuite`} onClick={stop} aria-label={`Open ${doc} in NetSuite`}>↗</a>
  )

  // `linkOnly` is for surfaces that ARE the trace already (the drawer's own header):
  // offering to open the drawer from inside it would stack a panel on itself.
  // Custom children mean the caller is rendering its own affordance, not a number.
  const traceable = !linkOnly && !children && !!drawer && !!traceTypeFor(doc)
  if (!traceable) {
    return (
      <a className="nsLink" href={nsHref} target="_blank" rel="noreferrer"
         title={title || `Open ${doc} in NetSuite`} onClick={stop}>
        {children || doc}<span className="nsLinkMark" aria-hidden="true">↗</span>
      </a>
    )
  }

  // ⚠️ A <span role="button">, NOT a <button>. Some cards ARE buttons themselves —
  // TacticalCore's custody rows are a clickable <button> that prints IF numbers
  // inside it — and a button nested in a button is invalid HTML that React refuses
  // and browsers resolve unpredictably (the inner one may never receive the click).
  // Found by the console the moment this shipped to the Command Center. A span with
  // an explicit role, tabIndex and Enter/Space handler is reachable by keyboard and
  // legal in every one of the 46 places this renders.
  const openTrace = (e) => { stop(e); drawer.openDoc(doc) }
  return (
    <span className="nsLink nsLinkSplit">
      <span role="button" tabIndex={0} className="nsLinkDoc" title={title || `Trace ${doc}`}
            onClick={openTrace}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrace(e) } }}>
        {doc}
      </span>
      {netsuite}
    </span>
  )
}

// docRef() joins the current-stage documents into ONE display string, which cannot be
// linked per document. This is the same derivation returning the parts — so the two
// cannot drift, the string version is now built FROM the list rather than beside it.
export function docRefList(o) {
  const s = docRef(o)
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
}

// docRef() as CLICKABLE parts, reading the same as the joined string it replaces.
// One component rather than the same three-line map in every view — a rule spelled out
// in several places is the shape that has drifted every time it has been tried here.
export function DocRefLinks({ o }) {
  const docs = docRefList(o)
  if (!docs.length) return null
  return <>{docs.map((d, i) => <span key={d}>{i > 0 && ', '}<NsLink doc={d} /></span>)}</>
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

// ── Break-glass: push ONE fulfilment to ShipStation ─────────────────────────
//
// Nima, 2026-08-11: "sometimes the netsuite UPS label creator has issues and
// we're in a rush and printing it in shipstation if we can push the data out
// would be better than manually creating the label ourself."
//
// So this is deliberately per-order and human-initiated — the default stays
// "nothing is pushed", and no scheduled run changed. What it buys in that moment
// is the address, service and third-party billing already resolved, instead of
// keying a label from scratch under time pressure.
//
// A held order still shows WHY, and offers the force only when the block is
// POLICY (this location is NetSuite's to label). When the block is a FACT — the
// box already carries a label — there is no force, because a second live label is
// a double charge and a wrong tracking number on the ASN. See
// src/model/shipstationEligible.js (labelCount) and labelSource.js (location).
export function ShipstationPushButton({ ifNumber, onDone }) {
  const [state, setState] = useState(null) // { busy, msg, held, canForce }
  if (!ifNumber) return null

  const run = async (force) => {
    setState({ busy: true })
    try {
      const r = await pushToShipstation({ scope: 'boutique', ifNumbers: [ifNumber], force })
      if (r.pushed > 0) {
        // The order NUMBER, so he can find it in ShipStation's own search. We hold the
        // numeric orderId too, but ShipStation's deep-link format is not something this
        // repo has ever verified — a link that 404s is worse than a number to paste.
        const num = r.results?.[0]?.orderNumber || r.records?.[0]?.orderNumber || null
        setState({ msg: num ? `✓ pushed as ${num} — buy the label in ShipStation` : '✓ pushed — buy the label in ShipStation' })
        onDone?.(r)
        return
      }
      const held = (r.skipped || [])[0]
      const reason = held?.reason || (r.seen === 0
        ? 'not in the push scope — only unshipped, non-China fulfilments are'
        : 'held, with no reason given')
      // Only a LOCATION block is forceable; everything else is a fact about the
      // box or the data, and forcing it would just push something broken.
      const canForce = !force && /NetSuite/i.test(reason) && !/already has/i.test(reason)
      setState({ msg: reason, held: true, canForce })
    } catch (e) {
      setState({ msg: e.message, held: true })
    }
  }

  return (
    <span className="tagBtns ssPush">
      {/* ⚠️ "→ ShipStation" read as a LINK — Nima expected it to take him there (2026-08-17).
          It does not navigate: it CREATES the order over the API and nothing is purchased.
          So the arrow is gone and the verb is first, which is what the control actually does. */}
      <button className="cardAct actPush" disabled={state?.busy} onClick={() => run(false)}
              title="Creates the order in ShipStation over the API so the label can be bought there. Does not open ShipStation, and never buys a label.">
        {state?.busy ? 'pushing…' : '⇪ Push to ShipStation'}
      </button>
      {state?.msg && <span className={state.held ? 'muted' : 'good'}> {state.msg}</span>}
      {state?.canForce && (
        <button className="linkBtn" onClick={() => {
          if (window.confirm(`${ifNumber}: NetSuite normally labels this one.\n\nPush it to ShipStation anyway? Only do this if NetSuite's label creator is not working — otherwise you risk two labels on one box.`)) run(true)
        }}>push anyway</button>
      )}
    </span>
  )
}

// "Confirm it left" — Net-terms only (Nima, 2026-08-13). NetSuite says Shipped
// from the moment the label is made and then hides the order from his searches,
// so this click is the ONLY record that the goods physically went. No NetSuite
// side effect; undoable, because a marker that can only be set is a trap.
export function ConfirmDepartedButton({ ifNumber, onDone }) {
  const [state, setState] = useState(null)
  if (!ifNumber) return null
  const run = async () => {
    setState({ busy: true })
    try {
      await confirmDeparted({ ifNumber, departed: true })
      setState({ msg: '✓ recorded as gone' })
      onDone?.()
    } catch (e) {
      setState({ msg: e.message, bad: true })
    }
  }
  // ⚠️ A BUTTON, not a link, and worded as an ANSWER to the card's own question.
  //
  // Nima, 2026-08-17: "where is the box i tried to mark it as shipped expecting it to
  // leave this que". He clicked the checkbox at the top-left of the card — which is
  // task SELECTION — because a tickbox is the obvious thing to tick when a card says
  // "Confirm it physically left". The real control was a faint `linkBtn` at the very
  // bottom, indistinguishable from the print links beside it.
  //
  // The card asks a yes/no question, so the control now reads as the yes. It is the
  // only action on these cards that no other system can supply, so it should not be
  // the quietest thing on them.
  return (
    <span className="tagBtns">
      <button className="btn confirmLeft" disabled={state?.busy} onClick={run}
              title="Record that this order physically left the building. NetSuite has read Shipped since the label was made — it cannot tell you this. Undoable.">
        {state?.busy ? 'recording…' : '✓ Yes, it left'}
      </button>
      {state?.msg && <span className={state.bad ? 'muted' : 'good'}> {state.msg}</span>}
    </span>
  )
}

// Print every cargo tag for a PO group at once (Nima, 2026-07-21) — a collapsed
// PO group fans out into one Item Fulfillment per store, each needing its own
// tag; this prints them all without expanding the group. One button per label
// size; confirms first since it's a bulk physical print.
export function GroupLabelButtons({ group }) {
  const [sizes, setSizes] = useState({})
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    if (!_labelSizes) _labelSizes = fetchLabelSizes().catch(() => ({}))
    _labelSizes.then(setSizes)
  }, [])
  const refByPo = group?.source === 'edi'
  const tags = (group?.members || []).flatMap((m) =>
    (m.fulfillments || []).filter((f) => f.ifNumber).map((f) => ({
      ifNumber: f.ifNumber, soNumber: m.soNumber, customer: m.customer, poNumber: m.poNumber, refByPo,
    })))
  const available = ['4x6', '2.25x1.25'].filter((s) => sizes[s])
  if (!available.length || !tags.length) return null
  const noun = tags.length === 1 ? 'tag' : 'tags'

  async function printAll(size) {
    if (tags.length > 1 && !window.confirm(`Print ${tags.length} cargo tags for PO ${group.poNumber}?`)) return
    setBusy(size); setErr(null)
    try { for (const info of tags) await printCargoTag(info, size) } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }
  return (
    <span className="tagBtns">
      {available.map((s) => (
        <button key={s} className="linkBtn" disabled={busy === s}
                title={`Print all ${tags.length} ${SIZE_LABEL[s]} cargo ${noun} for PO ${group.poNumber}`}
                onClick={() => printAll(s)}>
          🖨 {busy === s ? `${SIZE_LABEL[s]}…` : `${tags.length} ${noun} (${SIZE_LABEL[s]})`}
        </button>
      ))}
      {err && <span className="tagErr">⚠ {err}</span>}
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

// The ship window as one compact line: when we may start → when it must ship.
// Rendered separately from Flags because the window is always true, while a
// flag only fires when the window is close enough to act on — the card should
// still say "ships Aug 28" on a quiet order that raises nothing.
//
// The arrow's left side is deliberately the date we may START (the partner's
// start date, minus Bloomingdale's DC headstart), not the raw start date —
// that's the number that answers "can I pull this forward?".
export function ShipWindow({ window: w }) {
  // Shipped → the deadline is history. The Ship Departures view owns what
  // actually left and when; a red "53d late" on a card that already went out is
  // just wrong.
  // ⚠️ A window with only an OPENING date is still a window — Nima's whole point for
  // Saint Bernard is that it cannot ship until the 28th, whether or not a closing date
  // was set. Requiring mustShipBy hid exactly those cards.
  if (!w || w.shipped || (w.mustShipBy == null && w.windowStart == null)) return null
  const d = w.daysToShip
  const sev = d == null ? 0 : d < 0 ? 3 : d <= 2 ? 2 : d <= 7 ? 1 : 0
  const left = w.notOpenYet ? `opens ${md(w.opens)} → ` : ''
  const verb = w.source === 'edi' ? 'cancels' : 'ships'
  // A start-only window has no deadline to print, so say when it opens and stop
  // rather than printing "ships " with nothing after it.
  if (w.mustShipBy == null) {
    return (
      <div className={'shipWin ' + sevClass(0)} title={windowTitle(w)}>
        opens {md(w.windowStart)}
        {w.daysToOpen != null && <span className="winDelta"> · in {w.daysToOpen}d</span>}
      </div>
    )
  }
  return (
    <div className={'shipWin ' + sevClass(sev)} title={windowTitle(w)}>
      {left}{verb} {md(w.mustShipBy)}
      {d != null && <span className="winDelta"> · {d < 0 ? `${-d}d late` : d === 0 ? 'today' : `${d}d`}</span>}
    </div>
  )
}

function windowTitle(w) {
  const bits = []
  if (w.shipNotBefore != null) bits.push(`Partner start date ${md(w.shipNotBefore)}`)
  if (w.headstartDays) bits.push(`${w.headstartDays}d DC headstart → may start ${md(w.opens)}`)
  // ⚠️ Say WHICH document set the date. 'window' means Nima's own hand-set
  // startdate/enddate on the sales order — not the +28 default that used to be read as
  // a ship date, and not a partner's 850. Naming the source is what stops the next
  // person trusting a number without knowing where it came from.
  if (w.source === 'window') {
    if (w.windowStart != null) bits.push(`Ship window opens ${md(w.windowStart)} (NetSuite startdate)`)
    if (w.windowEnd != null) bits.push(`Ship window closes ${md(w.windowEnd)} (NetSuite enddate)`)
  } else {
    bits.push(w.source === 'edi'
      ? `Partner cancels after ${md(w.mustShipBy)} (from their 850)`
      : `Sales order ship date ${md(w.mustShipBy)}`)
  }
  if (w.startBy != null) bits.push(`Start packing by ${md(w.startBy)}`)
  if (w.soPastCancel) bits.push(`⚠ SO ship date ${md(w.soShipDate)} is AFTER the partner's cancel date`)
  return bits.join('\n')
}

// shipWindow hands back epoch-ms day stamps, already local-midnight — so build
// the label off the Date's local parts rather than re-slicing an ISO string.
function md(t) {
  if (t == null) return ''
  const d = new Date(t)
  return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()}`
}

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
                <a className="btnGhost" href={`https://mail.google.com/mail/u/0/#all/${t.emailId || t.threadId}`}
                   target="_blank" rel="noreferrer">↗ Gmail</a>
              )}
              {t.netsuiteDocNumber && DOC_VIEW[t.netsuiteDocType] && (
                <button className="btnGhost" onClick={() => onNavigate?.(DOC_VIEW[t.netsuiteDocType])}>
                  ↗ {t.netsuiteDocType} {t.netsuiteDocNumber}
                </button>
              )}
              {showOpen && onNavigate && <button className="btnGhost" onClick={() => onNavigate('tasks')}>↗ open in Tasks</button>}
            </div>
            {/* Notes on a task (Nima, 2026-08-20: "within task the ability to take
                notes"). NoteWidget's own comment always said it was "meant to drop onto
                any card that has a doc type and number … task" — it had simply never
                been dropped on one. Everything written here lands in the Datapad. */}
            <NoteWidget docType="TASK" docNumber={String(t.id)} />
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

// A PO's DC split. Prefer the real breakdown from the routing feed / custody
// scans (dcList: [{ dc, cartons }]) — the DC isn't in the order ship-to, so
// parsing group members collapses everything into one bucket. Fall back to the
// member parse only when we have no feed/scan data for this PO.
function dcRowsFor(group, dcList) {
  // dcList (from getPoDcs) carries a real store count once the order-level DC is
  // available, plus feed cartons. Prefer stores; fall back to the member parse.
  if (dcList && dcList.length) return dcList.map((d) => ({ dc: d.dc, abbrev: d.dc, stores: d.stores || 0, cartons: d.cartons || 0 }))
  const rows = dcBreakdown(group?.members || [])
  const withDc = rows.filter((r) => r.abbrev)
  if (withDc.length) return withDc
  // ⚠️ NO DC KNOWN YET → ONE PO-LEVEL TAG. DcTagButtons' own contract says "a PO
  // with no DC yet prints a single PO-level tag", and the whole stack supports
  // it — buildDcPdf guards every DC field, the QR degrades to `DC:<po>:`, and
  // recordCustodyScan reads that back as PO-level custody. But this used to end
  // in `.filter(r => r.abbrev)`, which dropped the no-DC bucket and returned
  // [], so the button rendered NOTHING instead of the fallback tag.
  //
  // That is not a rare edge: `parseDc` wants a hierarchical ship-to
  // ("… : Bloomingdale's DC - Secaucus : …") and the live NetSuite sync sends
  // BUILTIN.DF(t.entity), which is the store name alone. Measured 2026-08-02:
  // **0 of 129** EDI orders parse. So every PO outside the routing feed had no
  // tag button at all.
  return rows.length ? [{ dc: null, abbrev: null, stores: rows.reduce((n, r) => n + r.stores, 0), cartons: 0 }] : []
}

// The DC split of a PO group, shown inline: "SC · ST · JP · CI".
export function DcBreakdown({ group, dcList }) {
  // Only the real DC split is worth a chip row — the no-DC fallback row exists
  // so a tag can still be printed, not so an empty chip renders.
  const rows = dcRowsFor(group, dcList).filter((r) => r.abbrev)
  if (!rows.length) return null
  return (
    <span className="dcBreakdown" title="Distribution centers on this PO">
      {rows.map((r) => <span key={r.dc} className="dcChip">{r.abbrev}{r.stores ? `×${r.stores}` : ''}</span>)}
    </span>
  )
}

// Print one consolidation cargo tag PER DC for a PO group (Nima, 2026-07-21):
// each label carries the PO, the DC abbreviation, and that DC's store count —
// PO-referenced, no IF. A PO with no DC yet (unfulfilled / non-Bloomingdale's)
// prints a single PO-level tag.
export function DcTagButtons({ group, dcList }) {
  const [sizes, setSizes] = useState({})
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    if (!_labelSizes) _labelSizes = fetchLabelSizes().catch(() => ({}))
    _labelSizes.then(setSizes)
  }, [])
  const breakdown = dcRowsFor(group, dcList)
  const available = ['4x6', '2.25x1.25'].filter((s) => sizes[s])
  if (!available.length || !breakdown.length) return null
  const n = breakdown.length
  // Name it for what it actually prints: a per-DC consolidation tag, or the
  // single PO-level tag used before the DC is assigned.
  const noDc = n === 1 && !breakdown[0].abbrev
  const what = noDc ? 'PO tag' : `${n} DC tag${n === 1 ? '' : 's'}`

  // EDI labels carry the warehouse location as the customer (Nima, 2026-07-22)
  // — the trailing segment of "Warehouse Bulk : Bloomingdale's" reads as the
  // partner and is cleaner than the long per-store ship-to name.
  const customer = (group.location || '').split(':').pop().trim() || undefined

  async function printAll(size) {
    if (n > 1 && !window.confirm(`Print ${n} DC tags for PO ${group.poNumber}?`)) return
    setBusy(size); setErr(null)
    try {
      for (const r of breakdown) {
        await printCargoTag({ kind: 'dc', poNumber: group.poNumber, dc: r.abbrev, storeCount: r.stores, customer }, size)
      }
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }
  return (
    <span className="tagBtns">
      {available.map((s) => (
        <button key={s} className="linkBtn" disabled={busy === s}
                title={noDc
                  ? `No DC assigned yet — print one PO-level cargo tag for PO ${group.poNumber} (${SIZE_LABEL[s]}). Scans as PO-level custody.`
                  : `Print ${n} per-DC cargo tag${n === 1 ? '' : 's'} for PO ${group.poNumber} (${SIZE_LABEL[s]})`}
                onClick={() => printAll(s)}>
          🖨 {busy === s ? `${SIZE_LABEL[s]}…` : `${what} (${SIZE_LABEL[s]})`}
        </button>
      ))}
      {err && <span className="tagErr">⚠ {err}</span>}
    </span>
  )
}

// Physical custody now lives in the model so it can be unit-tested — see
// src/model/custody.js. Re-exported here because every caller imports it from
// lib.jsx.
// ⚠️ `import` then `export`, NOT `export … from` — a re-export creates no local
// binding, so CustodyBadge below (which calls it) crashed the whole board.
export { cardCustody }

export function CustodyBadge({ card, events, dcList }) {
  const c = cardCustody(card, events, dcList)
  if (!c) return null
  return <span className={'custodyBadge cb-' + c.state}>{c.label}</span>
}

// Human-friendly age from hours.
export function fmtAge(hours) {
  if (hours == null) return 'unknown'
  if (hours < 1) return '<1h old'
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}

// ── Commercial invoice for an international shipment ────────────────────────
//
// Nima, 2026-08-14: "for IF7450 i need to make a DHL label and i need customs
// information per item ... Theres a tool in netsuite that creates the UPS commercial
// invoice for international shipments within UPS i need something like that here."
//
// Lines come live from NetSuite and are grouped by his rule — bags at one price
// together, shoes at one price together, never mixed. The tariff codes are his
// (4202221000 bags / 6404193760 shoes) and the manufacturer ID is the tax ID.
export function CustomsButton({ ifNumber }) {
  const [doc, setDoc] = useState(null)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!ifNumber) return null

  async function load() {
    if (doc) { setOpen((o) => !o); return }
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/customs/${ifNumber}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'could not build it')
      setDoc(j); setOpen(true)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <span className="tagBtns">
      <button className="cardAct actDoc" disabled={busy} onClick={load}
              title="Commercial-invoice lines for an international shipment — grouped by category and price, with tariff codes. Opens here; nothing is sent anywhere.">
        {busy ? 'building…' : '📄 Customs invoice'}
      </button>
      {err && <span className="muted"> {err}</span>}
      {open && doc && (
        <div className="cxDoc">
          <div className="cxHead">
            <b>{doc.ifNumber}</b> · {doc.soNumber} · {doc.customer}
            <span className="muted">
              {' '}{doc.lines.length} line(s) · {doc.totalQty} units · ${doc.totalValue} · {doc.totalWeightLb} lb
            </span>
          </div>
          {/* ⚠️ A partial shipment declares goods that are not in the box. Loud. */}
          {doc.shipmentNote && <div className="banner warn">⚠ {doc.shipmentNote}</div>}
          {/* ⚠️ CHECKED AGAINST NETSUITE AND AGAINST THE BOX — the state that has to be
              visible BEFORE the CSV is downloaded, because the form is trusted once it
              is on a courier's desk. A mispriced item was found here by eye once
              (SO12300, one style at $114 and $102); these say it out loud instead. */}
          {doc.warnings?.length > 0 && (
            <div className="banner warn">
              ⚠ Check before declaring:
              <ul>{doc.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {/* Silence is not proof. A clean check says so, so that "no warning" can be
              told apart from "never checked" — the distinction is the whole point. */}
          {doc.reconciliation && !doc.warnings?.length && (
            <div className="cxOk muted">
              ✓ {doc.reconciliation.checked
                ? `Every line matches ${doc.soNumber} and ${doc.ifNumber} — ${doc.reconciliation.shippedUnits} units, item for item.`
                : 'NOT checked against the fulfilment — NetSuite did not answer.'}
            </div>
          )}
          {/* ⚠️ An unclassified line has NO tariff code. Never let the form look
              finished while one is outstanding — a wrong code is a held shipment. */}
          {!doc.ready && (
            <div className="banner error">
              ⚠ Not ready to file:
              <ul>{doc.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          <table className="cxTable">
            <thead><tr>{doc.dhl.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {doc.dhl.rows.map((row, i) => (
                <tr key={i}>{row.map((c, j) => <td key={j} className={j === 1 ? 'rt-mono' : ''}>{String(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
          <div className="cxFoot">
            <a className="btn" href={`/api/customs/${ifNumber}/dhl.csv`}>⤓ DHL CSV</a>
            <a className="btn" href={`/api/customs/${ifNumber}/ups.csv`}>⤓ UPS CSV</a>
            <span className="muted">Manufacturer ID (tax ID) {doc.taxId} · UPS wants weight PER ITEM, DHL the line total.</span>
          </div>
        </div>
      )}
    </span>
  )
}
