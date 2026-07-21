// scripts/plan-route-demo.js — PROTOTYPE (Nima, 2026-07-21): pull the real
// current work, apply the deadline rules, and print the route the planner
// produces, so we can sanity-check the ORDERING LOGIC before building any UI.
// Simulates a 9:00 AM start so we see an ideal morning plan.
// Run: node --env-file=.env.local scripts/plan-route-demo.js

import { getQuestTasks, getEdiReview, getOrders } from '../server/queries.js'
import { computeEdiWork } from '../src/model/ediWork.js'
import { channelKey } from '../src/model/channels.js'
import { computeRoute, DEFAULT_DURATIONS_MIN } from '../src/model/routePlan.js'

const START = new Date(); START.setHours(9, 0, 0, 0)
const NOW = START.getTime()
const at = (h) => { const d = new Date(START); d.setHours(h, 0, 0, 0); return d.getTime() }
const NOON = at(12), THREE = at(15)
const dur = (k) => DEFAULT_DURATIONS_MIN[k] ?? DEFAULT_DURATIONS_MIN.default
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function taskKind(t) {
  const k = (t.recurringKey || '') + ' ' + (t.subject || '')
  if (/weaver/i.test(k)) return 'weaver_sync'
  if (/csv|upload/i.test(k)) return 'csv_upload'
  if (String(t.instanceKey || '').startsWith('edi:')) return 'edi_route'
  return 'email_reply'
}

const items = []

// 1) open quest_tasks — urgent → 3pm cutoff; recurring/others → fill (no hard deadline)
const tasks = await getQuestTasks()
for (const t of tasks.filter((t) => t.status === 'open')) {
  const kind = taskKind(t)
  items.push({
    id: 'task-' + t.id, label: (t.subject || 'task').slice(0, 42), kind,
    deadline: t.urgency === 'hi' ? THREE : null,
    durationMin: dur(kind), priority: t.urgency === 'hi' ? 0 : t.urgency === 'mid' ? 2 : 4,
  })
}

// 2) open EDI orders — Nordstrom routing must go out by noon; cancel-danger by its date
const edi = computeEdiWork((await getEdiReview()).orders || [], [])
for (const o of edi.orders.filter((o) => !o.work.closed).slice(0, 40)) {
  const partner = (o.tradingPartner || '').toLowerCase()
  let deadline = null, priority = 3
  if (partner.includes('nordstrom') && o.stageRank < 3) { deadline = NOON; priority = 1 }
  else if (o.work.cancelState === 'passed') { deadline = NOW; priority = 0 }
  else if (o.work.cancelState === 'soon') { deadline = THREE; priority = 1 }
  else continue // no hard deadline today → skip from the day route
  items.push({ id: 'edi-' + o.businessNumber, label: `EDI route ${o.tradingPartner} · PO ${o.businessNumber}`.slice(0, 46), kind: 'edi_route', deadline, durationMin: dur('edi_route'), priority })
}

// 3) boutique orders in hand needing an invoice → by noon (invoice→payment→ship chain);
//    anything already past its ship date is urgent (treat like a 3pm ship push)
const orders = await getOrders()
for (const o of orders) {
  const ch = channelKey(o)
  const needsInvoice = o.stage && !['SHIPPED', 'INVOICED', 'APPROVED_FOR_SHIPPING'].includes(o.stage)
  if (ch === 'boutique' && needsInvoice && o.severity > 0) {
    items.push({ id: 'inv-' + o.soNumber, label: `Invoice ${o.customer} · ${o.soNumber}`.slice(0, 46), kind: 'invoice', deadline: NOON, durationMin: dur('invoice'), priority: 2 })
  }
}

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
