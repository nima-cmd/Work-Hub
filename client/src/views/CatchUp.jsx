// CatchUp — the band above the day plan (Nima, 2026-08-05, task "catch up first").
//
// The two morning loads he named that the plan had never carried: the unread
// inbox and the day's recurring rhythms. Rules live in src/model/catchUp.js —
// never blocking, and collapse rather than sum.
//
// Deliberately quieter than First hour: no verbs, no "start here", no colour for
// age. This is the thing you clear before the plan starts, not the plan.

export default function CatchUp({ catchUp, onNavigate, onCompleteRhythm, onToggleStep, busy }) {
  if (!catchUp || catchUp.empty) return null
  const { inbox, rhythms } = catchUp
  // Show the busiest few senders; the tail is a count, never a scroll.
  const shown = inbox.senders.slice(0, 4)
  const restSenders = inbox.senders.length - shown.length

  return (
    <section className="cu">
      <header className="cuHead">
        <h2>◇ Catch up first</h2>
        <span className="cuNote">before the plan — nothing here has a cutoff</span>
      </header>

      {inbox.unread > 0 && (
        <div className="cuBlock">
          <div className="cuBlockHead">
            <span className="cuCount">{inbox.unread}</span>
            <span className="cuWhat">
              unread {inbox.unread === 1 ? 'email' : 'emails'}
              {/* Both numbers, neither presented as the other. */}
              {inbox.threads !== inbox.unread && <> · {inbox.threads} threads</>}
              {' '}· {inbox.senders.length} {inbox.senders.length === 1 ? 'sender' : 'senders'}
            </span>
            <button className="cuGo" onClick={() => onNavigate?.('transmissions')}>Open inbox ↗</button>
          </div>
          <ul className="cuSenders">
            {shown.map((s) => (
              <li key={s.key}>
                <span className="cuFrom">
                  {s.from}
                  {s.domain && <span className="cuDomain"> · {s.domain}</span>}
                </span>
                <span className="cuTally">
                  {s.count}
                  {s.threads !== s.count && <span className="cuThreads"> · {s.threads} thr</span>}
                </span>
                <span className="cuAge">{s.oldestDays === 0 ? 'today' : `${s.oldestDays}d`}</span>
              </li>
            ))}
            {restSenders > 0 && <li className="cuMore">+{restSenders} more {restSenders === 1 ? 'sender' : 'senders'}</li>}
          </ul>
        </div>
      )}

      {rhythms.length > 0 && (
        <div className="cuBlock">
          <div className="cuBlockHead">
            <span className="cuCount">{rhythms.length}</span>
            <span className="cuWhat">{rhythms.length === 1 ? 'daily rhythm' : 'daily rhythms'}</span>
          </div>
          <ul className="cuRhythms">
            {rhythms.map((r) => {
              const left = r.steps.filter((s) => !s.done)
              // The server refuses to complete a gated task with a step
              // outstanding, so the button says why instead of failing.
              const blocked = r.gated && left.length > 0
              return (
                <li key={r.id} className="cuRhythm">
                  <div className="cuRhythmHead">
                    <button className="cuTick" disabled={busy || blocked}
                            title={blocked ? `${left.length} step${left.length === 1 ? '' : 's'} still to do` : 'Mark it done'}
                            onClick={() => onCompleteRhythm?.(r)}>✓</button>
                    <span className="cuSubject">{r.subject}</span>
                    {r.steps.length > 0
                      ? <span className="cuBasis">{r.steps.length - left.length}/{r.steps.length} steps</span>
                      : <span className="cuBasis">{r.basis}</span>}
                  </div>
                  {r.steps.length > 0 && (
                    <ol className="cuSteps">
                      {r.steps.map((s) => (
                        <li key={s.key} className={s.done ? 'done' : ''}>
                          <input type="checkbox" checked={s.done} disabled={busy}
                                 onChange={(e) => onToggleStep?.(r, s, e.target.checked)} />
                          <span>{s.label}</span>
                          {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="cuStepLink">Open ↗</a>}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
