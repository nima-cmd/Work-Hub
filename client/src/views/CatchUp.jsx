// CatchUp — the band above the day plan (Nima, 2026-08-05, task "catch up first").
//
// The two morning loads he named that the plan had never carried: the unread
// inbox and the day's recurring rhythms. Rules live in src/model/catchUp.js —
// never blocking, and collapse rather than sum.
//
// Deliberately quieter than First hour: no verbs, no "start here", no colour for
// age. This is the thing you clear before the plan starts, not the plan.

export default function CatchUp({ catchUp, onNavigate, onCompleteRhythm, busy }) {
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
            {rhythms.map((r) => (
              <li key={r.id}>
                <button className="cuTick" disabled={busy} title="Mark it done"
                        onClick={() => onCompleteRhythm?.(r)}>✓</button>
                <span className="cuSubject">{r.subject}</span>
                <span className="cuBasis">{r.basis}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
