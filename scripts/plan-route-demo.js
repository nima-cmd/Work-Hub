// scripts/plan-route-demo.js — print the route the planner produces for the real
// current work, so the ORDERING LOGIC can be sanity-checked from a terminal.
// Simulates a 9:00 AM start so we see an ideal morning plan.
// Run: node --env-file=.env.local scripts/plan-route-demo.js
//
// ⚠️ It no longer re-implements the item builder. It used to keep its own copies
// of taskKind() and the leg rules "in sync with src/model/routeItems.js" — and by
// 2026-08-04 they had silently diverged: routeItems had split the boutique bench
// into chase / mark-packed / label legs and dropped the severity gate, while this
// file still emitted the old "Invoice <customer>" leg for every picked order (all
// 14 of which were undoable). A comment claiming two files are kept in sync is not
// a mechanism that keeps them in sync. Now it calls buildRouteItems directly, so
// the demo cannot disagree with the app.
import { getQuestTasks, getEdiReview, getOrders, getLabelGaps } from '../server/queries.js'
import { computeEdiWork } from '../src/model/ediWork.js'
import { computeRoute } from '../src/model/routePlan.js'
import { buildRouteItems } from '../src/model/routeItems.js'

const START = new Date(); START.setHours(9, 0, 0, 0)
const NOW = START.getTime()
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const [tasks, edi, orders, labelGaps] = await Promise.all([
  getQuestTasks(), getEdiReview(), getOrders(), getLabelGaps({}),
])
const ediWork = computeEdiWork(edi.orders || [], edi.resolutions || [])
const items = buildRouteItems(orders, tasks, ediWork, { now: NOW, labelGaps })

// keep the demo readable — cap the fill (no-deadline) items
const withDl = items.filter((i) => i.deadline != null)
const fill = items.filter((i) => i.deadline == null).slice(0, 6)
const set = [...withDl, ...fill]

const { route, summary } = computeRoute(set, { now: NOW, dayStartHour: 9 })

console.log(`\n  HYPERSPACE ROUTE — ${route.length} waypoints · simulated 09:00 start\n`)
console.log('  seq  start  end    slack   item')
console.log('  ' + '─'.repeat(70))
for (const r of route) {
  const slack = r.slackMin == null ? '   —  ' : (r.slackMin >= 0 ? `+${r.slackMin}m`.padStart(5) : `${r.slackMin}m`.padStart(5))
  const flag = r.atRisk ? '  ⚠ MISSES CUTOFF' : ''
  console.log(`  ${String(r.seq).padStart(2)}   ${hhmm(r.start)}  ${hhmm(r.end)}  ${slack}   ${r.label}${flag}`)
}
console.log('  ' + '─'.repeat(70))
console.log(`  finishes ${hhmm(summary.finishesAt)} · ${summary.totalMin}m of work · ${summary.atRisk} at risk` +
  (summary.maxLatenessMin ? ` · worst lateness ${summary.maxLatenessMin}m` : ''))
console.log('')
process.exit(0)
