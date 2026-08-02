import { useState } from 'react'
import { STAGE } from '../../src/model/stages.js'
import { getCharacterById } from '../../src/model/characters.js'
import { courtLine, warehouseLine, COURT_VOICE_ID, WAREHOUSE_VOICE_ID } from '../../src/model/courtVoice.js'
import { imagesFor } from './data/characterImages.js'

// Ship Desk (Nima, 2026-07-31) — the UI over GET /api/label-gaps.
//
// The whole point of the endpoint is that the "Packed" queue hides TWO problems
// needing OPPOSITE actions, and lumping them together is what let SO12288 /
// SO12293 sit unnoticed. The UI has to preserve that split or it undoes the
// work: never render one "10 packed" number.
//
//   • LABELLED_NOT_SHIPPED — tracking exists, status never flipped. The parcel
//     is already with the customer while our books say it never left. Act in
//     NetSuite, not in the warehouse.
//   • NEEDS_LABEL — genuinely still on our floor awaiting a label. Act here.
//   • FREIGHT_BOL_LANE — EDI partners move on a BOL and will NEVER have parcel
//     tracking. Visible (so you know the lane exists) but never mixed into the
//     parcel counts, and never listed row-by-row — 12 Bloomingdale's rows would
//     out-shout the 10 items that actually need a decision.
//
// Two surfaces, deliberately different jobs:
//   CourtStrip  — app-wide, one line, "whose court is it in". Glanceable.
//   ShipDeskSector — Command Center, the detail you act from.

// ── shared helpers ───────────────────────────────────────────────────────────

// Age is the ranking signal — "nothing sits ignored" is the mission, so the
// oldest thing always sorts to the top and carries the loudest tone.
const byAgeDesc = (a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)

const ageTone = (d) => (d >= 21 ? 'sev-hi' : d >= 7 ? 'sev-mid' : 'sev-lo')

// Copy that actually copies. navigator.clipboard rejects with NotAllowedError
// more often than you'd think — Safari, a document that lost focus, anything
// the browser doesn't consider a trusted gesture — so the async API alone gives
// you a button that silently does nothing. Fall back to execCommand, and if
// even that fails, SELECT the text so ⌘C still works. Never a silent no-op.
async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) return 'copied'
    } catch { /* fall through to select */ }
    // Last resort: highlight it in place so the keyboard shortcut still works.
    try {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch { /* nothing more we can do */ }
    return 'select'
  }
}

// Click a tracking number to copy it — the next thing you do with it is paste
// it into NetSuite or ups.com, and multi-box IFs carry several.
function Tracking({ numbers = [] }) {
  const [state, setState] = useState({ n: null, result: null })
  if (!numbers.length) return null
  return (
    <span className="trkList">
      {numbers.map((t) => {
        const active = state.n === t
        return (
          <button
            key={t}
            className={'trk' + (active ? (state.result === 'copied' ? ' trkCopied' : ' trkSelect') : '')}
            // In the select-fallback the button KEEPS showing the number: the
            // selection range covers this node's contents, so swapping the
            // label for a hint would make ⌘C copy the hint instead of the
            // tracking number.
            title={active && state.result === 'select' ? 'Selected — press ⌘C to copy' : `Copy ${t}`}
            onClick={async (e) => {
              e.stopPropagation()
              const result = await copyText(t, e.currentTarget)
              setState({ n: t, result })
              setTimeout(() => setState({ n: null, result: null }), 1600)
            }}
          >
            {active && state.result === 'copied' ? '✓ copied' : t}
          </button>
        )
      })}
    </span>
  )
}

// ── the app-wide strip ───────────────────────────────────────────────────────

// Nima's framing (2026-07-31): differentiate by WHOSE COURT the work sits in,
// rather than showing one undifferentiated backlog.
//
// Judgment call worth keeping: the big pipeline volumes (73 pending
// fulfillment, 62 needing a pack) are deliberately NOT here. A "4 need a label"
// chip sitting next to a "73" reads as noise, which is the same failure that
// buried SO12293. Volume already lives in the Command Center stage strip; this
// strip is only the small, aging, someone-must-act set.
export function CourtStrip({ labelGaps, custody, bay, orders = [], ediGaps, asnCartons, onNavigate }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!labelGaps) return null

  const markShipped = labelGaps.counts?.labelledNotShipped ?? 0
  const needsLabel = labelGaps.counts?.needsLabel ?? 0
  const freight = labelGaps.counts?.freight ?? 0
  const withNestor = custody ? custody.filter((c) => c.state === 'with_warehouse').length : null
  const canShip = bay ? bay.filter((s) => s.floating).length : null
  const needsInvoice = orders.filter((o) => o.stage === STAGE.PACKED).length
  // Outbound EDI that never reached the partner. ASNs and invoices stay apart —
  // an unannounced shipment is a compliance chargeback, an undelivered invoice is
  // money not asked for. `refused` is excluded from these chips on purpose: it
  // needs reading, not re-sending, so it would dilute a re-send action.
  const asnStuck = ediGaps?.counts?.asnStuck ?? 0
  const invoiceStuck = ediGaps?.counts?.invoiceStuck ?? 0
  // Cartons that shipped and appear on NO delivered ASN. Kept as its own chip
  // rather than folded into asnStuck above, per the never-lump rule: an
  // undelivered DOCUMENT and an undeclared BOX are different failures with
  // different fixes — one 856 is stuck in transport, the other was never sent for
  // that carton at all. Summing them would hide which one you're looking at.
  const cartonsUnannounced = asnCartons?.counts?.undeclared ?? 0

  // The oldest ACTIONABLE parcel item, named. Freight is excluded on purpose —
  // an un-BOL'd freight shipment isn't a label problem and would only inflate
  // the headline age.
  const oldest = [...(labelGaps.labelledNotShipped || []), ...(labelGaps.needsLabel || [])]
    .sort(byAgeDesc)[0]

  const chips = [
    { key: 'markShipped', n: markShipped, label: 'mark shipped', tone: 'bad', to: 'command',
      title: 'These IFs carry a tracking number but are still Packed — they already went out; NetSuite just does not know yet' },
    { key: 'needsLabel', n: needsLabel, label: 'need a label', tone: 'warn', to: 'command',
      title: 'Packed with no carrier label — still physically here' },
    { key: 'freight', n: freight, label: 'need routing', tone: 'info', to: 'routing',
      title: 'EDI/freight lane — these move on a BOL, not a parcel label' },
    { key: 'needsInvoice', n: needsInvoice, label: 'need an invoice', tone: 'warn', to: 'kanban',
      title: 'Packed and waiting on an invoice' },
    { key: 'asnStuck', n: asnStuck, label: 'ASNs never sent', tone: 'bad', to: 'edi',
      title: 'Outbound 856s sitting undelivered in Orderful. NetSuite marks them synced, so this fails silently — the partner was never told the shipment is coming' },
    { key: 'cartonsUnannounced', n: cartonsUnannounced, label: 'cartons unannounced', tone: 'bad', to: 'edi',
      title: 'These cartons shipped and are on no delivered ASN — the partner received boxes it was never told about. The box is already gone, so the fix is sending the 856' },
    { key: 'invoiceStuck', n: invoiceStuck, label: 'invoices never sent', tone: 'warn', to: 'edi',
      title: 'Outbound 810s that never reached the partner — billed in NetSuite but never actually transmitted' },
    { key: 'canShip', n: canShip, label: 'can ship', tone: 'ok', to: 'launch',
      title: 'Cleared to launch — ready to go out' },
  ].filter((c) => c.n)

  // Absence IS the all-clear. No "nothing to do ✓" bar taking up space every
  // day — if the strip is on screen, there is work.
  if (!chips.length && !withNestor) return null

  if (collapsed) {
    // Even collapsed, keep the split. A single summed number here would be
    // dominated by the big lanes (invoices/routing) and bury the label gaps —
    // the exact lumping this whole feature exists to undo. So the pill carries
    // the two parcel actions plus the oldest age, and the rest rolls up.
    const parcel = [
      markShipped ? `${markShipped} mark shipped` : null,
      needsLabel ? `${needsLabel} need a label` : null,
    ].filter(Boolean)
    const rest = chips.reduce((n, c) => n + c.n, 0) - markShipped - needsLabel
    return (
      <div className="courtStrip collapsed">
        <button className="courtToggle" onClick={() => setCollapsed(false)} title="Show the ship desk">
          ⚑ {parcel.length ? parcel.join(' · ') : `${rest} in our court`}
          {parcel.length && rest ? ` · +${rest} more` : ''}
          {oldest ? ` · oldest ${oldest.ageDays}d` : ''} ▸
        </button>
      </div>
    )
  }

  return (
    <div className="courtStrip">
      <span className="courtGroup">
        <CrewVoice id={COURT_VOICE_ID} line={courtLine(chips, oldest)} />
        {chips.map((c) => (
          <button key={c.key} className={'courtChip ct-' + c.tone} title={c.title}
                  onClick={() => onNavigate?.(c.to)}>
            <b>{c.n}</b> {c.label}
          </button>
        ))}
      </span>

      {withNestor > 0 && (
        <span className="courtGroup courtNestor">
          <CrewVoice id={WAREHOUSE_VOICE_ID} line={warehouseLine(withNestor)} />
          <button className="courtChip ct-cyan" title="Scanned out to the warehouse and not yet back"
                  onClick={() => onNavigate?.('custody')}>
            <b>{withNestor}</b> scanned out
          </button>
        </span>
      )}

      {oldest && (
        <button className="courtOldest" onClick={() => onNavigate?.('command')}
                title="The oldest item that needs a decision — open the Ship Desk">
          ⚠ oldest: <b>{oldest.ifNumber}</b> · {oldest.customer || 'unknown'} ·{' '}
          <em>{oldest.ageDays}d {oldest.trackingNumbers?.length ? 'unmarked' : 'no label'}</em>
        </button>
      )}

      <button className="courtToggle courtHide" onClick={() => setCollapsed(true)} title="Collapse">▾</button>
    </div>
  )
}

// A crew member with something to say. Portrait-optional by design, like every
// other character surface in the app — the line still reads if the art for that
// character hasn't been dropped in yet, so adding a new one can never blank the
// strip.
function CrewVoice({ id, line }) {
  const c = getCharacterById(id)
  const img = imagesFor(id)[0]
  if (!line) return null
  return (
    <span className="courtVoice" title={c?.name || ''}>
      <span className="courtVoiceFace">{img ? <img src={img} alt="" /> : '◈'}</span>
      <span className="courtVoiceText">{line}</span>
    </span>
  )
}

// ── the Command Center sector (the detail you act from) ──────────────────────

// WHICH DATE to type into NetSuite (Nima's step 6). The date is the headline and
// the evidence is named beside it, because a bare date invites the reader to
// believe the app watched the truck leave — it did not. It knows when the goods
// were last physically scanned, and says so.
function ShipDate({ advice }) {
  if (!advice) return null
  if (!advice.suggestedDate) {
    return <div className="gapDate gapDateNone" title={advice.advice}>no scan — date it yourself</div>
  }
  const tone = advice.impossible ? 'gapDateBad'
    : advice.crossesMonthClose ? 'gapDateBad'
      : advice.severity >= 2 ? 'gapDateWarn' : 'gapDateOk'
  return (
    <div className={'gapDate ' + tone} title={advice.advice}>
      <span className="gapDateWhen">{advice.suggestedDate}</span>
      <span className="gapDateWhy">{advice.basisLabel}</span>
      {advice.impossible && <span className="gapDateTag">date impossible</span>}
      {!advice.impossible && advice.crossesMonthClose && <span className="gapDateTag">wrong month</span>}
      {!advice.impossible && !advice.crossesMonthClose && advice.driftDays > 0 &&
        <span className="gapDateDrift">{advice.driftDays}d back</span>}
    </div>
  )
}

function GapRow({ i, showTracking }) {
  // A month-crossing date outranks age for the row's colour: two days across the
  // close costs a re-dated month, nine days inside one costs nothing.
  const tone = i.advice?.crossesMonthClose || i.advice?.impossible ? 'sev-hi' : ageTone(i.ageDays ?? 0)
  return (
    <div className={'gapRow ' + tone}>
      <div className="gapTop">
        <span className="gapIf">{i.ifNumber}</span>
        <span className="gapSo">{i.soNumber}</span>
        <span className="gapAge">{i.ageDays != null ? `${i.ageDays}d` : ''}</span>
      </div>
      <div className="gapCust">{i.customer || 'unknown customer'}</div>
      <ShipDate advice={i.advice} />
      {showTracking && <Tracking numbers={i.trackingNumbers} />}
    </div>
  )
}

export function ShipDeskSector({ labelGaps, onNavigate }) {
  if (!labelGaps) return <div className="empty">Reading the ship desk…</div>

  // NOT re-sorted by age: the server already ranked these by month-close, which
  // is the order that matters. Sorting by age here would bury a 1-day shipment
  // that lands in last month's books under a 9-day one that doesn't.
  const marked = labelGaps.labelledNotShipped || []
  const monthClose = labelGaps.counts?.monthClose ?? 0
  const unlabelled = [...(labelGaps.needsLabel || [])].sort(byAgeDesc)
  const freight = labelGaps.freight || []

  if (!marked.length && !unlabelled.length && !freight.length) {
    return <div className="empty">Ship desk clear — nothing packed is waiting on you 🎉</div>
  }

  return (
    <div className="shipDesk">
      {/* Column 1 — already gone, books don't know. Loudest, because the
          customer already has the box while we still count it as ours. */}
      <div className="deskCol deskAct">
        <div className="deskHead bad">
          ✈ MARK IT SHIPPED <span className="sectorCount">{marked.length}</span>
        </div>
        <div className="deskWhy">
          Has tracking but still Packed — it went out; flip the status in NetSuite,
          <b> using the date shown</b>, not today's.
          {monthClose > 0 && (
            <span className="deskAlarm">
              {monthClose === 1 ? '1 belongs' : `${monthClose} belong`} in a closed month — do these first.
            </span>
          )}
        </div>
        {marked.map((i) => <GapRow key={i.ifNumber} i={i} showTracking />)}
        {!marked.length && <div className="empty">None — every labelled IF is marked shipped.</div>}
      </div>

      {/* Column 2 — genuinely still on the floor. */}
      <div className="deskCol deskAct">
        <div className="deskHead warn">
          ⌖ NEEDS A LABEL <span className="sectorCount">{unlabelled.length}</span>
        </div>
        <div className="deskWhy">Packed, no carrier label — still here. Parcel lane only.</div>
        {unlabelled.map((i) => <GapRow key={i.ifNumber} i={i} />)}
        {!unlabelled.length && <div className="empty">None — everything packed has a label.</div>}
      </div>

      {/* Column 3 — the freight lane. Present so you know it exists and never
          silently dropped, but dimmed and summarised: it has no parcel action,
          and listing every DC would out-shout the two columns that do. */}
      <div className="deskCol deskFreight">
        <div className="deskHead info">
          ⛴ FREIGHT · BOL LANE <span className="sectorCount">{freight.length}</span>
        </div>
        <div className="deskWhy">EDI partners move on a BOL, never a parcel label — routed, not labelled.</div>
        {freight.length > 0 ? (
          <>
            <div className="freightRoll">
              {[...new Set(freight.map((f) => (f.customer || '').replace(/\s*-.*$/, '').trim() || 'unknown'))]
                .map((name) => (
                  <span key={name} className="freightPartner">
                    {name}
                    <b>{freight.filter((f) => (f.customer || '').replace(/\s*-.*$/, '').trim() === name).length}</b>
                  </span>
                ))}
            </div>
            <button className="btnGhost deskGo" onClick={() => onNavigate?.('routing')}>
              ↗ open Routing to BOL these
            </button>
          </>
        ) : (
          <div className="empty">No freight waiting on a BOL.</div>
        )}
      </div>
    </div>
  )
}
