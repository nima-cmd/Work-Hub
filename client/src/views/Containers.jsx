// client/src/views/Containers.jsx — the vessels, one row each.
//
// Step 3 of the container work. Steps 1 and 2 built the identity, the China leg and the
// delivery state; all of it lived in `scripts/check-containers.js`, which is to say it
// lived nowhere a person would look.
//
// ⚠️ THIS FILE DECIDES NOTHING. Every state, sentence and action comes from the API,
// which gets them from tested pure functions in src/model/container*.js. Logic in a
// .jsx is logic with no test — the rule from [[marked-shipped-is-not-departed]], where
// a routing decision lived in a component and could not be exercised.
//
// ⚠️ AND THE THREE DELIVERY STATES ARE DRAWN AS THREE THINGS. "unknown" is not a pale
// version of "not delivered": a container in the Pacific and one sitting in the yard
// since Tuesday both have no receipt, and the whole point of the model is that they are
// different. They get different colours and different words, never one greyed-out row.

import { useEffect, useState } from 'react'
import { fetchContainers, markContainerDelivered, setTransferPurpose, confirmPoSeason, setContainerMode, linkPoToOrder } from '../api.js'

const d = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null)
const todayIso = () => new Date().toISOString().slice(0, 10)

// ⚠️ Each state gets its own label AND its own tone. See the header.
const DELIVERY = {
  received: { tone: 'sev-lo', word: 'Received' },
  delivered: { tone: 'sev-hi', word: 'On our floor' },
  unknown: { tone: '', word: 'Not known' },
}

function NsLink({ doc }) {
  // The trace drawer already resolves a document number to its NetSuite page via
  // /api/netsuite/open — the page name comes from NetSuite's own `recordtype`, never
  // from our prefix ([[open-in-netsuite-links]]).
  return (
    <a className="ns-link" href={`/api/netsuite/open?doc=${encodeURIComponent(doc)}`}
       target="_blank" rel="noreferrer" title={`Open ${doc} in NetSuite`}>{doc}</a>
  )
}

function Arrived({ container, onDone }) {
  const [open, setOpen] = useState(false)
  // ⚠️ SEEDED WITH TODAY, WHICH IS NOT THE SAME AS DEFAULTING TO IT. The field is
  // visible and editable before anything is sent, and the server refuses a missing
  // date outright. Seeding a form is a convenience; defaulting a stored fact is
  // [[default-is-not-an-answer]].
  const [on, setOn] = useState(todayIso())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  if (!open) {
    return <button className="btn-small" onClick={() => setOpen(true)}>It arrived…</button>
  }
  const send = async () => {
    setBusy(true); setErr(null)
    try {
      await markContainerDelivered(container.label, { deliveredOn: on, by: 'Nima', note: note || null })
      setOpen(false)
      await onDone()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="arrived-form">
      <label>
        Arrived on{' '}
        <input type="date" value={on} max={todayIso()} onChange={(e) => setOn(e.target.value)} />
      </label>
      <input className="arrived-note" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn-small" disabled={busy || !on} onClick={send}>{busy ? 'Recording…' : 'Record'}</button>
      <button className="btn-small btn-quiet" onClick={() => { setOpen(false); setErr(null) }}>Cancel</button>
      {/* ⚠️ The failure is SHOWN. A silent catch here is how the app once reported a
          delivery that was never written. */}
      {err && <div className="arrived-err">{err}</div>}
    </div>
  )
}

// ⚠️ EACH RISK STATE IS ITS OWN WORD AND TONE. "no-deadline" is not a pale "ok": a
// restock genuinely has no drop to miss, and drawing it like a passing grade implies a
// deadline was checked and met.
const RISK = {
  late: { tone: 'sev-hi', word: 'LATE' },
  tight: { tone: 'sev-mid', word: 'Tight' },
  ok: { tone: 'sev-lo', word: 'In time' },
  'no-deadline': { tone: '', word: 'No drop deadline' },
  unknown: { tone: '', word: '' },
}

// The season a PO is for: suggested from its items, confirmed by a person.
//
// ⚠️ A SUGGESTION IS DRAWN AS A SUGGESTION. The select is not pre-filled with the guess —
// it opens empty with the guess offered beside it as a button, because a pre-filled
// dropdown somebody tabs past becomes a stored decision nobody made
// ([[default-is-not-an-answer]]).
function Season({ t, seasons = [], seasonYears = [], reasons = [], onChange }) {
  const st = t.seasonState || {}
  const [open, setOpen] = useState(false)
  const [season, setSeason] = useState(st.state === 'confirmed' ? st.label : '')
  const [drop, setDrop] = useState(st.drop ?? '')
  const [reason, setReason] = useState(st.reason ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const risk = RISK[t.dropRisk?.state] || RISK.unknown

  if (!t.poNumber) return null

  const save = async (override) => {
    setBusy(true); setErr(null)
    try {
      await confirmPoSeason(t.poNumber, override || { season, drop: drop || null, reason: reason || null, by: 'Nima' })
      setOpen(false); await onChange()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="c-season">
      {st.state === 'confirmed' ? (
        <>
          {/* ⚠️ EVERY CONFIRMED SEASON, WITH ITS UNITS. 46% of POs span more than one,
              and PO1777's single "Fall 2025" label was hiding 140 units of Fall 2026. */}
          <span className="c-season-on">
            {(st.seasons?.length ? st.seasons : [st.label]).map((x, i) => (
              <span key={x} className="c-season-chip">
                {i > 0 ? ' · ' : ''}{x}{st.units?.[x] != null ? <small> {st.units[x]}u</small> : null}
              </span>
            ))}
            {st.drop ? ` · drop ${st.drop}` : ''}{st.reason ? ` · ${st.reason}` : ''}
            {st.by ? <small> · {st.by}</small> : null}
          </span>
          {/* ⚠️ A DISAGREEMENT WITH THE ITEMS IS NAMED, not blocked — they may know
              something the catalogue does not. */}
          {st.differs && <span className="c-warn">⚠ {st.differs}</span>}
          <button className="btn-small btn-quiet" onClick={() => setOpen(true)}>change</button>
        </>
      ) : open ? null : (
        <>
          <span className="c-season-none">
            {st.label
              ? <>Season <b>not confirmed</b> — items say <b>{st.label}</b>{st.confident ? '' : ' (not a majority)'}</>
              : <>Season <b>unknown</b></>}
            {/* The calendar's read on WHY, shown even before anything is confirmed. */}
            {st.reason ? <> · looks like a <b>{st.reason}</b>{st.reasonConfident ? '' : ' (not sure)'}</> : null}
          </span>
          {/* ⚠️ ONE CLICK ONLY WHEN THE APP IS CONFIDENT. A tie or a bare plurality gets
              the full form instead, because those are the cases that need a person. */}
          {st.label && st.confident && (st.seasons || []).length <= 1 && (
            <button className="btn-small" disabled={busy}
                    onClick={() => save({ season: st.label, reason: st.reason || null, by: 'Nima' })}>
              Accept {st.label}
            </button>
          )}
          {/* ⚠️ A MULTI-SEASON PO GETS "ACCEPT ALL", NOT A WINNER. Offering only the
              dominant season is what hid 140 units of Fall 2026 on PO1777. The lead is
              still the biggest — it is what a launch deadline hangs off — but the
              others come with it. */}
          {(st.seasons || []).length > 1 && (
            <button className="btn-small" disabled={busy}
                    onClick={() => save({ season: st.label, seasons: st.seasons, reason: st.reason || null, by: 'Nima' })}>
              Accept all {st.seasons.length} ({st.seasons.join(' + ')})
            </button>
          )}
          <button className="btn-small btn-quiet" onClick={() => setOpen(true)}>set…</button>
        </>
      )}

      {open && (
        <span className="c-season-form">
          {/* ⚠️ THE YEAR IS PART OF THE SEASON AND COMES FROM THE DATA. This used to
              build options as `${season} ${thisYear}`, which cannot express PO1754's
              Spring 2027 — stock for next year's drop, already on a container. Nima,
              2026-09-16: "we need to keep the year in the list of information for the
              purchase orders as well." The years are the ones actually on these POs,
              served by the API, plus next year for a forward booking. */}
          <select value={season} onChange={(e) => setSeason(e.target.value)}>
            <option value="">— season —</option>
            {st.mix?.length ? (
              <optgroup label="on this PO">
                {st.mix.map((m) => <option key={m.label} value={m.label}>{m.label} — {m.units} units</option>)}
              </optgroup>
            ) : null}
            <optgroup label="any season">
              {seasonYears.flatMap((y) => seasons.map((x) => (
                <option key={`${x} ${y}`} value={`${x} ${y}`}>{x} {y}</option>
              )))}
            </optgroup>
          </select>
          <select value={drop} onChange={(e) => setDrop(e.target.value)}>
            <option value="">— drop —</option>
            <option value="1">Drop 1</option>
            <option value="2">Drop 2</option>
          </select>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— why —</option>
            {reasons.map((r) => <option key={r.key} value={r.key} title={r.detail}>{r.label}</option>)}
          </select>
          {/* ⚠️ OFFERED, NOT PRE-SELECTED, and it says how sure it is. The calendar
              decides this — Fall stock arriving AFTER Fall Drop 2 is a restock of goods
              that sold through, not the launch — and "after its drop" is only usually a
              restock: it can equally be a launch that slipped. */}
          {st.reason && st.reason !== reason && (
            <button className="btn-small btn-quiet" title={st.reasonWhy}
                    onClick={() => setReason(st.reason)}>
              {st.reasonConfident ? '' : 'maybe '}{st.reason}?
            </button>
          )}
          <button className="btn-small" disabled={busy || !season} onClick={() => save()}>{busy ? 'Saving…' : 'Confirm'}</button>
          <button className="btn-small btn-quiet" onClick={() => { setOpen(false); setErr(null) }}>Cancel</button>
          {/* Clearing returns the card to showing the suggestion. */}
          {st.state === 'confirmed' && (
            <button className="btn-small btn-quiet" disabled={busy}
                    onClick={() => save({ season: null, by: 'Nima' })}>Clear</button>
          )}
        </span>
      )}

      {risk.word && <span className={`pill ${risk.tone}`} title={t.dropRisk.why}>{risk.word}</span>}
      {t.dropRisk?.why && t.dropRisk.state !== 'unknown' && <span className="c-risk-why">{t.dropRisk.why}</span>}
      {err && <span className="c-warn">{err}</span>}
    </div>
  )
}

// One transfer order: the PO it draws on, the China receipt that dated the invoice, where
// it lands, and what it is for.
//
// ⚠️ THE PO AND THE RECEIPT ARE NOT DECORATION. Nima's own account of the flow: "we
// receive the units in china to mark the date that the factory completes them... the
// receive is for accounting... once we receive the units in china we have a transfer
// order which we leave a link to the original PO in the transfer order so we know what
// PO its for." Those three documents are the chain, and until now the card showed one.
function Leg({ t, seasons, seasonYears, reasons, onChange }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(t.purpose || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const p = t.purposeState

  const save = async () => {
    setBusy(true); setErr(null)
    try { await setTransferPurpose(t.toNumber, { purpose: text, by: 'Nima' }); setEditing(false); await onChange() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <li className="c-to">
      <div className="c-to-top">
        <NsLink doc={t.toNumber} />
        <span className="c-status">{String(t.status || '').replace('Transfer Order : ', '')}</span>
        <span className="c-units">{t.units} units</span>
        {t.poNumber ? <NsLink doc={t.poNumber} /> : <span className="c-status">no PO linked</span>}
        {/* The China receipt — the factory-complete date the vendor invoice must match. */}
        {t.receiptNumber ? <NsLink doc={t.receiptNumber} /> : null}
          {t.receivedOn ? <span className="c-rcv">received {d(t.receivedOn)}</span> : null}
        {/* The order this PO exists for, when somebody has linked one. */}
        {(t.orderLinks || []).map((o) => (
          <span key={o.docNumber} className="c-order">for <NsLink doc={o.docNumber} /></span>
        ))}
      </div>
      <Season t={t} seasons={seasons} seasonYears={seasonYears} reasons={reasons} onChange={onChange} />
      <div className="c-to-purpose">
        <span className="c-dest">→ {t.destination || 'no destination'}</span>
        {/* ⚠️ AN OBSERVED PURPOSE IS NOT EDITABLE HERE. NetSuite already routes these
            units to a partner floor; retyping it is how two copies start disagreeing. */}
        {p.source?.kind === 'observed' ? (
          <span className="c-purpose is-observed">{p.detail}</span>
        ) : editing ? (
          <span className="c-purpose">
            <input className="c-purpose-in" value={text} autoFocus
                   placeholder="what are these units for?"
                   onChange={(e) => setText(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }} />
            <button className="btn-small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn-small btn-quiet" onClick={() => { setEditing(false); setText(t.purpose || ''); setErr(null) }}>Cancel</button>
          </span>
        ) : (
          <button className="c-purpose-btn" onClick={() => setEditing(true)}
                  title={p.detail}>
            {/* ⚠️ "no purpose set" IS A REAL STATE, not an empty field to be embarrassed
                about. 135 of 181 transfer orders are here, and NetSuite has nowhere to
                record it — which is the whole reason this exists. */}
            {p.state === 'known' ? p.detail : '+ no purpose set'}
          </button>
        )}
        {/* ⚠️ A DISAGREEMENT IS NAMED, NEVER RESOLVED — custody.js's rule. */}
        {p.conflict && <span className="c-warn">⚠ {p.conflict}</span>}
        {err && <span className="c-warn">{err}</span>}
      </div>
    </li>
  )
}

// ⚠️ THE MODE IS WHAT UNLOCKS EVERY ETA. It is NULL on every container, so estimateEta
// refuses and 8 of 21 completed round trips sit in transitStats' anomaly list as "no mode
// — cannot be attributed to air or sea". The history is there; this button is the gap.
function Mode({ c, onChange }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = async (mode) => {
    setBusy(true); setErr(null)
    try { await setContainerMode(c.label, mode); await onChange() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  if (c.mode) {
    return (
      <span className="c-mode">
        Mode <b>{c.mode}</b>{c.modeSource ? <small> · {c.modeSource}</small> : null}
        <button className="btn-small btn-quiet" disabled={busy} onClick={() => set(null)}>unset</button>
      </span>
    )
  }
  return (
    <span className="c-mode">
      Mode <b>not set</b>
      {/* ⚠️ The suggestion is OFFERED, never stored — a guess in the column would be
          indistinguishable from a decision, and mode picks which transit median applies. */}
      {c.modeSuggested ? <> — looks like <b>{c.modeSuggested}</b> from the name</> : null}
      {c.modeSuggested && (
        <button className="btn-small" disabled={busy} onClick={() => set(c.modeSuggested)}>
          Accept {c.modeSuggested}
        </button>
      )}
      <button className="btn-small btn-quiet" disabled={busy} onClick={() => set('air')}>air</button>
      <button className="btn-small btn-quiet" disabled={busy} onClick={() => set('sea')}>sea</button>
      {err && <span className="c-warn">{err}</span>}
    </span>
  )
}

function Container({ c, seasons, seasonYears, reasons, onChange }) {
  const del = DELIVERY[c.delivery.state] || DELIVERY.unknown
  return (
    <section className="container-card">
      <header>
        <h3>{c.displayName}</h3>
        <span className={`pill ${del.tone}`}>{del.word}{c.delivery.on ? ` · ${d(c.delivery.on)}` : ''}</span>
      </header>
      <p className="c-sub">
        {c.cartons} cartons · {c.units} units · POs {c.pos.join(', ') || '—'}
      </p>

      {/* ⚠️ THE REASON IS ALWAYS SHOWN, including for "not known". A state with no
          explanation is the thing that gets argued with; this is the sentence the model
          wrote, verbatim. */}
      <p className="c-why">{c.delivery.why}</p>

      <dl className="c-dates">
        {/* ⚠️ "Packed" NOT "departed". Nima: it is the date the factory says it is
            finished, and on the 59 that was 8 days before the vessel sailed. */}
        <div><dt>Packed (slip)</dt><dd>{d(c.packedOn) || '—'}</dd></div>
        <div><dt>Sailed (GLC)</dt><dd>{d(c.etdOn) || '— not given'}</dd></div>
        <div>
          <dt>ETA</dt>
          <dd>{d(c.etaOn) || '— none'}{c.etaSource ? <small> · {c.etaSource}</small> : null}</dd>
        </div>
        <div><dt>Port arrival</dt><dd>{d(c.portArrivedOn) || '— not yet'}</dd></div>
      </dl>

      {/* ⚠️ THE ANCHOR IS NAMED. Two containers whose clocks start from different dates
          must not look like the same measurement. */}
      {c.anchor && <p className="c-anchor">Clock runs {c.anchor.measures} (from {c.anchor.label})</p>}
      {c.unusable && <p className="c-anchor">{c.unusable.days}d {c.unusable.label}</p>}

      {/* ⚠️ THE BREAKDOWN DOES NOT PICK A WINNER — a container carries stock for several
          partners at once, so one "purpose" would erase the answer. */}
      {(c.purposes.roles.length > 0 || c.purposes.unassigned > 0) && (
        <p className="c-roles">
          {c.purposes.roles.map((r) => (
            <span key={r.role} className="c-role">{r.partner || r.role} <b>{r.units}</b></span>
          ))}
          {c.purposes.unassigned > 0 && (
            <span className="c-role c-role-none">{c.purposes.unassigned} with no purpose set</span>
          )}
        </p>
      )}

      <div className="c-leg">
        <strong>China leg — {c.leg.known ? c.leg.leg : c.leg.why}</strong>
        <ul className="c-tos">
          {c.transferOrders.map((t) => <Leg key={t.toNumber} t={t} seasons={seasons} seasonYears={seasonYears} reasons={reasons} onChange={onChange} />)}
        </ul>
        {/* ⚠️ An unrecognised NetSuite status is NAMED, not folded into a neighbour. */}
        {c.leg.unrecognised?.length ? <p className="c-warn">⚠ unrecognised: {c.leg.unrecognised.join(', ')}</p> : null}
      </div>

      <div className="c-next">
        <strong>Next</strong>
        <p>{c.next.action}</p>
        {c.next.why && <p className="c-why">{c.next.why}</p>}
        {/* Where to look, keyed on what we can observe — a trackable number or the
            forwarder — never on a guess about how the freight travels. */}
        {c.next.lookup?.kind === 'tracking' && (
          <p className="c-track">{c.next.lookup.carrier || 'Tracking'} · <code>{c.next.lookup.number}</code></p>
        )}
      </div>

      <footer className="c-foot">
        {/* ⚠️ THE MODE IS A SUGGESTION UNTIL SOMEBODY CHOOSES IT, and the screen says
            which. A stored guess is indistinguishable from a decision, so the card shows
            the guess as a guess rather than filling the field in. */}
        <Mode c={c} onChange={onChange} />
        {c.delivery.state !== 'received' && <Arrived container={c} onDone={onChange} />}
      </footer>

      {c.aliases.length > 0 && (
        <details className="c-alias">
          <summary>Also known as ({c.aliases.length})</summary>
          <ul>{c.aliases.map((a) => <li key={a.alias}><span className="c-src">{a.source}</span> {a.alias}</li>)}</ul>
        </details>
      )}
    </section>
  )
}

// ⚠️ THE TABS ARE THE THREE THINGS A CONTAINER CAN BE, not a filter menu. Nima,
// 2026-09-15: "there should be a in transit tab, received, and perhaps one for the ones
// with no packing slip."
//
// ⚠️ AND "En route" IS NOT "everything not received". It is the two live delivery states
// — still coming, and on our floor unreceived — which is exactly the partition
// containerDelivery.js refuses to collapse. A tab built as the complement of another tab
// would quietly re-merge them.
const TABS = [
  { key: 'transit', label: 'En route', hint: 'still coming, or here and not yet on the books' },
  { key: 'landed', label: 'Landed', hint: 'every transfer order received — finished' },
  { key: 'unmanifested', label: 'Unmanifested', hint: 'NetSuite has the transfer orders; we never imported a packing slip' },
]

export default function Containers() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [tab, setTab] = useState('transit')
  const load = async () => {
    try { setData(await fetchContainers()); setErr(null) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  if (err) return <div className="view"><p className="c-warn">{err}</p></div>
  if (!data) return <div className="view"><p>Loading containers…</p></div>

  const { containers, orphans, awaitingReceipt, seasons = [], seasonYears = [], reasons = [] } = data
  const openOrphans = orphans.filter((o) => !o.allReceived)
  const landed = containers.filter((c) => c.delivery.state === 'received')
  const enRoute = containers.filter((c) => c.delivery.state !== 'received')
  const counts = { transit: enRoute.length, landed: landed.length, unmanifested: orphans.length }
  const shown = tab === 'landed' ? landed : enRoute

  return (
    <div className="view containers-view">
      <h2>Landing bay</h2>

      <nav className="c-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" title={t.hint}
                  className={`c-tab${tab === t.key ? ' is-on' : ''}`}
                  onClick={() => setTab(t.key)}>
            {t.label} <span className="c-tabN">{counts[t.key]}</span>
          </button>
        ))}
      </nav>
      <p className="c-why">{TABS.find((t) => t.key === tab).hint}</p>

      {/* ⚠️ THE BANNER IS OUTSIDE THE TABS ON PURPOSE. It is the only actionable thing
          on this screen, and hiding it behind the tab somebody is not looking at is how
          it gets missed — which is the failure the whole app exists to prevent.
          ⚠️ IT COUNTS WHAT A PERSON SAID IS HERE — never "has no receipt",
          which would report freight in the Pacific as a receiving backlog. */}
      {awaitingReceipt.length > 0 && (
        <div className="c-banner sev-hi">
          <strong>{awaitingReceipt.length} container{awaitingReceipt.length === 1 ? '' : 's'} on our floor, not received in NetSuite</strong>
          <ul>{awaitingReceipt.map((a) => <li key={a.label}>{a.label} — {a.action}</li>)}</ul>
        </div>
      )}

      {tab !== 'unmanifested' && shown.map((c) => <Container key={c.label} c={c} seasons={seasons} seasonYears={seasonYears} reasons={reasons} onChange={load} />)}
      {/* ⚠️ AN EMPTY TAB SAYS WHY IT IS EMPTY. "Nothing here" next to a 0 is the state
          somebody argues with; naming the reason is the same rule the delivery states
          follow. */}
      {tab !== 'unmanifested' && shown.length === 0 && (
        <p className="c-why">
          {tab === 'landed'
            ? 'No container has had all its transfer orders received yet.'
            : 'Nothing is in transit — every container we hold a slip for has landed and been received.'}
        </p>
      )}

      {tab === 'unmanifested' && orphans.length > 0 && (
        <section className="container-card c-orphans">
          <header><h3>In NetSuite with no packing slip — {orphans.length}</h3></header>
          <p className="c-sub">
            The transfer orders are recorded; their cartons, SKUs and POs are not.
          </p>
          <ul>
            {orphans.map((o) => (
              <li key={o.memo}>
                <b>{o.memo}</b> — {o.tos} TOs · {o.units} units
                {o.allReceived
                  ? <span className="c-rcv"> received {d(o.receivedOn)}{o.unusableDays != null ? ` · ${o.unusableDays}d unusable` : ''}</span>
                  : <span className="c-warn"> ⚠ {o.received}/{o.tos} received</span>}
              </li>
            ))}
          </ul>
          {/* ⚠️ THE SUMMARY IS THE HONEST ONE. Every one of these is landed and received:
              missing paperwork, not missing freight. Saying "6 gaps" implies a backlog
              that does not exist. */}
          <p className="c-why">
            {openOrphans.length
              ? `⚠ ${openOrphans.length} still have transfer orders to receive.`
              : `None is outstanding — all ${orphans.length} landed and were received. Missing paperwork, not missing freight.`}
          </p>
        </section>
      )}
    </div>
  )
}
