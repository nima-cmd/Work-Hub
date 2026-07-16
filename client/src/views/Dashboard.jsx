import { STAGE_ORDER, STAGE_SHORT, sevClass, Flags, docRef, docDate, SourceBadge, taskToCard } from '../lib.jsx'

// Attention-first: what needs action now, up top; pipeline overview above it.
// `tasks` (open quest_tasks from Gmail/Slack transmissions) are merged into
// the same attention grid as NetSuite orders — one unified "needs action" list.
export default function Dashboard({ orders, tasks = [] }) {
  const attention = [
    ...orders.filter((o) => o.severity > 0),
    ...tasks.filter((t) => t.status === 'open').map(taskToCard),
  ].sort((a, b) => b.severity - a.severity || (b.daysPending || 0) - (a.daysPending || 0))

  const counts = STAGE_ORDER.map((s) => ({
    s,
    n: orders.filter((o) => o.stage === s).length,
  })).filter((x) => x.n)

  return (
    <div className="dashboard">
      <section className="stageStrip">
        {counts.map(({ s, n }) => (
          <div key={s} className="stagePill">
            <b>{n}</b>
            <span>{STAGE_SHORT[s]}</span>
          </div>
        ))}
      </section>

      <h2>
        Needs attention <span className="count">{attention.length}</span>
      </h2>

      <div className="cards">
        {attention.map((o) => (
          <div key={o.soNumber} className={'card ' + sevClass(o.severity)}>
            <div className="cardTop">
              <span className="so">{o.soNumber} <SourceBadge source={o.source} character={o.character} /></span>
              <span className="cust">{o.customer}</span>
            </div>
            <div className="next">
              → {o.nextAction}
              {docRef(o) && (
                <span className="ifs"> · {docRef(o)}{docDate(o) && ` · ${docDate(o)}`}</span>
              )}
            </div>
            <Flags flags={o.flags} />
          </div>
        ))}
        {!attention.length && <div className="empty">Nothing needs attention 🎉</div>}
      </div>
    </div>
  )
}
