import { useEffect, useState } from 'react'
import { fetchHealth, fetchOverdueInvoices, fetchLabelGaps, fetchViewUsage } from '../api.js'
import { usageReport, humanMs, VERDICT_LABEL } from '../../../src/model/viewUsage.js'
import CsvBackup from './CsvBackup.jsx'
import { NsLink } from '../lib.jsx'
import { fmtBytes } from '../../../src/model/transferMeter.js'

// Health — what's connected, what's arriving, and what to do when it isn't.
//
// Built 2026-07-31 after the deployed app went 13 hours without a NetSuite sync
// while its cron reported success on every run. Finding that meant correlating
// GitHub Actions history against snapshot timestamps by hand; the cause was five
// environment variables missing on the deploy. Nima: "That seems like a useful
// thing for both of us to have so we can both see if something broken."
//
// The point is that this page answers the question WITHOUT a terminal. Every
// "run `npm run check:x`" instruction I've handed over should be visible here
// instead — the person who needs to fix a missing credential is the person with
// the Render dashboard, not the person with a shell.
//
// It never shows a credential value; the API sends booleans and variable names.

const fmtAge = (h) => {
  if (h == null) return 'never'
  if (h < 1) return `${Math.round(h * 60)} min ago`
  if (h < 24) return `${Math.round(h)}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ${Math.round(h % 24)}h ago`
}

const SYNC_HINT = {
  ok: 'arriving normally',
  warn: 'later than usual',
  stale: 'stopped arriving',
  never: 'has never run here',
}

export default function Health({ onRefresh, views }) {
  const [h, setH] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  function load() {
    setBusy(true)
    fetchHealth().then((r) => { setH(r); setErr(null) }).catch((e) => setErr(e.message)).finally(() => setBusy(false))
  }
  useEffect(load, [])

  if (err) return <div className="banner error">⚠ Couldn’t load health: {err}</div>
  if (!h) return <div className="banner">Checking…</div>

  const { overall, integrations, syncs, fieldAssumptions, database, transfer } = h

  return (
    <div className="health">
      <div className="hlHead">
        <div>
          <h2>Health <span className="muted">· connections & data flow</span></h2>
          <div className="muted hlSub">
            Everything the app depends on that lives somewhere else. No credentials are shown —
            only whether each one is set.
          </div>
        </div>
        <button className="btnGhost" disabled={busy} onClick={load}>{busy ? 'Checking…' : '↻ Re-check'}</button>
      </div>

      <div className={'hlVerdict ' + overall.status}>
        <span className="hlVerdictMark">
          {overall.status === 'ok' ? '✓' : overall.status === 'broken' ? '⛔' : '⚠'}
        </span>
        <span>
          <b>{overall.headline}</b>
          {overall.detail && <div className="hlVerdictDetail">{overall.detail}</div>}
        </span>
      </div>

      {/* ⚠️ WHICH DATABASE every number on every page came from. A local mirror is
          stale by definition, and the sync ages below are the ages recorded INSIDE
          the snapshot — so on a mirror they say how fresh the live database was when
          it was cloned, not now. A stale snapshot read as live is the field-assumption bug
          class applied to the entire app, so this is a banner, not a footnote. */}
      {database?.isMirror && (
        <div className="banner error hlMirror">
          ⚠ Reading the <b>LOCAL MIRROR</b>
          {/* fmtAge already ends in "ago" — no second one. */}
          {database.ageHours != null && <> · cloned <b>{fmtAge(database.ageHours)}</b></>}
          {' '}— these numbers are a snapshot, not live NetSuite data. Run{' '}
          <code>npm run db:mirror</code> to re-clone, or comment out{' '}
          <code>WORKHUB_DB</code> in <code>.env.local</code> to read the live database.
        </div>
      )}

      <h3 className="hlSection">Connections</h3>
      <div className="hlRows">
        {integrations.map((i) => (
          <div key={i.key} className={'hlRow ' + (i.configured ? (i.partial ? 'partial' : 'ok') : 'bad')}>
            <span className="hlDot" />
            <div className="hlRowMain">
              <div className="hlRowTop">
                <b>{i.label}</b>
                <span className="hlBadge">{i.configured ? (i.partial ? 'partly set up' : 'configured') : 'NOT CONFIGURED'}</span>
              </div>
              <div className="hlPowers">{i.powers}</div>
              {/* Name the missing variables — they're in the source already, so
                  this is not a secret, and it's the whole fix. */}
              {!i.configured && (
                <div className="hlFix">
                  <div className="hlFixWhy">{i.ifMissing}</div>
                  <div className="hlFixHow">
                    Set {i.missing.length === 1 ? 'this variable' : `these ${i.missing.length} variables`} in
                    the host’s environment (Render → your service → Environment), then save — the service
                    restarts itself:
                  </div>
                  <div className="hlVars">{i.missing.map((v) => <code key={v}>{v}</code>)}</div>
                </div>
              )}
              {i.configured && i.missingOptional.length > 0 && (
                <div className="hlOpt">
                  Optional, not set: {i.missingOptional.map((v) => <code key={v}>{v}</code>)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <TransferMeter t={transfer} isMirror={database?.isMirror} target={database?.target} />

      <h3 className="hlSection">Data arriving</h3>
      <div className="hlRows">
        {syncs.syncs.map((s) => (
          <div key={s.key} className={'hlRow ' + (s.status === 'ok' ? 'ok' : s.status === 'warn' ? 'partial' : 'bad')}>
            <span className="hlDot" />
            <div className="hlRowMain">
              <div className="hlRowTop">
                <b>{s.label}</b>
                <span className="hlBadge">{SYNC_HINT[s.status] || s.status}</span>
              </div>
              <div className="hlPowers">
                Last completed <b>{fmtAge(s.ageHours)}</b>
                {s.lastAt && <span className="muted"> · {new Date(s.lastAt).toLocaleString()}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="muted hlFoot">
        A sync is expected roughly every 90 minutes — the scheduled check asks for every 10, but
        GitHub throttles it. Flagged as late after {syncs.warnHours}h and stopped after {syncs.staleHours}h.
      </div>

      <FieldAssumptions data={fieldAssumptions} />

      <ViewUsage views={views} />

      {/* The retired CSV path lives here and nowhere else (Nima, 2026-08-11) —
          it is a backup for a NetSuite outage, not a daily status readout. */}
      <CsvBackup onRefresh={onRefresh} />

      <ShippedWhileOwing />
      <OverdueInvoices />
    </div>
  )
}

// Goods already gone with money still outstanding on terms that should have held
// them. Sits above the overdue list because it is the sharper version of the same
// question: an overdue invoice is money not yet in, this is money not yet in on
// something we can no longer hold. It exists because the packed-side chip's own
// comment promised this case could never hide, while its query — packed rows only
// — could never see it (see getShippedWhileOwing in server/queries.js).
function ShippedWhileOwing() {
  const [d, setD] = useState(null)
  useEffect(() => {
    // Soft: this is a secondary diagnostic on a page whose main job is sync
    // health, so a failure here must not blank the page.
    fetchLabelGaps().then((r) => setD(r?.shippedWhileOwing || null)).catch(() => {})
  }, [])

  if (!d || !d.items?.length) return null
  const money = (n) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <>
      <h3 className="hlSection">Shipped, still owed</h3>
      <div className="muted hlSub">
        <b>{d.counts.total}</b> shipment{d.counts.total === 1 ? '' : 's'} ·{' '}
        <b>{money(d.amount)}</b> outstanding.
        {d.counts.dueBeforeShipped > 0
          ? <> <b>{d.counts.dueBeforeShipped}</b> had already passed the invoice due date on the day it left.</>
          : <> None of them was past its due date on the day it left.</>}
        {' '}Balances are as of now — no record of the balance on the ship date exists,
        so this says “still owed”, not “shipped before paying”.
      </div>
      <div className="hlRows">
        {d.items.map((r) => (
          <div key={r.ifNumber} className={'hlRow ' + (r.dueBeforeShipped ? 'bad' : 'partial')}>
            <span className="hlDot" />
            <div className="hlRowMain">
              <div className="hlRowTop">
                <b><NsLink doc={r.ifNumber} /></b>
                <span className="hlBadge" title="Money outstanding on terms that hold a packed shipment back">
                  {r.dueBeforeShipped ? 'was past due when it shipped' : 'outstanding'}
                </span>
              </div>
              <div className="hlPowers">
                {r.customer || <span className="muted">bill-to unknown</span>}
                {' · '}<b>{money(r.amountRemaining)}</b> on <NsLink doc={r.invoiceNumber} />
                {' · shipped '}{new Date(r.shippedOn).toLocaleDateString()} ({r.daysSinceShipped}d ago)
                <span className="muted">
                  {' · '}{r.invoiceTerms || 'terms unknown'}
                  {r.invoiceDueDate ? ` · due ${new Date(r.invoiceDueDate).toLocaleDateString()}` : ''}
                  {r.soNumber ? <> · <NsLink doc={r.soNumber} /></> : ''}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Overdue invoices — deliberately on Health rather than any shipping screen.
// Nima: "while it doesn't directly fall into our job it's nice to know if an
// invoice is overdue in payment. It would let us know if something is wrong
// either in payment being posted or … if there needs to be an inquiry into an
// 810 or invoice not sent." So it diagnoses, it never gates: an invoice past due
// does NOT hold a shipment (see src/model/paymentGate.js).
const INQUIRY = {
  'never-billed': { label: 'never billed', tone: 'bad',
    hint: 'An 810 exists but never reached the partner — we may never have asked for this money' },
  'chase-payment': { label: 'chase payment', tone: 'partial',
    hint: 'They were billed. Either payment has not come in, or it came in and was not posted' },
  'unknown-810': { label: '810 unknown', tone: 'partial',
    hint: 'EDI, but we hold no 810 record either way — an absent record is not proof it was never sent' },
  'unknown-source': { label: 'lane unknown', tone: 'partial',
    hint: 'This invoice’s order is outside the sync window, so we cannot tell whether an 810 was owed' },
}

function OverdueInvoices() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    fetchOverdueInvoices().then(setD).catch((e) => setErr(e.message))
  }, [])

  if (err) return <div className="banner error">⚠ Couldn’t load overdue invoices: {err}</div>
  if (!d) return null
  const { items, summary } = d
  const money = (n) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <>
      <h3 className="hlSection">Invoices past due</h3>
      {!items.length ? (
        <div className="muted hlFoot">Nothing past due. </div>
      ) : (
        <>
          <div className="muted hlSub">
            <b>{summary.count}</b> invoices · <b>{money(summary.amount)}</b> outstanding · oldest{' '}
            <b>{summary.oldestDays}d</b> past due.
            {summary.neverBilled > 0
              ? <> <b>{summary.neverBilled}</b> may never have been billed — those are worth an 810 inquiry first.</>
              : <> None of them is missing a delivered 810, so this is a payment/posting question, not a document one.</>}
            {' '}This list never holds a shipment.
          </div>
          <div className="hlRows">
            {items.map((r) => {
              const inq = INQUIRY[r.inquiry] || INQUIRY['chase-payment']
              return (
                <div key={r.invNumber} className={'hlRow ' + inq.tone}>
                  <span className="hlDot" />
                  <div className="hlRowMain">
                    <div className="hlRowTop">
                      <b><NsLink doc={r.invNumber} /></b>
                      <span className="hlBadge" title={inq.hint}>{inq.label}</span>
                    </div>
                    <div className="hlPowers">
                      {r.customer || <span className="muted">bill-to unknown</span>}
                      {' · '}<b>{money(r.amountRemaining)}</b>
                      {' · '}{r.daysOverdue}d past due
                      <span className="muted">
                        {' · '}{r.terms || 'terms unknown'} · due {new Date(r.dueDate).toLocaleDateString()}
                        {r.soNumber ? <> · <NsLink doc={r.soNumber} /></> : ''}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

// ── the field-assumption register ───────────────────────────────────────────
//
// Not a bug list. Every serious defect this app has shipped was a field that was
// present, populated, plausible, and meant something other than what the code read
// it as — `transaction.shipdate` had a value on 1,254 sales orders and was a default
// lead time; `is_ats` was false on all 282 orders. Both looked healthy on screen.
//
// It lives on Health because Health is where you go when a number looks wrong, and
// the useful question at that moment is "has this field lied before, and what is it
// actually keyed on?"

// ── Which views are actually used (Nima, 2026-08-20) ────────────────────────
//
// "We are noticing there too many view many of which aren't even used … can we track
//  how much we use certain view and record it somewhere for our own knowledge"
//
// It lives on Health because this is the page about the app's own honesty, and this is
// the app measuring itself. Ranked by DWELL, not opens — see src/model/viewUsage.js.
function ViewUsage({ views = [] }) {
  const [usage, setUsage] = useState(null)
  useEffect(() => { fetchViewUsage().then(setUsage).catch(() => setUsage({})) }, [])
  if (!usage || !views.length) return null

  const { rows, totals } = usageReport(usage, views, { defaultView: views[0]?.key })
  const since = totals.trackedSince ? new Date(totals.trackedSince).toLocaleDateString() : null

  return (
    <>
      <h3 className="hlSection">Which views are actually used</h3>
      <div className="muted hlSub">
        {since
          ? <>Recorded since {since}. Ranked by time on screen, not times opened — a view you land on
              is not a view you read.</>
          : <>Nothing recorded yet. Numbers appear as views are used.</>}
        {' '}{totals.neverOpened} never opened, {totals.glanceOnly} opened but not read.
      </div>
      <table className="vuTable">
        <thead>
          <tr><th>View</th><th>Time on screen</th><th>Opens</th><th>Per visit</th><th>Last</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.verdict === 'unused' ? 'vuUnused' : undefined}>
              <td>{r.label}</td>
              <td className="mono">{r.dwellMs ? humanMs(r.dwellMs) : '—'}</td>
              {/* ⚠️ The landing view is opened by every page load, refresh and restart,
                  by nobody's decision. Its opens are shown but marked, never ranked
                  against a number that means "he chose this". */}
              <td className="mono">
                {r.opens || '—'}
                {!r.opensComparable && r.opens ? <span className="muted" title="Every page load lands here, so this is not a count of choosing it"> ·&nbsp;incl. loads</span> : null}
              </td>
              <td className="mono">{r.avgMs ? humanMs(r.avgMs) : '—'}</td>
              <td className="muted">{r.daysSince === null ? 'never' : r.daysSince === 0 ? 'today' : `${r.daysSince}d ago`}</td>
              <td><span className={'flag vu-' + r.verdict}>{VERDICT_LABEL[r.verdict]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted hlSub">
        ⚠️ &ldquo;Never opened&rdquo; is a fact about this recording, not a verdict on the view — a view
        added after {since || 'recording started'} has had no chance to be opened. Check the date before retiring anything.
      </div>
    </>
  )
}

function FieldAssumptions({ data }) {
  const [open, setOpen] = useState(false)
  if (!data) return null
  const { summary, entries } = data
  return (
    <>
      <h3 className="hlSection">Fields that did not mean what we thought</h3>
      <div className="muted hlSub">
        {summary.total} recorded across {summary.shapes.length} shapes.{' '}
        {/* ⚠️ THE HONEST NUMBER. Most shapes have no mechanical guard — they need a
            human to ask what a field is keyed on. Implying the checks cover
            everything would be worse than having no register at all. */}
        <b>{summary.guarded}</b> are caught by a script;{' '}
        <b>{summary.unguarded}</b> need someone to ask what a field is keyed on.
        {summary.repeats.length > 0 && (
          <> Bitten twice: {summary.repeats.map((r) => <code key={r.field}>{r.field}</code>)}.</>
        )}
      </div>
      <div className="faShapes">
        {summary.shapes.map((s) => (
          <div key={s.key} className="faShape">
            <div className="faShapeTop">
              <b>{s.label}</b><span className="faCount">{s.count}</span>
            </div>
            <div className="muted">{s.blurb}</div>
            <div className={s.guard ? 'faGuard' : 'faGuard faGuardNone'}>
              {s.guard ? <>caught by <code>{s.guard}</code></> : 'no script catches this — ask what the field is keyed on'}
            </div>
          </div>
        ))}
      </div>
      <button className="rt-editToggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '⌖'} Every entry ({entries.length})
      </button>
      {open && (
        <div className="faList">
          {entries.map((e) => (
            <div key={e.field + e.pr} className="faEntry">
              <div className="faEntryTop">
                <code>{e.field}</code>
                <span className="hlBadge">{e.status}</span>
                <span className="muted">PR #{e.pr} · {e.date}</span>
              </div>
              <div className="faLine"><span className="faKey">assumed</span>{e.assumed}</div>
              <div className="faLine"><span className="faKey">actually</span>{e.actually}</div>
              <div className="faLine"><span className="faKey">cost</span>{e.cost}</div>
              {/* The most transferable line here: the same method finds the next one. */}
              <div className="faLine"><span className="faKey">caught by</span>{e.caught}</div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── Transfer: an allowance on Neon, attribution everywhere else ─────────────
//
// Neon's Free plan allowed 5 GB/month and SUSPENDED the compute when it ran out. On
// 2026-08-14 the first anyone knew was an email at 84%, on the 14th.
//
// ⚠️ On Neon the number shown is the PROJECTION, not the percentage. 84% on the 14th and
// 84% on the 30th are the same percentage and completely different situations.
//
// ⚠️⚠️ THERE IS NO CAP ON DIGITALOCEAN, and this panel claimed there was. After the
// 2026-08-18 cutover it still rendered "Neon transfer · 1.27 GB of 5.00 GB · 25%" with a
// red verdict projecting "158% of the cap" — against a database that does not meter
// transfer at all. PR #129 fixed the same lie in check:transfer, check:neon and migrate,
// and #130 in the startup banner; this was the fifth and the only one on screen. A panel
// that invents a ceiling is worse than no panel: it is a red alarm nobody can act on.
//
// So: on Neon it is a BUDGET (limit, percentage, verdict, projection-vs-cap). Anywhere
// else it is ATTRIBUTION — who is reading how much — which is still worth showing,
// because a rising number means the app got chattier and DO is one vCPU.
function TransferMeter({ t, isMirror, target }) {
  if (!t) return null
  const capped = target === 'neon'
  // ⚠️ Off Neon the verdict is a judgement about a cap that does not exist, so the row
  // must never be coloured by it — a red row IS the false alarm.
  const cls = capped ? ({ ok: 'ok', warn: 'partial', critical: 'bad', exceeded: 'bad' }[t.verdict.level] || 'ok') : 'ok'
  const TITLE = { neon: 'Neon transfer', digitalocean: 'Database transfer (DigitalOcean — not metered)' }[target]
    || 'Database transfer'
  return (
    <>
      <h3 className="hlSection">{TITLE}</h3>
      <div className={'hlRow ' + cls}>
        <span className="hlDot" />
        <div className="hlRowMain">
          <div className="hlRowTop">
            <b>
              {capped
                ? <>{fmtBytes(t.used)} of {fmtBytes(t.limitBytes)} this month</>
                : <>{fmtBytes(t.used)} this month</>}
            </b>
            {capped && <span className="hlBadge">{t.pctUsed.toFixed(0)}%</span>}
            {!capped && <span className="hlBadge">no cap</span>}
            {t.isEstimate && <span className="hlBadge">estimated</span>}
          </div>
          <div className="hlPowers">
            {capped
              ? t.verdict.headline
              : 'DigitalOcean does not meter managed-database transfer. Kept for attribution — a rising number means the app got chattier, which matters on one vCPU.'}
            {t.perDay > 0 && (
              <span className="muted">
                {' · '}{fmtBytes(t.perDay)}/day
                {t.projected != null && <> · on track for {fmtBytes(t.projected)}</>}
              </span>
            )}
          </div>
          {/* WHO is burning it — the only thing that makes the number actionable. */}
          {t.bySource.length > 0 && (
            <div className="hlPowers muted">
              {t.bySource.map((b) => `${b.source} ${fmtBytes(b.bytes)}`).join(' · ')}
            </div>
          )}
        </div>
      </div>
      <div className="muted hlFoot">
        {capped ? t.caveat : t.caveat.replace(/\s*Neon's console is the authority\.?/i, '')}
        {isMirror && ' Reading the mirror, so this shows only local work — which costs the live database nothing.'}
      </div>
    </>
  )
}
