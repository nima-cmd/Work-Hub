// client/src/views/Seasons.jsx — the open POs, grouped by the season they buy for.
//
// Nima, 2026-09-18: *"build the season view — POs grouped by season + year, with lane and
// deadline."*
//
// ⚠️ THIS FILE DECIDES NOTHING. Every grouping, lane, deadline and verdict comes from
// src/model/seasonBoard.js and src/model/poLane.js through /api/season-board. Logic in a
// .jsx is logic with no test — the rule from [[marked-shipped-is-not-departed]].
//
// ⚠️ AND THE TWO UNIT FIGURES ARE NEVER DRAWN AS ONE. A season's units are what was
// ORDERED; `remaining` is what a PO still owes. The season mix is only cached per
// (PO, season), so there is no honest way to split "remaining" by season — showing one
// number and letting a reader assume the other is the arithmetic-field bug this repo
// keeps finding ([[field-assumption-register]]). Ordered is the headline and says so;
// remaining appears per PO, where it is true.

import { useEffect, useState } from 'react'
import { fetchSeasonBoard } from '../api.js'
import { vendorShort } from '../../../src/model/vendorName.js'

const d = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null)
const n = (x) => (x == null ? '—' : Number(x).toLocaleString())

// ⚠️ FIVE STATES, FIVE TREATMENTS. "no deadline" is not a pale "ok" — a season whose
// launch has passed and a season comfortably ahead of its launch are different facts,
// and greying one out would read as "nothing to see" about 14,593 units of Core.
const STATE = {
  late: { tone: 'sev-hi', pill: 'danger', word: 'Late' },
  tight: { tone: 'sev-mid', pill: 'warn', word: 'Tight' },
  ok: { tone: 'sev-lo', pill: 'fresh', word: 'On time' },
  'no-deadline': { tone: '', pill: '', word: 'No deadline' },
  unknown: { tone: '', pill: '', word: 'No verdict' },
}

// The lane a PO's stock is going to. `fob` and `unknown` are stock that does NOT arrive
// here, and they are drawn differently for that reason — see src/model/poLane.js.
const LANE_TONE = { retail: 'fresh', boutique: '', partner: 'warn', fob: '', unknown: 'danger' }

function NsLink({ doc }) {
  return (
    <a className="ns-link" href={`/api/netsuite/open?doc=${encodeURIComponent(doc)}`}
       target="_blank" rel="noreferrer" title={`Open ${doc} in NetSuite`}>{doc}</a>
  )
}

function Lanes({ lanes }) {
  if (!lanes?.length) return null
  return (
    <div className="season-lanes">
      {lanes.map((l) => (
        <span key={`${l.lane}:${l.partner || ''}`} className={`pill ${LANE_TONE[l.lane] || ''}`} title={l.why}>
          {l.partner || l.label} · {n(l.units)}
        </span>
      ))}
    </div>
  )
}

function PoRow({ po, risk }) {
  const r = risk?.risk
  const tone = r?.state === 'late' ? 'sev-hi' : r?.state === 'tight' ? 'sev-mid' : ''
  return (
    <tr className={tone}>
      <td><NsLink doc={po.poNumber} /></td>
      {/* ⚠️ THE SHORT NAME, WITH THE FULL ONE ON HOVER. 42 characters of factory name
          on most rows pushed the numbers off the screen. */}
      <td title={vendorShort(po.vendor).full || undefined}>{vendorShort(po.vendor).short || '—'}</td>
      <td className={`lane-${po.lane.lane}`} title={po.lane.why}>
        {po.lane.partner || po.lane.label}
      </td>
      {/* ⚠️ THESE TWO COLUMNS HAVE DIFFERENT DENOMINATORS, which misled Nima on his own
          board (2026-09-18): he read them as "total" and "not yet received". They are
          not. The first is THIS SEASON's slice of the PO; the second is what the WHOLE
          PO still owes across every season on it. PO1786 is 750 Holiday units inside a
          1,690-unit order that also carries Core, Resort, Summer and three more — so
          "remaining" being larger than "ordered" is arithmetic, not an error.
          ⚠️ The honest fix is a per-season received figure, which needs an item→season
          map we do not hold; the sync caches the mix per (PO, season) only. Until then
          the headers name the denominator and the PO total is shown beside it. */}
      <td className="num">{n(po.units)}</td>
      {/* ⚠️ THIS SEASON'S received, against THIS SEASON'S ordered — the same denominator
          at last. The whole PO's figure rides in the tooltip, because it answers a
          different question: PO1786 is 750 Holiday units inside a 1,690-unit order.
          ⚠️ AND "not synced" IS NOT "nothing landed" — an unsynced PO shows a dash. */}
      <td className="num muted">
        {po.received != null
          ? (
            <span className="poProg"
                  title={`${n(po.received)} of ${n(po.units)} ${po.seasonLabel || 'season'} units received`
                    + (po.progress ? ` · the whole PO is ${n(po.progress.received)} of ${n(po.progress.ordered)}, across every season on it` : '')}>
              <span className="poProgNums">{n(po.received)} / {n(po.units)}</span>
              <span className="poProgBar">
                <span className={po.received >= po.units ? 'poProgFill done' : 'poProgFill'}
                      style={{ width: `${po.units ? Math.min(100, Math.round((po.received / po.units) * 100)) : 0}%` }} />
              </span>
            </span>
          )
          : <span title="NetSuite has not been asked about this PO yet — not the same as nothing having landed">—</span>}
      </td>
      {/* ⚠️ AN OVERDUE DUE DATE IS MARKED, NOT QUIETLY REUSED. The verdict column
          deliberately stops predicting once this date has gone by — see seasonBoard.js.
          Showing the date alone would read as a plan. */}
      <td>
        {d(po.expectedReceipt) || <span className="muted">no date</span>}
        {risk?.overdue != null && (
          <span className="pill danger overdue-pill" title="This PO is past its due date and has not arrived, so no arrival can be predicted from it.">
            {risk.overdue}d over
          </span>
        )}
      </td>
      <td>
        {risk?.reason
          ? (
            <span title={risk.reasonWhy || undefined}>
              {risk.reason}
              {/* ⚠️ A SUGGESTION IS MARKED AS ONE. The calendar inferred this; nobody
                  confirmed it. See seasonBoard.js — treating the guess as a decision is
                  how 45 false "late" flags were nearly shipped. */}
              {risk.reasonSuggested && <span className="muted"> · suggested{risk.reasonConfident ? '' : '?'}</span>}
            </span>
          )
          : <span className="muted">—</span>}
      </td>
      <td className="muted">{r?.why || ''}</td>
    </tr>
  )
}

function Season({ s }) {
  const [open, setOpen] = useState(s.state === 'late')
  const st = STATE[s.state] || STATE.unknown
  const riskByPo = new Map(s.risks.map((r) => [r.poNumber, r]))
  return (
    <section className={`card season ${st.tone}`}>
      <header className="season-head" onClick={() => setOpen((o) => !o)}>
        <div>
          <h3>
            {s.label}
            {s.kind === 'evergreen' && <span className="muted"> · evergreen, belongs to no drop</span>}
            {s.kind === 'program' && <span className="muted"> · a program, not one of the five drops</span>}
          </h3>
          <div className="season-sub muted">
            {s.drop
              ? (
                <>
                  {s.drop.title} · {d(s.drop.on)}
                  {s.daysToDrop >= 0 ? ` · ${s.daysToDrop} days away` : ` · ${-s.daysToDrop} days ago`}
                  {/* ⚠️ NAMED WHEN THE SEASON HAS TWO DROPS AND NOTHING SAYS WHICH. */}
                  {s.drop.assumed && ' · this season has more than one drop; nothing says which'}
                </>
              )
              : 'no drop on the marketing calendar'}
          </div>
        </div>
        <div className="season-figs">
          <span className={`pill ${st.pill}`}>{st.word}</span>
          {s.late.length > 0 && <span className="pill danger">{s.late.length} PO{s.late.length > 1 ? 's' : ''} late</span>}
          {/* ⚠️ "ordered" IS IN THE LABEL, not left to be assumed. */}
          <span className="pill">{n(s.units)} units ordered</span>
          {/* ⚠️ AND WHAT IS ACTUALLY COMING HERE, which excludes FOB and unrouted
              stock. Holiday 2026 is 6,547 bought and 3,600 arriving. */}
          {s.arriving !== s.units && <span className="pill">{n(s.arriving)} arriving here</span>}
          {/* ⚠️ THE NUMBER THIS SCREEN EXISTS FOR — how much of the drop is actually in.
              Null when nothing has been synced, so an empty bar can never be mistaken
              for "nothing has arrived". */}
          {s.receivedUnits != null && s.receivedOf > 0 && (
            <span className={`pill${s.receivedUnits >= s.receivedOf ? ' fresh' : ''}`}
                  title={`${n(s.receivedUnits)} of ${n(s.receivedOf)} ordered units have been received`}>
              {Math.round((s.receivedUnits / s.receivedOf) * 100)}% received · {n(s.receivedUnits)} in
            </span>
          )}
          <span className="pill">{s.poCount} PO{s.poCount > 1 ? 's' : ''}</span>
        </div>
      </header>
      <Lanes lanes={s.lanes} />
      {open && (
        <table className="grid season-grid">
          <thead>
            <tr>
              <th>PO</th><th>Vendor</th><th>Lane</th>
              <th className="num">{s.label}<br /><span className="muted">units on this PO</span></th>
              <th className="num">Received<br /><span className="muted">of this season's units</span></th>
              <th>Due</th><th>Reason</th><th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {[...s.pos]
              .sort((a, b) => b.units - a.units)
              .map((p) => <PoRow key={`${s.label}:${p.poNumber}`} po={p} risk={riskByPo.get(p.poNumber)} />)}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default function Seasons() {
  const [board, setBoard] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetchSeasonBoard().then(setBoard).catch((e) => setErr(e.message))
  }, [])

  if (err) return <div className="view"><p className="pill danger">{err}</p></div>
  if (!board) return <div className="view"><p className="muted">Loading the season board…</p></div>

  const t = board.totals
  return (
    <div className="view seasons">
      <header className="seasons-head">
        <h2>Seasons</h2>
        <div className="season-figs">
          <span className="pill">{t.pos} open POs</span>
          <span className="pill">{n(t.units)} units ordered</span>
          <span className="pill">{n(t.withDeadline)} against a live drop</span>
          {t.late > 0 && <span className="pill danger">{t.late} PO{t.late > 1 ? 's' : ''} late</span>}
          {t.tight > 0 && <span className="pill warn">{t.tight} tight</span>}
          {t.overdue > 0 && <span className="pill warn">{t.overdue} past due, no arrival known</span>}
        </div>
      </header>
      <p className="muted seasons-note">
        Grouped by <code>custitem_season_year</code> on the items, the lane from the PO&rsquo;s
        final destination, and the deadline from the marketing calendar — which is the
        authority on dates. Unit figures are what was <strong>ordered</strong>; what a PO
        still owes is its own column.
      </p>
      {/* ⚠️ A PO WITH NO SEASON MIX IS NOT A PO WITH NO SEASONS. It means nothing ever
          asked NetSuite for its items — the standing lesson from the four modules that
          had structure and no caller. Reported, never inferred from a blank row. */}
      {board.unmixed?.length > 0 && (
        <p className="pill warn">
          {board.unmixed.length} PO{board.unmixed.length > 1 ? 's have' : ' has'} no item-season
          mix cached — run <code>npm run sync:netsuite</code>. This is not the same as having no season.
        </p>
      )}
      {board.seasons.map((s) => <Season key={s.label} s={s} />)}
    </div>
  )
}
