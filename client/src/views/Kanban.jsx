import { useState, useEffect } from 'react'
import { matchesQuery, describeMatch } from '../../../src/model/cardSearch.js'
import { STAGE_ORDER, STAGE_SHORT, docRef, sevClass, Flags, DocRefLinks, docDate, NsLink, SourceBadge, taskToCard, LabelButtons, GroupLabelButtons, DcTagButtons, DcBreakdown, CustodyBadge, cardCustody, ShipWindow, NEEDS_OPTIONS, URGENCY_OPTIONS, NETSUITE_DOC_TYPES, ChannelTag, CustomerName, ShipstationPushButton, ConfirmDepartedButton, CustomsButton } from '../lib.jsx'
import { groupOrdersByPo } from '../../../src/model/poGroups.js'
import { createTasksBulk, fetchPoDcs, fetchRouting, markTransferReceipt, clearTransferReceipt } from '../api.js'
import { isParcelLane, showsParcelPushButton } from '../../../src/model/parcelLane.js'
import { neverLabelledHere } from '../../../src/model/labelSource.js'
import {
  TAB, TAB_LABEL, PC_ORDER, PC_LABEL, PC_IS_WORK, PC_COLOR,
  missionTab, postCustodyState, routingForPo, fulfilledNeverScanned, PC,
} from '../../../src/model/postCustody.js'
import { isDepartureConfirmed } from '../../../src/model/netDeparture.js'
import { allDcTagsScanned } from '../../../src/model/custody.js'
import { transferColumns, transferWorkCount, transferSettledCount, TCOL } from '../../../src/model/transferBoard.js'
import { OUTCOME } from '../../../src/model/transferReceipt.js'

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
export default function Kanban({ orders, transfers = [], tasks = [], events = [], onRefresh }) {
  const [selected, setSelected] = useState(() => new Set()) // keyed by soNumber (groups use poNumber as soNumber)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState({ needsType: 'none', netsuiteDocType: 'SO', netsuiteDocNumber: '', urgency: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  // Finished work is hidden by default (Nima, 2026-08-14) but never discarded.
  const [showSettled, setShowSettled] = useState(false)
  const [query, setQuery] = useState('')
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
  // ⚠️ Counts the RECEIVED transfers too, because the toggle below hides those as well.
  // A toggle that says "7 finished, hidden" while hiding 14 is the same dishonest
  // counter as a tab badge that undercounts its own cards.
  const settledCount = cards.filter((c) => c.settled).length + transferSettledCount(transfers)
  const afterSettled = showSettled ? cards : cards.filter((c) => !c.settled)
  // ⚠️ SEARCH IGNORES THE FINISHED FILTER, and getting this wrong first taught me why.
  // The first cut searched only what was already visible, so typing IF7511 — a real
  // fulfilment, on a real card — answered "nothing matches", because its order had
  // just been invoiced and gone quiet. That is not a filter, it is a lie: an explicit
  // identifier is an explicit request to find THAT thing, and answering "no such
  // record" sends someone hunting in NetSuite for something the app is holding.
  //
  // So a query searches every card, and the count line names how many hits were
  // finished rather than hiding them.
  const searching = !!query.trim()
  const hits = searching ? cards.filter((c) => matchesQuery(c.o, query)) : null
  const visible = searching ? hits : afterSettled
  const finishedHits = searching ? hits.filter((c) => c.settled).length : 0
  // ⚠️ TRANSFERS OBEY THE SAME SEARCH AS THE CARDS BESIDE THEM. Typing TO217 has to
  // find TO217, for the same reason searching ignores the finished filter: an explicit
  // identifier is an explicit request to find THAT thing, and answering "no such
  // record" sends someone hunting in NetSuite for something the app is holding.
  const visibleTransfers = searching ? transfers.filter((t) => matchesQuery(t, query)) : transfers
  const transfersSettled = transferSettledCount(transfers)
  const matchLine = describeMatch({ shown: visible.length + (searching ? visibleTransfers.length : 0), total: cards.length + transfers.length, query })
  const onTab = (t) => visible.filter((c) => c.tab === t)
  // The Orders tab's badge counts the transfers drawn on it — a tab that says 4 and
  // shows 7 cards is the counts-something-other-than-its-label shape this repo keeps
  // finding (npm run check:counters). Received transfers are excluded unless they are
  // being shown, because that is exactly what the columns do.
  const shownTransfers = showSettled || searching ? visibleTransfers.length : visibleTransfers.length - transfersSettled
  const tabCounts = {
    [TAB.ORDERS]: onTab(TAB.ORDERS).length + Math.max(0, shownTransfers),
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
    // ── transfers, BESIDE the sales orders ───────────────────────────────────
    // Nima, 2026-08-27: "everything done by me." One person, one queue — so the
    // transfers get their own columns on THIS tab rather than a tab of their own.
    //
    // ⚠️ They do NOT go through missionTab, and src/model/transferBoard.js holds the
    // measured reason: every live transfer has a fulfilment, so missionTab would have
    // put ZERO of them on the tab Nima asked for them on, and the three picked ones
    // would have landed in "Fulfilled — never scanned out" — a column that is false
    // for a document that is never custody-scanned at all.
    columns.push(...transferColumns(visibleTransfers, { showSettled }))
  } else if (tab === TAB.FULFILMENT) {
    // His words: "if something fullfilled with no scan out we need to be aware
    // since it should be happening one after another." That gap gets its own
    // column rather than sitting quietly inside a stage.
    // ⚠️ The DC lane's evidence is the cargo tag, not the IF slip — so ask about it
    // before accusing a shipment of never being handed over (Nima, 2026-08-18: 28 of 28
    // Nordstrom cards here were false). Same rule check:scan-gaps has used since PR #74.
    // ⚠️ ALL the card's tags, not any one of them: PO 7242989 had CI/JP/ST scanned and SC
    // not, and excusing on `.some()` hid its ten unscanned SC fulfilments.
    const gap = onTab(TAB.FULFILMENT)
      .filter((c) => {
        const dcScanned = allDcTagsScanned(c.o, events, poDcs[c.o.poNumber])
        // ⚠️ FOB China is never scanned out because it is never dispatched by us — see
        // fulfilledNeverScanned. Without this, the two live China fulfilments sat in an
        // accusation column for a scan that could never happen.
        const neverDispatched = neverLabelledHere(c.o.location)
        return (c.o.fulfillments || []).some((f) => fulfilledNeverScanned(f, { dcScanned, neverDispatched }))
      })
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
        <input className="kbSearch" type="search" value={query} placeholder="Search SO · IF · PO · invoice · customer…"
               onChange={(e) => setQuery(e.target.value)}
               title="Matches any identifier on the card or its fulfilments and invoices, plus flag wording." />
        {matchLine && (
          <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>
            {matchLine}
            {finishedHits > 0 && <> · {finishedHits} finished</>}
            {' '}<button className="linkBtn" onClick={() => setQuery('')}>clear</button>
          </span>
        )}
        {settledCount > 0 && !searching && (
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
              // ⚠️ A TRANSFER GETS ITS OWN CARD BODY, and that is not cosmetic. The
              // shared body prints `customer`, and a transfer HAS NO CUSTOMER — its
              // counterpart is a PLACE (Office, Consignment). transferCard.js
              // deliberately leaves `customer` null so nothing can read a location as a
              // company, and the card has to honour that: a transfer sitting
              // anonymously among customer orders is how one gets shipped to a
              // customer address.
              //
              // It also skips CustodyBadge and ShipWindow, which have no meaning here —
              // a transfer is never custody-scanned and carries no partner ship window.
              if (o.isTransfer) return <TransferCard key={key} o={o} colKey={colKey} onRefresh={onRefresh} />
              return (
                <div key={key} className={'kcard ' + sevClass(o.severity) + (sel ? ' selected' : '')}>
                  <div className="krow">
                    <label className="cardPick" title="Select for a task">
                      <input type="checkbox" checked={sel} onChange={() => toggle(key)} />
                    </label>
                    {/* ⚠️ The colour comes from colKey — the SAME value that decided
                        which column this card is in — so the tint and the heading can
                        never disagree. Deriving it from the card again would be a
                        second copy of the state. Absent on the stage-based tabs, where
                        colKey is not a post-custody state, which is correct. */}
                    <span className={'so' + (PC_COLOR[colKey] ? ' so-' + PC_COLOR[colKey] : '')}>
                      {o.isGroup ? `PO ${o.poNumber}` : <NsLink doc={o.soNumber} />}
                    </span>
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
                  {showsParcelPushButton(o) &&
                    (o.fulfillments || []).filter((f) => f.ifNumber && !/shipped/i.test(f.status || '')).map((f) => (
                      // ⚠️ A FRAGMENT, not a comma. `(<A/>, <B/>)` is the comma
                      // operator — it evaluates to B and silently DROPS A, which here
                      // would have removed the ShipStation push button that Nima uses
                      // daily, with no error anywhere.
                      <span key={'acts' + f.ifNumber}>
                        <ShipstationPushButton ifNumber={f.ifNumber} onDone={onRefresh} />
                        <CustomsButton ifNumber={f.ifNumber} />
                      </span>
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

// A transfer as a card. Separate from the sales-order body above because the two
// documents genuinely differ, not because the styling does:
//
//   · NO CUSTOMER — the counterpart is a place. transferCard.js leaves `customer` null
//     on purpose and this prints `destination` instead, labelled "to", so nobody reads
//     a location as a company.
//   · NO CUSTODY — a transfer is never scanned out to Nestor; Nima packs it himself.
//   · NO INVOICE AND NO PAYMENT — it moves our own goods between our own locations, so
//     there is nobody to bill (Nima, 2026-08-27: "no payment invoice needed for
//     transfer orders so once they have a label they can ship").
//
// ⚠️ The ShipStation push passes scope="transfer". Under the default 'boutique' scope
// the server joins `orders` and a transfer is not in it, so the button would answer
// "not in the push scope" every single time. Nima cannot make these labels in NetSuite
// at all, which makes this button the only route to a transfer label.
function TransferCard({ o, colKey, onRefresh }) {
  const tracking = (o.fulfillments || []).flatMap((f) => f.trackingNumbers || []).filter(Boolean)
  return (
    <div className={'kcard ' + sevClass(o.severity) + ' kcard-transfer'}>
      <div className="krow">
        <span className="so"><NsLink doc={o.soNumber} /></span>
        <span className="badge transfer" title="A transfer between our own locations — no customer, no invoice, no payment.">Transfer</span>
      </div>
      {/* The destination stands in for the customer and SAYS SO. */}
      <div className="cust">
        <span className="hint" style={{ margin: 0 }}>to </span>
        <strong>{o.destination || 'an unnamed location'}</strong>
      </div>
      {/* What to do next — the same sentence the column heading is derived from. */}
      {o.nextAction && <div className={'pcWaiting' + (colKey !== TCOL.RECEIPT && colKey !== TCOL.RECEIVED ? ' pcWork' : '')}>{o.nextAction}</div>}
      {/* The fulfilment and its label, when there is one. */}
      {(o.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
        <div className="ifs" key={f.ifNumber}>
          <NsLink doc={f.ifNumber} />{f.status ? ` · ${f.status}` : ''}
        </div>
      ))}
      {/* ⚠️ The tracking number is shown because for a transfer it IS the evidence the
          label exists — there is no invoice to look at instead. */}
      {tracking.length > 0 && <div className="ifs" title="The label exists — this is a transfer's only proof of one.">📦 {tracking.join(', ')}</div>}
      {/* ⚠️ NetSuite leaves a transfer at "Pending Fulfillment" until the far end
          receives it, so this status can NEVER say whether it has been picked. Shown as
          reference only, never as the basis of a column. */}
      {o.toStatus && <div className="hint" style={{ margin: '2px 0 0' }}>{o.toStatus}</div>}
      {/* The label route. Offered while the transfer still needs one — never once it
          has shipped or been received. */}
      {(colKey === TCOL.PACK || colKey === TCOL.LABEL) &&
        (o.fulfillments || []).filter((f) => f.ifNumber && !/shipped/i.test(f.status || '')).map((f) => (
          <ShipstationPushButton key={'ss' + f.ifNumber} ifNumber={f.ifNumber} scope="transfer" onDone={onRefresh} />
        ))}
      {/* The answer only a person has. Offered on the chase list, and on the two
          finished columns as an undo. */}
      {(colKey === TCOL.RECEIPT || colKey === TCOL.RECEIVED || colKey === TCOL.NOT_COMING) && (
        <TransferReceiptControl o={o} colKey={colKey} onDone={onRefresh} />
      )}
    </div>
  )
}

// Marking a transfer's arrival by hand.
//
// ⚠️ THIS EXISTS BECAUSE NOTHING OBSERVES IT. ShipStation's delivery API is behind a
// plan upgrade, NetSuite's "Received" needs the far end to act (Nima: "sometimes they
// dont receive on their end"), and "Closed" is ambiguous — he said it "can be abandoned
// it could also be partially shippedd and the rest of the units abandoned". No field
// answers this, so a person does, and the answer is stored where it can never be
// mistaken for something NetSuite said.
//
// ⚠️ TWO OUTCOMES, NOT ONE. Without "nothing coming", an abandoned transfer would sit on
// the chase list forever — a column that can be looked at and never cleared, which is
// the defect this whole feature was built to remove.
function TransferReceiptControl({ o, colKey, onDone }) {
  const done = colKey === TCOL.RECEIVED || colKey === TCOL.NOT_COMING
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // ⚠️ Defaults to today but stays editable: the far end often confirms days late, and
  // back-dating is the honest record rather than the day someone got round to typing it.
  const [on, setOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')

  const run = async (outcome) => {
    setBusy(true); setErr(null)
    try {
      await markTransferReceipt({ toNumber: o.soNumber, outcome, receivedOn: on, note: note.trim() || null })
      setOpen(false); setNote('')
      onDone?.()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const undo = async () => {
    setBusy(true); setErr(null)
    try { await clearTransferReceipt(o.soNumber); onDone?.() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // Already answered → show what was entered, and offer to take it back.
  if (done) {
    // ⚠️ Only an ENTERED answer is undoable. A NetSuite "Received" is not ours to
    // retract, and offering a button that cannot work is the dead-button shape.
    if (!o.receipt) return <div className="hint" style={{ margin: '2px 0 0' }}>confirmed in NetSuite</div>
    return (
      <div className="hint" style={{ margin: '2px 0 0' }}>
        {o.receipt.outcome === OUTCOME.RECEIVED ? 'received' : 'written off'} {o.receipt.receivedOn}
        {o.receipt.note ? ` · ${o.receipt.note}` : ''}{' '}
        <button className="linkBtn" onClick={undo} disabled={busy}>undo</button>
        {err && <span className="questMsg"> {err}</span>}
      </div>
    )
  }

  if (!open) {
    return (
      <div>
        <button className="btnGhost" onClick={() => setOpen(true)}>✓ Mark received…</button>
        {err && <span className="questMsg"> {err}</span>}
      </div>
    )
  }
  return (
    <div className="questComposer" style={{ padding: 6, gap: 6 }}>
      <label className="composerField" style={{ fontSize: 11 }}>Date
        <input className="qtyInput" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
      </label>
      <label className="composerField" style={{ fontSize: 11 }}>How you know (optional)
        <input className="qtyInput" placeholder="e.g. Maria confirmed by text" value={note}
               onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="composerActions">
        <button className="btn" disabled={busy} onClick={() => run(OUTCOME.RECEIVED)}>
          {busy ? 'Saving…' : 'It arrived'}
        </button>
        {/* ⚠️ Says NOTHING CAME, never "received" — the goods did not arrive, and this is
            the one record that exists to catch stock that never turned up. */}
        <button className="btnGhost" disabled={busy} onClick={() => run(OUTCOME.NOT_COMING)}
                title="Closed out or abandoned — stop chasing it. This does NOT record an arrival.">
          Nothing coming
        </button>
        <button type="button" className="btnGhost" onClick={() => { setOpen(false); setErr(null) }}>Cancel</button>
      </div>
      {err && <span className="questMsg">{err}</span>}
    </div>
  )
}
