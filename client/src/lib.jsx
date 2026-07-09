// Shared bits used across all three views.

export const STAGE_ORDER = [
  'ON_HOLD_APPROVAL',
  'OPEN_NEEDS_FULFILLMENT',
  'PICKED_NEEDS_PACK',
  'PACKED_PENDING_NEXT',
  'INVOICED_PENDING_PAYMENT',
  'APPROVED_FOR_SHIPPING',
  'SHIPPED',
]

export const STAGE_SHORT = {
  ON_HOLD_APPROVAL: 'On Hold',
  OPEN_NEEDS_FULFILLMENT: 'Open',
  PICKED_NEEDS_PACK: 'Picked',
  PACKED_PENDING_NEXT: 'Packed',
  INVOICED_PENDING_PAYMENT: 'Invoiced',
  APPROVED_FOR_SHIPPING: 'Approved',
  SHIPPED: 'Shipped',
}

// severity → css class (3 act now, 2 caution, 1 watch, 0 none)
export const sevClass = (s) =>
  s >= 3 ? 'sev-hi' : s >= 2 ? 'sev-mid' : s >= 1 ? 'sev-lo' : 'sev-none'

export function Flags({ flags }) {
  if (!flags?.length) return null
  return (
    <div className="flags">
      {flags.map((f, i) => (
        <span key={i} className={'flag ' + sevClass(f.severity)}>
          {f.label}
        </span>
      ))}
    </div>
  )
}

export const ifList = (o) =>
  (o.fulfillments || []).map((f) => f.ifNumber).filter(Boolean).join(', ')

// The one document worth showing for this order's current stage: the IF#
// while it's still moving through fulfillment, the invoice # once it's
// past that (falls back to IF# if no invoice is on file yet).
const INVOICED_OR_LATER = new Set([
  'INVOICED_PENDING_PAYMENT',
  'APPROVED_FOR_SHIPPING',
  'SHIPPED',
])
export function docRef(o) {
  const ifs = ifList(o)
  // The Pending Orders search's "Invoice for IF" column gives the precise
  // per-fulfillment pairing (which invoice was actually generated against
  // which IF) — it's known the moment NetSuite creates the invoice, before
  // the order search even reports the order as "Invoiced". Prefer it over
  // the order-level invoices join whenever it's present.
  const perIf = (o.fulfillments || []).map((f) => f.invoice).filter(Boolean).join(', ')
  if (perIf) return perIf
  if (INVOICED_OR_LATER.has(o.stage)) {
    const invs = (o.invoices || []).map((i) => i.invNumber).filter(Boolean).join(', ')
    return invs || ifs || ''
  }
  return ifs || ''
}

// The date the current-stage document entered its state — for an Item
// Fulfillment, NetSuite's date IS the day it was moved into that status
// (e.g. the day it was printed/picked). Surfacing it answers "how long has
// this been sitting with us needing our part?". Latest IF date wins.
export function docDate(o) {
  const dates = (o.fulfillments || []).map((f) => f.ifDate).filter(Boolean)
  if (!dates.length) return ''
  return fmtShortDate(dates.slice().sort().at(-1)) // ISO 'YYYY-MM-DD' sorts lexically
}

function fmtShortDate(s) {
  // Take the date part only and build from Y/M/D so a 'YYYY-MM-DD' value
  // (UTC midnight) isn't shifted back a day when rendered in a US timezone.
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return `${Number(m[2])}/${Number(m[3])}`
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

// EDI channel badge (ShopBop / Nordstrom / Bloomingdale's).
export function SourceBadge({ source }) {
  if (source === 'edi') return <span className="badge edi">EDI</span>
  return null
}

// Human-friendly age from hours.
export function fmtAge(hours) {
  if (hours == null) return 'unknown'
  if (hours < 1) return '<1h old'
  if (hours < 48) return `${Math.round(hours)}h old`
  return `${Math.round(hours / 24)}d old`
}
