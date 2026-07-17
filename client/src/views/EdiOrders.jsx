import { Fragment, useEffect, useState } from 'react'
import { fetchEdiReview, syncEdi, linkEdiTransaction, unlinkEdiTransaction, addEdiManualOrder, removeEdiManualOrder } from '../api.js'

const ISSUE_STATUSES = new Set(['INVALID', 'FAILED', 'REJECTED', 'OVERDUE'])
function isIssueValue(v) {
  return ISSUE_STATUSES.has(v)
}

// The buckets Nima asked for (2026-07-10) — ordered so the most foundational
// gap (no master document at all) comes first, then the earliest actionable
// step. "OTHER" is the catch-all so nothing silently disappears.
const TABS = [
  { key: 'NO_850_FOUND', label: "Can't find an 850 — link manually" },
  { key: 'NEEDS_IMPORT', label: 'Needs packing / import to NetSuite' },
  { key: 'NEEDS_ASN', label: 'Needs ASN transmitted' },
  { key: 'CANNOT_LINK', label: "Can't be linked to NetSuite" },
  { key: 'OTHER', label: 'Everything else' },
]

// Mirrors Airtable's 850 Tracker/856 tables, pulled live from Orderful's API
// into Neon instead of via CSV → Airtable. The 850 is the master document —
// every 856/810 must resolve to one (automatically via PO#/BOL, or by hand
// here when it can't). Grouped by business number / PO, not by individual
// transaction — the relationship between documents matters more than any one
// of them. Read-only otherwise — Chargebacks and Routing stay out of scope.
export default function EdiOrders() {
  const [review, setReview] = useState(null)
  const [err, setErr] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)
  const [selectedPartner, setSelectedPartner] = useState(null)
  const [activeTab, setActiveTab] = useState('NO_850_FOUND')
  const [expanded, setExpanded] = useState(() => new Set())
  const [linkDrafts, setLinkDrafts] = useState({})
  const [linkBusy, setLinkBusy] = useState(null)
  const [manualDraft, setManualDraft] = useState(null) // null = form closed
  const [manualBusy, setManualBusy] = useState(false)

  function load() {
    fetchEdiReview().then(setReview).catch((e) => setErr(e.message))
  }
  useEffect(load, [])

  async function onSync() {
    setSyncing(true)
    setSyncMsg(null)
    setErr(null)
    try {
      const r = await syncEdi()
      setSyncMsg(`Synced ${r.upserted} transaction(s) from Orderful.`)
      load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSyncing(false)
    }
  }

  const selectPartner = (name) => {
    setSelectedPartner(name === selectedPartner ? null : name)
    setActiveTab('NO_850_FOUND')
  }

  const toggle = (businessNumber) =>
    setExpanded((s) => {
      const next = new Set(s)
      next.has(businessNumber) ? next.delete(businessNumber) : next.add(businessNumber)
      return next
    })

  const setDraft = (txnId, patch) => setLinkDrafts((s) => ({ ...s, [txnId]: { ...s[txnId], ...patch } }))

  async function submitLink(txnId) {
    const draft = linkDrafts[txnId]
    if (!draft?.businessNumber) return setErr('Enter the PO/business number to link this to')
    setLinkBusy(txnId)
    setErr(null)
    try {
      setReview(await linkEdiTransaction({ transactionId: txnId, businessNumber: draft.businessNumber, note: draft.note }))
      setLinkDrafts((s) => { const n = { ...s }; delete n[txnId]; return n })
    } catch (e) {
      setErr(e.message)
    } finally {
      setLinkBusy(null)
    }
  }

  async function undoLink(txnId) {
    if (!window.confirm('Remove this manual link? The document will go back to being unlinked.')) return
    setLinkBusy(txnId)
    try {
      setReview(await unlinkEdiTransaction(txnId))
    } catch (e) {
      setErr(e.message)
    } finally {
      setLinkBusy(null)
    }
  }

  async function onAddManual(e) {
    e.preventDefault()
    if (!manualDraft?.businessNumber?.trim()) return
    setManualBusy(true)
    setErr(null)
    try {
      setReview(await addEdiManualOrder(manualDraft))
      setManualDraft(null)
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setManualBusy(false)
    }
  }

  async function onRemoveManual(id) {
    if (!window.confirm('Remove this manually-entered EDI order?')) return
    try {
      setReview(await removeEdiManualOrder(id))
    } catch (e2) {
      setErr(e2.message)
    }
  }

  if (err && !review) return <div className="banner error">⚠ Couldn’t load EDI review: {err}</div>
  if (!review) return <div className="banner">Loading EDI review…</div>

  const { partners, orders, manualOrders = [] } = review
  const totalOrders = orders.length
  const totalIssues = orders.filter((o) => o.hasIssue).length
  const partnerOrders = selectedPartner ? orders.filter((o) => (o.tradingPartner || '(unknown partner)') === selectedPartner) : []
  const shownOrders = partnerOrders.filter((o) => o.bucket === activeTab)

  return (
    <div className="allocWrap">
      {err && <div className="banner error">⚠ {err}</div>}
      {syncMsg && <div className="banner ok">{syncMsg}</div>}

      <div className="allocStats">
        <span className="pill">{totalOrders} EDI orders</span>
        <span className="pill danger">{totalIssues} need attention</span>
        <button className="btnGhost" disabled={syncing} onClick={onSync}>
          {syncing ? 'Syncing…' : '↻ Sync from Orderful'}
        </button>
      </div>

      <section>
        <h2>Trading partners</h2>
        <p className="hint">Pick a partner to see its 850 → 856 → 810 pipeline, grouped by PO — not by individual transaction.</p>
        <div className="locHub">
          {partners.map((p) => (
            <div
              key={p.tradingPartner}
              className={'locTile' + (selectedPartner === p.tradingPartner ? ' active' : '')}
              onClick={() => selectPartner(p.tradingPartner)}
            >
              <h3>{p.tradingPartner}</h3>
              <div className="locStat">{p.orderCount} orders</div>
              {p.no850Count > 0 && <span className="flag sev-hi">{p.no850Count} no 850</span>}
              {p.needsImportCount > 0 && <span className="flag sev-mid" style={{ marginLeft: 6 }}>{p.needsImportCount} need packing</span>}
              {p.needsAsnCount > 0 && <span className="flag sev-hi" style={{ marginLeft: 6 }}>{p.needsAsnCount} need ASN</span>}
              {p.cannotLinkCount > 0 && <span className="flag sev-hi" style={{ marginLeft: 6 }}>{p.cannotLinkCount} can't link</span>}
              {!p.no850Count && !p.needsImportCount && !p.needsAsnCount && !p.cannotLinkCount && <span className="flag sev-lo">clean</span>}
            </div>
          ))}
        </div>
      </section>

      {selectedPartner && (
        <section>
          <h2>{selectedPartner} <span className="count">{partnerOrders.length} orders</span></h2>
          <div className="tabs" style={{ marginBottom: 14 }}>
            {TABS.map((t) => {
              const count = partnerOrders.filter((o) => o.bucket === t.key).length
              return (
                <button key={t.key} className={'tab' + (activeTab === t.key ? ' active' : '')} onClick={() => setActiveTab(t.key)}>
                  {t.label} <span className="count">{count}</span>
                </button>
              )
            })}
          </div>

          {!shownOrders.length && <div className="empty">Nothing in this bucket right now.</div>}
          {!!shownOrders.length && activeTab === 'NO_850_FOUND' && (
            <p className="hint">
              These documents (856 ship notices or 810 invoices) have no matching 850 anywhere in Orderful — link each one to the
              PO it actually belongs to. This is a manual override, always flagged as such, never treated as an automated match.
            </p>
          )}

          {!!shownOrders.length && (
            <table className="grid">
              <thead>
                <tr><th>Business # / PO</th><th>Stage</th><th>Ship window</th><th>NetSuite</th><th>Last updated</th><th></th></tr>
              </thead>
              <tbody>
                {shownOrders.map((o) => {
                  const isOpen = expanded.has(o.businessNumber)
                  return (
                    <Fragment key={o.businessNumber}>
                      <tr onClick={() => toggle(o.businessNumber)} style={{ cursor: 'pointer' }}>
                        <td className="mono">
                          {o.businessNumber}
                          {o.hasManualLinks && <span className="flag sev-mid" style={{ marginLeft: 6 }}>manually linked</span>}
                        </td>
                        <td>
                          <span className={'flag ' + (o.hasIssue ? 'sev-hi' : 'sev-lo')}>{o.stage}</span>
                        </td>
                        <td className="cust">
                          {o.shipNotBefore ? new Date(o.shipNotBefore).toLocaleDateString() : '—'}
                          {' → '}
                          {o.cancelAfter ? new Date(o.cancelAfter).toLocaleDateString() : '—'}
                        </td>
                        <td className="cust">{o.netsuiteOrder ? `${o.netsuiteOrder.soNumber} · ${o.netsuiteOrder.nextAction}` : '—'}</td>
                        <td className="cust">{o.lastUpdatedAt ? new Date(o.lastUpdatedAt).toLocaleString() : '—'}</td>
                        <td className="cust">{isOpen ? '▾' : '▸'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6}>
                            {!!o.linkGaps.length && (
                              <div className="allocPos">
                                {o.linkGaps.map((g, i) => <div key={i} className="sev-hi">⚠ {g}</div>)}
                              </div>
                            )}
                            {!!o.fulfillments.length && (
                              <div className="allocPos">
                                {o.fulfillments.map((f, i) => (
                                  <div key={i}>
                                    DC {f.dc} ({f.dcCity || '—'}) &middot; BOL {f.bol || '—'} &middot; carrier {f.scac || '—'}
                                    {f.shipDate && ` · shipped ${new Date(f.shipDate).toLocaleDateString()}`}
                                  </div>
                                ))}
                              </div>
                            )}
                            {o.netsuiteOrder && (o.netsuiteOrder.itemFulfillments.length > 0 || o.netsuiteOrder.invoices.length > 0) && (
                              <div className="allocPos">
                                <div className="cust">{o.netsuiteOrder.soNumber} — {o.netsuiteOrder.stageLabel}</div>
                                {o.netsuiteOrder.itemFulfillments.map((f) => (
                                  <div key={f.ifNumber}>
                                    IF {f.ifNumber} &middot; {f.status}
                                    {f.actualShipDate && ` · shipped ${new Date(f.actualShipDate).toLocaleDateString()}`}
                                    {f.invoiceNumber && ` · invoice ${f.invoiceNumber}`}
                                  </div>
                                ))}
                                {o.netsuiteOrder.invoices.map((i) => (
                                  <div key={i.invNumber}>
                                    Invoice {i.invNumber} &middot; {i.status}
                                    {i.amountRemaining > 0 && ` · $${i.amountRemaining} remaining`}
                                  </div>
                                ))}
                              </div>
                            )}
                            <table className="grid">
                              <thead>
                                <tr><th>Document</th><th>Direction</th><th>Status</th><th>Created</th><th></th></tr>
                              </thead>
                              <tbody>
                                {o.transactions.map((t) => {
                                  const issue = [t.validationStatus, t.deliveryStatus, t.acknowledgmentStatus].find(isIssueValue)
                                  const draft = linkDrafts[t.id] || {}
                                  return (
                                    <Fragment key={t.id}>
                                      <tr>
                                        <td className="mono">{t.type}</td>
                                        <td>{t.direction}</td>
                                        <td className={issue ? 'sev-hi' : ''}>{issue || t.deliveryStatus}</td>
                                        <td className="cust">{t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}</td>
                                        <td>
                                          {t.manualLinkNote !== undefined && (
                                            <button className="btnGhost" disabled={linkBusy === t.id} onClick={() => undoLink(t.id)}>
                                              Undo link{t.manualLinkNote ? ` (${t.manualLinkNote})` : ''}
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                      {o.bucket === 'NO_850_FOUND' && (
                                        <tr>
                                          <td colSpan={5}>
                                            <input
                                              className="qtyInput" style={{ width: 140 }} placeholder="PO / business #"
                                              value={draft.businessNumber ?? ''}
                                              onChange={(e) => setDraft(t.id, { businessNumber: e.target.value })}
                                            />
                                            <input
                                              className="qtyInput" style={{ width: 220, marginLeft: 6 }} placeholder="Note (optional)"
                                              value={draft.note ?? ''}
                                              onChange={(e) => setDraft(t.id, { note: e.target.value })}
                                            />
                                            <button
                                              className="btn" style={{ marginLeft: 6 }} disabled={linkBusy === t.id}
                                              onClick={() => submitLink(t.id)}
                                            >
                                              {linkBusy === t.id ? '…' : 'Link'}
                                            </button>
                                          </td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  )
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Manually-entered EDI orders — the gap-filler for orders that shipped
          and aged out of every search/Orderful pull. Kept in its own section,
          every row flagged unconfirmed, never mixed with the automated pipeline. */}
      <section style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ margin: 0 }}>
            Manual entries <span className="count">{manualOrders.length}</span>
          </h2>
          <button className="btn" onClick={() => setManualDraft(manualDraft ? null : { businessNumber: '', tradingPartner: '', note: '' })}>
            {manualDraft ? '✕ Cancel' : '＋ Add manual order'}
          </button>
        </div>
        <p className="hint">
          For older EDI orders that already shipped and no longer appear in the searches or the Orderful pull. These are hand-entered
          and <b>not confirmed through our process</b> — treat the details as a memory aid, not a verified record.
        </p>

        {manualDraft && (
          <form className="allocCard container" onSubmit={onAddManual} style={{ marginBottom: 12 }}>
            <div className="allocTwoCol" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <h3>PO / business number *</h3>
                <input className="qtyInput" style={{ width: '100%' }} placeholder="e.g. 50125578" autoFocus
                  value={manualDraft.businessNumber} onChange={(e) => setManualDraft({ ...manualDraft, businessNumber: e.target.value })} />
              </div>
              <div>
                <h3>Trading partner</h3>
                <input className="qtyInput" style={{ width: '100%' }} placeholder="Bloomingdale's / Nordstrom / ShopBop"
                  value={manualDraft.tradingPartner} onChange={(e) => setManualDraft({ ...manualDraft, tradingPartner: e.target.value })} />
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <h3 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 6px' }}>What's known (optional)</h3>
              <textarea className="qtyInput" style={{ width: '100%', minHeight: 48, resize: 'vertical' }}
                placeholder="Ship date, which documents you saw, where you found it…"
                value={manualDraft.note} onChange={(e) => setManualDraft({ ...manualDraft, note: e.target.value })} />
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn" disabled={manualBusy || !manualDraft.businessNumber.trim()}>
                {manualBusy ? 'Saving…' : 'Save manual order'}
              </button>
            </div>
          </form>
        )}

        {!manualOrders.length && !manualDraft && <div className="empty">No manual entries.</div>}
        {manualOrders.map((m) => (
          <div key={m.id} className="allocCard container" style={{ borderColor: 'rgba(217,130,43,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div>
                <div>
                  <span className="mono" style={{ fontWeight: 700 }}>{m.businessNumber}</span>
                  <span className="flag sev-mid" style={{ marginLeft: 8 }}>⚠ MANUAL — not confirmed by our process</span>
                </div>
                <div className="cust" style={{ marginTop: 4 }}>
                  {m.tradingPartner || 'partner not set'}
                  {m.createdAt ? ` · added ${new Date(m.createdAt).toLocaleDateString()}` : ''}
                </div>
                {m.note && <div style={{ marginTop: 6, fontSize: 13 }}>{m.note}</div>}
              </div>
              <button className="btnGhost" onClick={() => onRemoveManual(m.id)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
