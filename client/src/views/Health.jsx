import { useEffect, useState } from 'react'
import { fetchHealth } from '../api.js'

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

export default function Health() {
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

  const { overall, integrations, syncs } = h

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
    </div>
  )
}
