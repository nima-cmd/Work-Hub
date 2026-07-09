import { useState } from 'react'
import { STAGE_SHORT, sevClass, SourceBadge, docRef, docDate } from '../lib.jsx'

// Dense, sortable table — closest to NetSuite/Airtable habits.
export default function TableView({ orders }) {
  const [sort, setSort] = useState({ key: 'severity', dir: -1 })

  const sorted = [...orders].sort((a, b) => {
    const av = a[sort.key]
    const bv = b[sort.key]
    if (av == null) return 1
    if (bv == null) return -1
    return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir
  })

  const Th = ({ k, children }) => (
    <th
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : -1 }))}
      className="sortable"
    >
      {children}
      {sort.key === k ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  )

  return (
    <div className="tableWrap">
      <table className="grid">
        <thead>
          <tr>
            <Th k="soNumber">SO</Th>
            <Th k="customer">Customer</Th>
            <Th k="location">Location</Th>
            <Th k="poNumber">PO#</Th>
            <Th k="stageRank">Stage</Th>
            <th>IF / Invoice #</th>
            <Th k="daysPending">Days pending</Th>
            <th>Next action</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o) => (
            <tr key={o.soNumber} className={sevClass(o.severity)}>
              <td className="mono">{o.soNumber} <SourceBadge source={o.source} /></td>
              <td>{o.customer}</td>
              <td>{o.location}</td>
              <td className="mono">{o.poNumber}</td>
              <td>{STAGE_SHORT[o.stage] || o.stage}</td>
              <td className="mono">
                {docRef(o)}
                {docDate(o) && <span className="docdate"> · {docDate(o)}</span>}
              </td>
              <td className="num">{o.daysPending ?? ''}</td>
              <td>{o.nextAction}</td>
              <td className="flagcell">
                {o.flags.map((f, i) => (
                  <span key={i} className={'flag ' + sevClass(f.severity)}>
                    {f.label}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
