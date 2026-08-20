// The steps a manual "Refresh NetSuite" actually performs, in the order it
// performs them (Nima, 2026-08-11: "a load bar when updating … a red progress
// overlay or a percentage number in one corner").
//
// The point of this file existing at all: a progress bar is a COUNTER, and every
// counter bug in this repo has been one of four shapes — the two that apply here
// are "counts something other than its label" and "a comment describing a
// mechanism no code implements". A percentage invented from a timer would be
// exactly the second: it would look like progress while measuring nothing. So
// each tick below is a real unit of work that has actually started, the total is
// this list's length, and there is no second copy of either to drift.
//
// The refresh is three nested callers (queries.refreshFromNetsuite →
// netsuiteSync.syncFromNetsuite → fetchOrderLifecycle), which is why the list is
// here rather than in any one of them: each emitter passes a KEY and this module
// resolves the position, so a step nobody emits and a step emitted twice are both
// visible rather than silently changing what the percentage means.
//
// ⚠️ The steps are NOT equal in duration, so this is "steps done, of steps
// planned", never "time remaining", and the UI says so by naming the step in
// flight.
//
// ⚠️ The write is where the time goes, which is the opposite of what I assumed.
// The first cut had ONE step for the whole database transaction, and measured on
// a live pull (2026-08-11, 239 orders / 187 fulfilments / 1,160 invoices) it sat
// at 73% for ~90 of the run's ~130 seconds while the eight SuiteQL pulls went by
// in about 20. A bar that is motionless for two thirds of the wait is not a
// progress bar. Hence the transaction is broken out below: resolution belongs
// where the time actually is, and the only way to know where that is, is to run
// it and look.
// `phase` is the verb, carried once per step so the button's top line can say
// what KIND of work is happening while the small line names the thing. The first
// cut repeated the verb in every label ("saving order confirmations") and the
// sub-line ran off the end of the button — a header button cannot grow to fit
// prose, and the whole point of this was to save space.
export const REFRESH_STEPS = [
  // Eight SuiteQL reads, sequential exactly like the cron (never parallel —
  // that is the change that would genuinely cost Celigo concurrency).
  { key: 'orders', phase: 'Pulling', label: 'orders' },
  { key: 'locations', phase: 'Pulling', label: 'locations' },
  { key: 'orderLines', phase: 'Pulling', label: 'order lines' },
  { key: 'fulfillments', phase: 'Pulling', label: 'fulfilments' },
  { key: 'invoices', phase: 'Pulling', label: 'invoices' },
  { key: 'tracking', phase: 'Pulling', label: 'tracking' },
  { key: 'ocLinks', phase: 'Pulling', label: 'OC links' },
  { key: 'purchaseOrders', phase: 'Pulling', label: 'purchase orders' },
  { key: 'orderConfirmations', phase: 'Pulling', label: 'order confs' },
  // Then one transaction, in its real order.
  { key: 'saveOrders', phase: 'Saving', label: 'orders' },
  { key: 'saveFulfillments', phase: 'Saving', label: 'fulfilments' },
  { key: 'saveInvoices', phase: 'Saving', label: 'invoices' },
  { key: 'stamps', phase: 'Saving', label: 'gates & custody' },
  { key: 'reconcile', phase: 'Saving', label: 'shipments' },
  { key: 'savePos', phase: 'Saving', label: 'purchase orders' },
  { key: 'saveOcs', phase: 'Saving', label: 'order confs' },
  { key: 'events', phase: 'Saving', label: 'the ledger' },
  // Two follow-on syncs outside the transaction.
  { key: 'fulfillmentDc', phase: 'Finishing', label: 'fulfilment DCs' },
  { key: 'cartons', phase: 'Finishing', label: 'EDI cartons' },
]

export const REFRESH_STEP_TOTAL = REFRESH_STEPS.length

// Resolve a step key into what the button should show. `done` is the number of
// steps CONFIRMED FINISHED — the ones before this one — because the step named
// here is the one still in flight. A bar that filled to include the running step
// would be claiming work that has not come back yet.
//
// An unknown key returns null rather than guessing a position: better for the
// bar to hold still than to report a percentage from a step that isn't in the
// plan the total was computed from.
export function refreshProgress(key) {
  const index = REFRESH_STEPS.findIndex((s) => s.key === key)
  if (index < 0) return null
  return {
    key,
    label: REFRESH_STEPS[index].label,
    phase: REFRESH_STEPS[index].phase,
    done: index,
    total: REFRESH_STEP_TOTAL,
    percent: Math.round((index / REFRESH_STEP_TOTAL) * 100),
  }
}
