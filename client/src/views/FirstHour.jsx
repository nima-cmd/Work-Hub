// FirstHour — the answer to "I come in and I'm paralyzed" (Nima, 2026-08-04).
//
// His words: "im paralyzied by the amount of work… This causes me to panick and
// just loose focus. i end up jumping from task to task which is a real problem
// since most task end up only partially done. There is no clear goal or plan."
//
// So this shows ONE thing, then a few, then a count. Nothing else.
//
// Two deliberate decisions:
//
//   · It is NOT a new ordering. It renders the top of the SAME computeRoute the
//     rest of the plan uses, so it can never disagree with the timeline below it.
//     A second opinion about what matters most is how two surfaces start lying.
//   · The overflow is SPLIT, never summed: "more today" and "to close out" are
//     different jobs, and a single "+75 more" is exactly the number that caused
//     the panic. Close-outs are POs whose cancel date died long ago — real work,
//     but not morning work (see STALE_CANCEL_DAYS in src/model/ediWork.js).
//
// ⚠️ Why the top of the list is trustworthy now, and wasn't before: on 2026-08-04
// the plan's first eight legs were EDI POs 380–534 days past their cancel date,
// sitting at priority 0. A "top 5" over that ordering would have shown five pieces
// of 2025 archive. The ordering had to be fixed first; this view is only honest
// because of it.

const KIND_WORD = {
  label: 'Make the label', invoice: 'Raise the invoice', ship: 'Ship it',
  chase: 'Chase it', mark_packed: 'Mark it packed', handoff: 'Hand it off',
  edi_route: 'Route it', close_out: 'Close it out', email_reply: 'Reply',
  weaver_sync: 'Weaver sync', csv_upload: 'Refresh the CSV', planning: 'Plan it',
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function FirstHour({ route = [], summary = {}, now = Date.now(), onNavigate, onCheck, busy }) {
  // Close-outs are counted, never queued — they must not take the NOW slot.
  const doable = route.filter((r) => r.kind !== 'close_out')
  const closeOuts = route.length - doable.length
  const nowItem = doable[0] || null
  const then = doable.slice(1, 5)
  const rest = Math.max(0, doable.length - 1 - then.length)

  // Absence is the all-clear — no "nothing to do ✓" panel taking up space.
  if (!nowItem) return null

  const verb = KIND_WORD[nowItem.kind] || 'Do it'
  const late = nowItem.deadline != null && nowItem.deadline < now

  return (
    <section className="fh">
      <header className="fhHead">
        <h2>◈ First hour</h2>
        <span className="fhWhen">
          {new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        </span>
      </header>

      <div className={'fhNow' + (late ? ' late' : '')}>
        <div className="fhNowTag">Start here</div>
        <div className="fhNowVerb">{verb}</div>
        <div className="fhNowLabel">{nowItem.label}</div>
        <div className="fhNowMeta">
          {nowItem.deadline != null
            ? <span className={late ? 'fhLate' : ''}>{late ? 'was due ' : 'by '}{hhmm(nowItem.deadline)}</span>
            : <span className="fhNoCut">no cutoff — just the oldest thing sitting still</span>}
          <span className="fhEst">~{nowItem.durationMin}m</span>
        </div>
        <div className="fhNowActions">
          {nowItem.nav && <button className="fhGo" onClick={() => onNavigate?.(nowItem.nav)}>Open it ↗</button>}
          <button className="fhDone" disabled={busy} onClick={() => onCheck?.(nowItem)}>✓ Done</button>
        </div>
      </div>

      {then.length > 0 && (
        <div className="fhThen">
          <div className="fhThenHead">Then</div>
          <ol>
            {then.map((r) => (
              <li key={r.id}>
                <span className="fhThenVerb">{KIND_WORD[r.kind] || r.kind}</span>
                <span className="fhThenLabel">{r.label}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Split, never summed — see the header comment. */}
      <div className="fhRest">
        {rest > 0 && <span>+{rest} more today</span>}
        {closeOuts > 0 && <span className="fhArchive">{closeOuts} to close out (old POs, not today)</span>}
        {summary.totalMin != null && <span className="fhTotal">{Math.round(summary.totalMin / 6) / 10}h queued</span>}
      </div>
    </section>
  )
}
