#!/usr/bin/env node
// npm run check:scan-gaps
//
// Nima's workflow (2026-08-06): an Item Fulfillment is scanned OUT as the slip prints
// and handed straight to Nestor; he packs it and hands it back, and it is scanned IN.
// So a fulfilment with NO scan was never handed over — a lost thread, not lateness.
//
// ⚠️ The custody register cannot show this. Its query needs at least one scan to appear
// (`HAVING bool_or(event_type IN ('CUSTODY_OUT','CUSTODY_IN'))`), so it is a list of
// things that ENTERED the register. Nima found four of these by hand; there are 29.
//
// The rule lives in src/model/scanGap.js so it is tested; this only fetches and prints.

import { pool } from '../src/db.js'
import { scanGapFor, summarizeScanGaps, SCAN_GAP } from '../src/model/scanGap.js'

const { rows } = await pool.query(`
  SELECT f.if_number AS "ifNumber", f.if_date AS "ifDate", f.status,
         o.so_number AS "soNumber", o.customer, o.source, o.location,
         sc.out_at AS "outAt", sc.in_at AS "inAt",
         dc.out_at AS "dcOutAt", dc.in_at AS "dcInAt"
  FROM fulfillments f
  JOIN orders o ON o.so_number = f.so_number
  LEFT JOIN (
    SELECT doc_number,
           MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS out_at,
           MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS in_at
    FROM order_events
    WHERE doc_type = 'IF' AND event_type IN ('CUSTODY_OUT', 'CUSTODY_IN')
    GROUP BY doc_number
  ) sc ON sc.doc_number = f.if_number
  -- ⚠️ The EDI lane is scanned on its per-DC cargo tag, not the IF slip. Omitting this
  -- join reported 28 broken threads and ALL 28 were false. See src/model/scanGap.js.
  LEFT JOIN (
    SELECT doc_number,
           MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_OUT') AS out_at,
           MAX(occurred_at) FILTER (WHERE event_type = 'CUSTODY_IN')  AS in_at
    FROM order_events
    WHERE doc_type = 'DC' AND event_type IN ('CUSTODY_OUT', 'CUSTODY_IN')
    GROUP BY doc_number
  ) dc ON dc.doc_number = o.po_number || ':' || COALESCE(o.dc, '')
  WHERE f.actual_ship_date IS NULL
  ORDER BY f.if_date, f.if_number
`)

// ⚠️ FOB stock sits in CHINA awaiting the customer's collection — it never passes
// through our bay, so it can never be scanned and must not be reported as a dropped
// thread. Same exclusion labelGap.js makes for the same reason (12 of 12 China
// fulfilments have never carried a label either).
const inScope = rows.filter((r) => !/china/i.test(r.location || ''))
const skippedFob = rows.length - inScope.length

const results = inScope.map((r) => ({ ...r, verdict: scanGapFor(r) }))
const counts = summarizeScanGaps(results.map((r) => r.verdict))
const pad = (s, n) => String(s ?? '').padEnd(n)

const show = (title, list, note = '') => {
  if (!list.length) return
  console.log(`\n  ${title}${note ? '  — ' + note : ''}`)
  for (const r of list) {
    console.log(`  ${pad(r.ifNumber, 9)} ${pad(String(r.verdict.ageDays) + 'd', 5)} ${pad(r.source, 9)} ${pad((r.customer || '').slice(0, 38), 39)} ${r.verdict.reason}`)
  }
}

const never = results.filter((r) => r.verdict.kind === SCAN_GAP.NEVER_SCANNED)
  .sort((a, b) => b.verdict.ageDays - a.verdict.ageDays)
const outStale = results.filter((r) => r.verdict.kind === SCAN_GAP.OUT_NOT_BACK && r.verdict.stale)
  .sort((a, b) => b.verdict.ageDays - a.verdict.ageDays)

console.log(`\n${inScope.length} unshipped fulfilment(s) in the bay${skippedFob ? ` · ${skippedFob} FOB/China excluded (never passes through us)` : ''}`)

show('NEVER HANDED OVER — made, never scanned out', never,
  'the scan belongs at the printer, so any of these broke the workflow')
show('OVERDUE WITH NESTOR — scanned out, never scanned back', outStale, 'ask for it')

console.log('')
console.log(`  never handed over ....... ${counts.neverScanned}`)
console.log(`  with Nestor ............. ${counts.outNotBack}   (${counts.outStale} overdue)`)
console.log(`  back in our hands ....... ${counts.backWithUs}   (labels + ship desk own these)`)
console.log(`  fine .................... ${counts.ok}`)

const oldest = never[0] || outStale[0]
if (oldest) console.log(`\n  oldest broken thread: ${oldest.ifNumber} · ${oldest.verdict.ageDays}d · ${oldest.customer}`)

console.log(counts.broken
  ? `\n✗ ${counts.broken} broken thread(s): ${counts.neverScanned} never handed over, ${counts.outStale} overdue with Nestor.\n`
  : '\n✓ Every unshipped fulfilment is accounted for in the scan chain.\n')

await pool.end()
process.exit(counts.broken ? 1 : 0)
