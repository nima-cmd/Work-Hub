import { useState, useEffect } from 'react'
import { STAGE_ORDER, STAGE_SHORT, docRef, sevClass, Flags, DocRefLinks, docDate, NsLink, SourceBadge, taskToCard, LabelButtons, GroupLabelButtons, DcTagButtons, DcBreakdown, CustodyBadge, cardCustody, ShipWindow, NEEDS_OPTIONS, URGENCY_OPTIONS, NETSUITE_DOC_TYPES, ChannelTag, CustomerName, ShipstationPushButton, ConfirmDepartedButton } from '../lib.jsx'
import { groupOrdersByPo } from '../../../src/model/poGroups.js'
import { createTasksBulk, fetchPoDcs, fetchRouting } from '../api.js'
import { isParcelLane } from '../../../src/model/parcelLane.js'
import {
  TAB, TAB_LABEL, PC_ORDER, PC_LABEL, PC_IS_WORK,
  missionTab, postCustodyState, routingForPo, fulfilledNeverScanned, PC,
} from '../../../src/model/postCustody.js'
import { isDepartureConfirmed } from '../../../src/model/netDeparture.js'

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
export default function Kanban({ orders, tasks = [], events = [], onRefresh }) {
  const [selected, setSelected] = useState(() => new Set()) // keyed by soNumber (groups use poNumber as soNumber)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState({ needsType: 'none', netsuiteDocType: 'SO', netsuiteDocNumber: '', urgency: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  // Finished work is hidden by default (Nima, 2026-08-14) but never discarded.
  const [showSettled, setShowSettled] = useState(false)
  // Real per-PO DC breakdown (routing feed ∪ custody scans) — the DC isn't in
  // the order ship-to, so the DC-tag button gets it from here instead.
  const [poDcs, setPoDcs] = useState({})
  useEffect(() => { fetchPoDcs().then(setPoDcs).catch(() => {}) }, [])
  // Routing shipments — the possession tab needs them to tell "route it" from
  // "the carrier is booked". A card carries no shipment id; the PO is looked up
  // inside memberPos (routingForPo).
  const [shipments, setShipments] = useState([])
  useEffect(() => { fetchRouting().then((r) => setShipments(r?.shipments || [])).catch(() => {}) }, [])
  // Opens on the possession tab: it is the one that answers "what do I do now".
  const [tab, setTab] = useState(TAB.ACTION)

  const grouped = groupOrdersByPo(orders)
  const cardKey = (o) => o.soNumber // group rows set soNumber = poNumber
  const byKey = new Map(grouped.map((o) => [cardKey(o), o]))
  const bySev = (a, b) => b.severity - a.severity

  // Custody scan states become their own columns so the board shows the physical
  // flow (Nima, 2026-07-22): scanned OUT → "With Nestor"; scanned back IN →
  // "Ball's in our court". A scanned card leaves its stage column for the custody
  // column. Shipped/departed cards stay put (their scans are historical).
  const custodyOf = (o) => (o.stage === 'SHIPPED' ? null : cardCustody(o, events, poDcs[o.poNumber]))

  // THREE TABS (Nima, 2026-08-07 — "we may want to break it up into three tabs
  // in terms of mission quest kanban so we have more screen space", and
  // confirmed after: "making in our posseson its own tab is a good idea").
  //
  // What this replaced: ONE row of up to ten columns, in which every actionable
  // card collapsed into a single "Ball's in Our Court" pile. Measured 2026-08-07:
  // 26 cards there (16 Picked, 7 Invoiced, 3 Approved) with every stage column
  // behind it at 0 and only Shipped populated past it. The board could say the
  // goods were here and nothing about what they needed.
  //
  // ⚠️ 'partial' belongs with 'returned' (2026-08-06): cardCustody gained that
  // state when the returned branch stopped rounding a part-scanned card up to
  // fully-back, and filtering on 'returned' alone made such a card vanish from
  // the board entirely. Both are "in our possession", so both start tab ③ —
  // missionTab holds that rule and is tested.
  const cards = grouped.map((o) => {
    const custody = custodyOf(o)
    const fulfilments = o.fulfillments || []
    const departed = o.stage === 'SHIPPED'
    const t = missionTab({ fulfilments, custodyState: custody?.state ?? null, departed })
    // Only the possession tab asks the question, so only it pays for the answer.
    const pc = t === TAB.ACTION
      ? postCustodyState({ ...o, fulfilments, departed, routing: routingForPo(shipments, o.poNumber) })
      : null
    // ⚠️ Nima, 2026-08-14: "we only need to look at what currently needs work in this
    // view." A card whose every fulfilment is SETTLED — shipped and invoiced, and
    // departure-confirmed where the Net flow demands it — is finished, and 181 of 214
    // fulfilments were finished when this landed. The rule lives in
    // src/model/netDeparture.js so this view does not own it.
    //
    // A card with NO fulfilments is never settled: nothing has shipped yet, which is
    // the most unfinished a card can be.
    const settled = fulfilments.length > 0 && fulfilments.every((f) => f.settled)
    return { o, custody, tab: t, pc, settled }
  })
  // Hidden, not discarded — the toggle below brings them back. A board that silently
  // drops rows is indistinguishable from a board that lost them.
  const settledCount = cards.filter((c) => c.settled).length
  const visible = showSettled ? cards : cards.filter((c) => !c.settled)
  const onTab = (t) => visible.filter((c) => c.tab === t)
  const tabCounts = {
    [TAB.ORDERS]: onTab(TAB.ORDERS).length,
    [TAB.FULFILMENT]: onTab(TAB.FULFILMENT).length,
    [TAB.ACTION]: onTab(TAB.ACTION).length,
  }
  // How much of the possession tab is actually OURS to move — the number the old
  // board could never give. Live 2026-08-07: 4 work against 87 watching.
  const workCount = onTab(TAB.ACTION).filter((c) => c.pc?.isWork).length

  const columns = []
  if (tab === TAB.ORDERS) {
    // Pending Approval, then Pending Fulfillment — "sales orders that have no
    // fulfilment".
    for (const s of ['ON_HOLD_APPROVAL', 'OPEN_NEEDS_FULFILLMENT']) {
      const items = onTab(TAB.ORDERS).filter((c) => c.o.stage === s).map((c) => c.o).sort(bySev)
      if (items.length) columns.push({ key: s, label: STAGE_SHORT[s], items })
    }
    // Anything else that landed here (a stage we didn't name) still gets drawn,
    // rather than being silently dropped off the board.
    const named = new Set(['ON_HOLD_APPROVAL', 'OPEN_NEEDS_FULFILLMENT'])
    const rest = onTab(TAB.ORDERS).filter((c) => !named.has(c.o.stage)).map((c) => c.o).sort(bySev)
    if (rest.length) columns.push({ key: 'other_orders', label: 'Other', items: rest })
  } else if (tab === TAB.FULFILMENT) {
    // His words: "if something fullfilled with no scan out we need to be aware
    // since it should be happening one after another." That gap gets its own
    // column rather than sitting quietly inside a stage.
    const gap = onTab(TAB.FULFILMENT)
      .filter((c) => (c.o.fulfillments || []).some(fulfilledNeverScanned))
      .map((c) => c.o).sort(bySev)
    const nestor = onTab(TAB.FULFILMENT)
      .filter((c) => c.custody?.state === 'warehouse')
      .map((c) => c.o).sort(bySev)
    const gapKeys = new Set(gap.map(cardKey))
    if (gap.length) columns.push({ key: 'never_scanned', label: 'Fulfilled — never scanned out', items: gap, custody: true })
    if (nestor.length) columns.push({ key: 'with_nestor', label: 'With Nestor — being packed', items: nestor.filter((o) => !gapKeys.has(cardKey(o))), custody: true })
    const shown = new Set([...gap, ...nestor].map(cardKey))
    const rest = onTab(TAB.FULFILMENT).filter((c) => !shown.has(cardKey(c.o))).map((c) => c.o).sort(bySev)
    if (rest.length) columns.push({ key: 'other_ff', label: 'Fulfilled', items: rest })
  } else {
    // ③ In Our Possession — one column per post-custody state, in flow order,
    // each saying what the card is waiting ON. Work columns are marked; the rest
    // are watches, and saying so is the point (28 tendered EDI cards were once
    // reported as "nothing done").
    const byState = new Map()
    for (const c of onTab(TAB.ACTION)) {
      if (!c.pc) continue // no fulfilment → nothing to name; see postCustody.js
      if (!byState.has(c.pc.key)) byState.set(c.pc.key, [])
      byState.get(c.pc.key).push(c)
    }
    for (const k of PC_ORDER) {
      const items = (byState.get(k) || []).sort((a, b) => b.o.severity - a.o.severity)
      if (!items.length) continue
      columns.push({
        key: k, label: PC_LABEL[k], work: PC_IS_WORK[k],
        items: items.map((c) => c.o), waiting: new Map(items.map((c) => [cardKey(c.o), c.pc.waitingOn])),
      })
    }
  }

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
      <div className="rt-tabs" style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {[TAB.ORDERS, TAB.FULFILMENT, TAB.ACTION].map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {TAB_LABEL[t]} <span className="count">{tabCounts[t]}</span>
          </button>
        ))}
        {tab === TAB.ACTION && (
          <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>
            {workCount ? `${workCount} to act on` : 'nothing to act on'} · {tabCounts[TAB.ACTION] - workCount} waiting
          </span>
        )}
        {/* ⚠️ ALWAYS SAYS HOW MANY ARE HIDDEN. A board that silently drops finished
            cards is indistinguishable from one that lost them — and "where did it go"
            is the question this app exists to stop people asking. */}
        {settledCount > 0 && (
          <label className="hint" style={{ margin: 0, alignSelf: 'center', display: 'inline-flex', gap: 5, alignItems: 'center' }}
                 title="Shipped and invoiced — and departure-confirmed where Net terms require it.">
            <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} />
            {showSettled ? `showing ${settledCount} finished` : `${settledCount} finished, hidden`}
          </label>
        )}
      </div>

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
        {columns.map(({ key: colKey, label, items, custody, work, waiting }) => (
          <div className={'col' + (custody ? ' col-custody col-' + colKey : '') + (work ? ' col-work' : '')} key={colKey}>
            <div className="colHead">
              {work && <span title="ours to move now">▶ </span>}{label} <span className="count">{items.length}</span>
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
                    <span className="so">{o.isGroup ? `PO ${o.poNumber}` : <NsLink doc={o.soNumber} />}</span>
                    <SourceBadge source={o.source} />
                    {o.isGroup && <span className="badge edi">{o.memberCount} SO{o.memberCount === 1 ? '' : 's'}</span>}
                  </div>
                  <div className="cust"><ChannelTag order={o} /> <CustomerName order={o} /></div>
                  {/* What this card is WAITING ON — the sentence comes from the
                      same call as the column it sits in, so the two cannot drift
                      (the labelGap lesson: a row's sentence and its kind must be
                      one derivation). */}
                  {waiting?.get(cardKey(o)) && (
                    <div className={'pcWaiting' + (work ? ' pcWork' : '')}>{waiting.get(cardKey(o))}</div>
                  )}
                  <ShipWindow window={o.shipWindow} />
                  <CustodyBadge card={o} events={events} dcList={poDcs[o.poNumber]} />
                  {o.isGroup
                    ? <div className="ifs">{o.soNumbers.slice(0, 4).join(', ')}{o.soNumbers.length > 4 ? ` +${o.soNumbers.length - 4}` : ''}</div>
                    : docRef(o) && (
                      <div className="ifs">
                        <DocRefLinks o={o} />
                        {docDate(o) && <span className="docdate"> · {docDate(o)}</span>}
                      </div>
                    )}
                  <Flags flags={o.flags} />
                  {/* single-order cards print their one IF tag; a PO group prints
                      every member IF's tag at once (GroupLabelButtons) */}
                  {!o.isGroup && (o.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
                    <LabelButtons key={f.ifNumber} info={{ ifNumber: f.ifNumber, soNumber: o.soNumber, customer: o.customer, poNumber: o.poNumber }} />
                  ))}
                  {/* "It left." Only on the column that asks for it, so the
                      button appears exactly where the board says the work is —
                      and only on the fulfilments still awaiting it, not every IF
                      on the card. */}
                  {colKey === PC.SHIPPED_AWAITING_DEPARTURE && !o.isGroup &&
                    (o.fulfillments || []).filter((f) => f.ifNumber && !isDepartureConfirmed(f)).map((f) => (
                      <ConfirmDepartedButton key={'dep' + f.ifNumber} ifNumber={f.ifNumber} onDone={onRefresh} />
                    ))}
                  {/* Break-glass push, per fulfilment (Nima, 2026-08-11) — for when
                      NetSuite's UPS label creator is playing up and the data is
                      better pushed than re-keyed. Offered on the parcel lane only:
                      an EDI freight shipment's label question is a BOL, not a
                      parcel label. Nothing is pushed until it's clicked. */}
                  {!o.isGroup && (o.source !== 'edi' || isParcelLane(o)) &&
                    (o.fulfillments || []).filter((f) => f.ifNumber && !/shipped/i.test(f.status || '')).map((f) => (
                      <ShipstationPushButton key={'ss' + f.ifNumber} ifNumber={f.ifNumber} onDone={onRefresh} />
                    ))}
                  {o.isGroup && o.source === 'edi' && <><DcBreakdown group={o} dcList={poDcs[o.poNumber]} /><DcTagButtons group={o} dcList={poDcs[o.poNumber]} /></>}
                  {o.isGroup && o.source !== 'edi' && <GroupLabelButtons group={o} />}
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
                  <span className="so"><NsLink doc={o.soNumber} /></span>
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
