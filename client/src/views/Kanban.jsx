import { useState } from 'react'
import { STAGE_ORDER, STAGE_SHORT, sevClass, Flags, docRef, docDate, SourceBadge, taskToCard, LabelButtons, NEEDS_OPTIONS, URGENCY_OPTIONS, NETSUITE_DOC_TYPES } from '../lib.jsx'
import { groupOrdersByPo } from '../../../src/model/poGroups.js'
import { createTasksBulk } from '../api.js'

// Pipeline as columns: Open → Picked → Packed → Invoiced → Approved → Shipped,
// plus a trailing Tasks column for open quest_tasks (Gmail/Slack
// transmissions promoted to durable tasks) — they have no NetSuite stage, so
// they get their own column rather than being forced into one of the seven.
//
// EDI partners (Bloomingdale's/Nordstrom/Shopbop) split ONE buyer PO into many
// Sales Orders; Nima doesn't want each SO as its own card/task. So orders are
// consolidated by PO number first (groupOrdersByPo) — one card per PO — and any
// card (group or single) can be selected and turned into a task, in bulk, with
// the same completion-requirement + doc-number options the task editor uses.
export default function Kanban({ orders, tasks = [], onRefresh }) {
  const [selected, setSelected] = useState(() => new Set()) // keyed by soNumber (groups use poNumber as soNumber)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState({ needsType: 'none', netsuiteDocType: 'SO', netsuiteDocNumber: '', urgency: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const grouped = groupOrdersByPo(orders)
  const cardKey = (o) => o.soNumber // group rows set soNumber = poNumber
  const byKey = new Map(grouped.map((o) => [cardKey(o), o]))

  const cols = STAGE_ORDER.map((s) => ({
    s,
    items: grouped.filter((o) => o.stage === s).sort((a, b) => b.severity - a.severity),
  })).filter((c) => c.items.length)

  const openTasks = tasks
    .filter((t) => t.status === 'open')
    .map(taskToCard)
    .sort((a, b) => b.severity - a.severity)

  const toggle = (key) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const clearSel = () => setSelected(new Set())

  // Turn each selected card into a task spec. A PO group becomes ONE task for
  // the whole PO (not one per member SO), carrying its member count + the
  // NetSuite refs so it can be closed out.
  function specForCard(o) {
    const isGroup = o.isGroup
    const subject = isGroup
      ? `${o.customer} · PO ${o.poNumber}`
      : `${o.soNumber} · ${o.customer}`
    const snippet = isGroup
      ? `${o.memberCount} sales orders (${o.soNumbers.slice(0, 6).join(', ')}${o.soNumbers.length > 6 ? '…' : ''}) · ${o.nextAction || STAGE_SHORT[o.stage] || o.stage}`
      : (o.nextAction || STAGE_SHORT[o.stage] || o.stage)
    const spec = { subject, snippet, urgency: draft.urgency, needsType: draft.needsType }
    if (draft.needsType === 'netsuite_doc') {
      spec.netsuiteDocType = draft.netsuiteDocType
      // A single doc number only makes sense for a single selected card.
      if (selected.size === 1) spec.netsuiteDocNumber = draft.netsuiteDocNumber
    }
    return spec
  }

  async function createTasks() {
    const specs = [...selected].map((k) => byKey.get(k)).filter(Boolean).map(specForCard)
    if (!specs.length) return
    setBusy(true); setMsg(null)
    try {
      const r = await createTasksBulk(specs)
      setMsg(`Added ${r.created} task${r.created === 1 ? '' : 's'} to the queue.`)
      clearSel(); setComposing(false)
      setDraft({ needsType: 'none', netsuiteDocType: 'SO', netsuiteDocNumber: '', urgency: '' })
      onRefresh?.()
    } catch (e) {
      setMsg('Couldn’t create tasks: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  const selCount = selected.size

  return (
    <div className="kanbanWrap">
      {/* selection / task-composer toolbar */}
      <div className="questBar">
        <span className="hint" style={{ margin: 0 }}>
          {selCount ? `${selCount} selected` : 'Select PO/order cards to add them to your task queue'}
        </span>
        {selCount > 0 && <button className="btnGhost" onClick={clearSel}>Clear</button>}
        {selCount > 0 && !composing && <button className="btn" onClick={() => setComposing(true)}>＋ Create {selCount} task{selCount === 1 ? '' : 's'}</button>}
        {msg && <span className="questMsg">{msg}</span>}
      </div>

      {composing && selCount > 0 && (
        <form className="questComposer" onSubmit={(e) => { e.preventDefault(); createTasks() }}>
          <div className="hint" style={{ width: '100%', margin: '0 0 4px' }}>
            {selCount} task{selCount === 1 ? '' : 's'} · a random crew member is assigned to each.
          </div>
          <label className="composerField">What’s required to complete
            <select className="qtyInput" value={draft.needsType}
                    onChange={(e) => setDraft({ ...draft, needsType: e.target.value })}>
              {NEEDS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {draft.needsType === 'netsuite_doc' && (
            <label className="composerField">Document type
              <select className="qtyInput" value={draft.netsuiteDocType}
                      onChange={(e) => setDraft({ ...draft, netsuiteDocType: e.target.value })}>
                {NETSUITE_DOC_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {draft.needsType === 'netsuite_doc' && selCount === 1 && (
            <label className="composerField">Document # (to close it out)
              <input className="qtyInput" placeholder="e.g. 1213 or IF1213" value={draft.netsuiteDocNumber}
                     onChange={(e) => setDraft({ ...draft, netsuiteDocNumber: e.target.value })} />
            </label>
          )}
          {draft.needsType === 'netsuite_doc' && selCount > 1 && (
            <span className="hint" style={{ alignSelf: 'end' }}>Enter each doc # per task after creating.</span>
          )}
          <label className="composerField">Urgency
            <select className="qtyInput" value={draft.urgency}
                    onChange={(e) => setDraft({ ...draft, urgency: e.target.value })}>
              {URGENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <div className="composerActions">
            <button className="btn" disabled={busy}>{busy ? 'Adding…' : `Add ${selCount} to queue`}</button>
            <button type="button" className="btnGhost" onClick={() => setComposing(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="kanban">
        {cols.map(({ s, items }) => (
          <div className="col" key={s}>
            <div className="colHead">
              {STAGE_SHORT[s]} <span className="count">{items.length}</span>
            </div>
            {items.map((o) => {
              const key = cardKey(o)
              const sel = selected.has(key)
              return (
                <div key={key} className={'kcard ' + sevClass(o.severity) + (sel ? ' selected' : '')}>
                  <div className="krow">
                    <label className="cardPick" title="Select for a task">
                      <input type="checkbox" checked={sel} onChange={() => toggle(key)} />
                    </label>
                    <span className="so">{o.isGroup ? `PO ${o.poNumber}` : o.soNumber}</span>
                    <SourceBadge source={o.source} />
                    {o.isGroup && <span className="badge edi">{o.memberCount} SOs</span>}
                  </div>
                  <div className="cust">{o.customer}</div>
                  {o.isGroup
                    ? <div className="ifs">{o.soNumbers.slice(0, 4).join(', ')}{o.soNumbers.length > 4 ? ` +${o.soNumbers.length - 4}` : ''}</div>
                    : docRef(o) && (
                      <div className="ifs">
                        {docRef(o)}
                        {docDate(o) && <span className="docdate"> · {docDate(o)}</span>}
                      </div>
                    )}
                  <Flags flags={o.flags} />
                  {/* per-IF label print only on single-order cards — a PO group
                      fans back out to many IFs across SOs, not one print action */}
                  {!o.isGroup && (o.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
                    <LabelButtons key={f.ifNumber} info={{ ifNumber: f.ifNumber, soNumber: o.soNumber, customer: o.customer, poNumber: o.poNumber }} />
                  ))}
                </div>
              )
            })}
          </div>
        ))}

        {!!openTasks.length && (
          <div className="col">
            <div className="colHead">
              Tasks <span className="count">{openTasks.length}</span>
            </div>
            {openTasks.map((o) => (
              <div key={o.soNumber} className={'kcard ' + sevClass(o.severity)}>
                <div className="krow">
                  <span className="so">{o.soNumber}</span>
                  <SourceBadge source={o.source} character={o.character} />
                </div>
                <div className="cust">{o.customer}</div>
                <div className="ifs">{o.nextAction}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
