import { STAGE_ORDER, STAGE_SHORT, sevClass, Flags, docRef, docDate, SourceBadge } from '../lib.jsx'

// Pipeline as columns: Open → Picked → Packed → Invoiced → Approved → Shipped.
export default function Kanban({ orders }) {
  const cols = STAGE_ORDER.map((s) => ({
    s,
    items: orders
      .filter((o) => o.stage === s)
      .sort((a, b) => b.severity - a.severity),
  })).filter((c) => c.items.length)

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
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
