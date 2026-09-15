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
import { fetchContainers, markContainerDelivered, setTransferPurpose } from '../api.js'

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

// One transfer order: the PO it draws on, the China receipt that dated the invoice, where
// it lands, and what it is for.
//
// ⚠️ THE PO AND THE RECEIPT ARE NOT DECORATION. Nima's own account of the flow: "we
// receive the units in china to mark the date that the factory completes them... the
// receive is for accounting... once we receive the units in china we have a transfer
// order which we leave a link to the original PO in the transfer order so we know what
// PO its for." Those three documents are the chain, and until now the card showed one.
function Leg({ t, onChange }) {
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
      </div>
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

function Container({ c, onChange }) {
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
          {c.transferOrders.map((t) => <Leg key={t.toNumber} t={t} onChange={onChange} />)}
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
        <span className="c-mode">
          {c.mode
            ? <>Mode <b>{c.mode}</b>{c.modeSource ? <small> · {c.modeSource}</small> : null}</>
            : c.modeSuggested
              ? <>Mode <b>not set</b> — looks like <b>{c.modeSuggested}</b> from the name</>
              : <>Mode <b>not set</b></>}
        </span>
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

  const { containers, orphans, awaitingReceipt } = data
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

      {tab !== 'unmanifested' && shown.map((c) => <Container key={c.label} c={c} onChange={load} />)}
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
