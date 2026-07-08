import { SourceBadge } from '../lib.jsx'

// Agenda of upcoming deadlines: Ship dates and (harder) Cancel dates.
// Cancel dates are "ship by or lose it" — flagged red, and doubly important for
// EDI orders where a miss also means a chargeback.
export default function Calendar({ orders }) {
  const today = startOfDay(Date.now())
  const weekEnd = today + 7 * 86400000

  const events = []
  for (const o of orders) {
    if (o.shipDate) events.push(evt(o, o.shipDate, 'Ship'))
    if (o.cancelDate) events.push(evt(o, o.cancelDate, 'Cancel'))
  }
  events.sort((a, b) => a.t - b.t)

  const groups = { Overdue: [], Today: [], 'Next 7 days': [], Later: [] }
  for (const e of events) {
    if (e.day < today) groups.Overdue.push(e)
    else if (e.day === today) groups.Today.push(e)
    else if (e.day <= weekEnd) groups['Next 7 days'].push(e)
    else groups.Later.push(e)
  }

  const headClass = { Overdue: 'sev-hi', Today: 'sev-mid' }

  return (
    <div className="calendar">
      {Object.entries(groups).map(([label, list]) =>
        list.length ? (
          <section key={label} className="calGroup">
            <h3 className={'calHead ' + (headClass[label] || '')}>
              {label} <span className="count">{list.length}</span>
            </h3>
            {list.map((e, i) => (
              <div key={i} className={'calRow ' + (e.kind === 'Cancel' ? 'cancel' : '')}>
                <span className="caldate">{fmt(e.t)}</span>
                <span className={'caltag ' + (e.kind === 'Cancel' ? 'sev-hi' : 'sev-lo')}>
                  {e.kind}
                </span>
                <span className="so">{e.o.soNumber}</span>
                <span className="cust">{e.o.customer}</span>
                <SourceBadge source={e.o.source} />
              </div>
            ))}
          </section>
        ) : null,
      )}
    </div>
  )
}

function evt(o, dateStr, kind) {
  const t = new Date(dateStr).getTime()
  return { o, kind, t, day: startOfDay(t) }
}
function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function fmt(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
