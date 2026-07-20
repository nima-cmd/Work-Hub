import { useState } from 'react'
import { STAGE_SHORT, sevClass, SourceBadge, docRef, docDate, LabelButtons, NoteWidget } from '../lib.jsx'
import { groupOrdersByPo } from '../../../src/model/poGroups.js'

// Dense, sortable table — closest to NetSuite/Airtable habits.
// By default it collapses the buyer-PO fan-out (one customer PO that NetSuite
// split into many SOs — e.g. Bloomingdale's 23 SOs on one PO) into a single
// row you can expand; toggle off to see every raw SO.
export default function TableView({ orders }) {
  const [sort, setSort] = useState({ key: 'severity', dir: -1 })
  const [grouped, setGrouped] = useState(true)
  const [open, setOpen] = useState(() => new Set())

  const rows = grouped ? groupOrdersByPo(orders) : orders
  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.key]
    const bv = b[sort.key]
    if (av == null) return 1
    if (bv == null) return -1
    return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir
  })

  const collapsedCount = grouped ? orders.length - rows.length : 0
  const toggleRow = (po) => setOpen((s) => { const n = new Set(s); n.has(po) ? n.delete(po) : n.add(po); return n })

  const Th = ({ k, children }) => (
    <th onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : -1 }))} className="sortable">
      {children}{sort.key === k ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  )

  // one <tr> for an order OR a group; groups get an expand caret + member rows
  const Row = ({ o }) => {
    const isOpen = o.isGroup && open.has(o.poNumber)
    return (
      <>
        <tr className={sevClass(o.severity)} style={o.isGroup ? { cursor: 'pointer' } : undefined}
            onClick={o.isGroup ? () => toggleRow(o.poNumber) : undefined}>
          <td className="mono">
            {o.isGroup
              ? <>{isOpen ? '▾' : '▸'} PO {o.poNumber} <span className="badge edi" style={{ marginLeft: 4 }}>{o.memberCount} SOs</span></>
              : <>{o.soNumber} <SourceBadge source={o.source} /></>}
          </td>
          <td>{o.customer}{o.isGroup && o.customer === 'Multiple customers' ? '' : ''}</td>
          <td>{o.location}</td>
          <td className="mono">{o.poNumber}</td>
          <td>{STAGE_SHORT[o.stage] || o.stage}</td>
          <td className="mono">
            {docRef(o)}
            {docDate(o) && <span className="docdate"> · {docDate(o)}</span>}
            {!o.isGroup && (o.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
              <div key={f.ifNumber}>
                <LabelButtons info={{ ifNumber: f.ifNumber, soNumber: o.soNumber, customer: o.customer, poNumber: o.poNumber }} />
              </div>
            ))}
            {!o.isGroup && <NoteWidget docType="SO" docNumber={o.soNumber} />}
          </td>
          <td className="num">{o.daysPending ?? ''}</td>
          <td>{o.nextAction}</td>
          <td className="flagcell">
            {o.flags.map((f, i) => <span key={i} className={'flag ' + sevClass(f.severity)}>{f.label}</span>)}
          </td>
        </tr>
        {isOpen && o.members.map((m) => (
          <tr key={m.soNumber} className="groupMember">
            <td className="mono" style={{ paddingLeft: 24 }}>↳ {m.soNumber} <SourceBadge source={m.source} /></td>
            <td>{m.customer}</td>
            <td>{m.location}</td>
            <td className="mono">{m.poNumber}</td>
            <td>{STAGE_SHORT[m.stage] || m.stage}</td>
            <td className="mono">
              {docRef(m)}
              {(m.fulfillments || []).filter((f) => f.ifNumber).map((f) => (
                <div key={f.ifNumber}><LabelButtons info={{ ifNumber: f.ifNumber, soNumber: m.soNumber, customer: m.customer, poNumber: m.poNumber }} /></div>
              ))}
              <NoteWidget docType="SO" docNumber={m.soNumber} />
            </td>
            <td className="num">{m.daysPending ?? ''}</td>
            <td>{m.nextAction}</td>
            <td className="flagcell">
              {m.flags.map((f, i) => <span key={i} className={'flag ' + sevClass(f.severity)}>{f.label}</span>)}
            </td>
          </tr>
        ))}
      </>
    )
  }

  return (
    <div>
      <div className="allocStats" style={{ marginBottom: 12 }}>
        <button className={grouped ? 'btn' : 'btnGhost'} onClick={() => setGrouped((g) => !g)}>
          {grouped ? '▤ Grouped by PO' : '≣ All SOs'}
        </button>
        {grouped && collapsedCount > 0 && (
          <span className="pill">{collapsedCount} split SO{collapsedCount === 1 ? '' : 's'} rolled up</span>
        )}
        <span className="pill">{sorted.length} rows</span>
      </div>
      <div className="tableWrap">
        <table className="grid">
          <thead>
            <tr>
              <Th k="soNumber">SO / PO</Th>
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
            {sorted.map((o) => <Row key={o.soNumber} o={o} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
