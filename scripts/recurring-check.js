// scripts/recurring-check.js — for local/manual testing of the same logic
// the deployed app runs on a schedule via POST /api/internal/recurring-check
// (triggered by .github/workflows/recurring-check.yml, not a Render Cron Job
// — Render's Cron Jobs have no free tier). Pulls fresh Gmail messages, checks
// reply-needed tasks for a sent reply, and creates any due recurring task
// instances (the 9am/2pm Airtable reminder, the daily CSV-freshness check).
//
// Safe to run as often as you like — everything it touches is idempotent
// (natural-key upserts / ON CONFLICT DO NOTHING on instance_key).
//
// Run: node --env-file=.env.local scripts/recurring-check.js

import { syncQuestEmails, ensureRecurringTasks } from '../server/queries.js'

// Independent concerns, in a try/catch each — a Gmail hiccup (expired token,
// API outage) shouldn't stop the 9am/2pm reminder or CSV-monitor from firing.
try {
  const emailResult = await syncQuestEmails()
  console.log(
    `Gmail: ${emailResult.fetched} scanned, ${emailResult.upserted} new/updated` +
    (emailResult.autoClosed ? `, ${emailResult.autoClosed} reply-needed task(s) auto-closed` : ''),
  )
} catch (e) {
  console.error('Gmail sync failed (recurring tasks will still be checked):', e.message)
}

const created = await ensureRecurringTasks()
console.log(`Recurring: ${created} new task instance(s) created.`)

process.exit(0)
