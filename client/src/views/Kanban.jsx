import { STAGE_ORDER, STAGE_SHORT, sevClass, Flags, docRef, docDate, SourceBadge, taskToCard, LabelButtons } from '../lib.jsx'

// Pipeline as columns: Open → Picked → Packed → Invoiced → Approved → Shipped,
// plus a trailing Tasks column for open quest_tasks (Gmail/Slack
// transmissions promoted to durable tasks) — they have no NetSuite stage, so
// they get their own column rather than being forced into one of the seven.
export default function Kanban({ orders, tasks = [] }) {
  const cols = STAGE_ORDER.map((s) => ({
    s,
    items: orders
      .filter((o) => o.stage === s)
      .sort((a, b) => b.severity - a.severity),
  })).filter((c) => c.items.length)

  const openTasks = tasks
    .filter((t) => t.status === 'open')
    .map(taskToCard)
    .sort((a, b) => b.severity - a.severity)

  return (
    <div className="kanban">
      {cols.map(({ s, items }) => (
        <div className="col" key={s}>
          <div className="colHead">
            {STAGE_SHORT[s]} <span className="count">{items.length}</span>
          </div>
          {items.map((o) => (
            <div key={o.soNumber} className={'kcard ' + sevClass(o.severity)}>
              <div className="krow">
                <span className="so">{o.soNumber}</span>
                <SourceBadge source={o.source} />
              </div>
              <div className="cust">{o.customer}</div>
              {docRef(o) && (
                <div className="ifs">
                  {docRef(o)}
                  {docDate(o) && <span className="docdate"> · {docDate(o)}</span>}
                </div>
              )}
              <Flags flags={o.flags} />
              {(o.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
                <LabelButtons key={f.ifNumber} info={{ ifNumber: f.ifNumber, soNumber: o.soNumber, customer: o.customer, poNumber: o.poNumber }} />
              ))}
            </div>
          ))}
        </div>
      ))}

      {!!openTasks.length && (
        <div className="col">
          <div className="colHead">
            Tasks <span className="count">{openTasks.length}</span>
          </div>
          {openTasks.map((o) => (
            <div key={o.soNumber} className={'kcard ' + sevClass(o.severity)}>
              <div className="krow">
                <span className="so">{o.soNumber}</span>
                <SourceBadge source={o.source} character={o.character} />
              </div>
              <div className="cust">{o.customer}</div>
              <div className="ifs">{o.nextAction}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
