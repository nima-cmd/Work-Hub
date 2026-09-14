#!/usr/bin/env node
// scripts/rekey-shipment-partners.js — re-file routing shipments whose stored partner
// no longer agrees with what partnerForDc() says.
//
// ⚠️ WHY THIS EXISTS, AND IT IS NOT A TIDY-UP. `routing_shipment.dc_po_key` is
// `partner|dc|POs`, so the PARTNER NAME IS PART OF THE IDENTITY of a shipment — and
// the partner is DERIVED from the DC code, not stored by a person. The moment
// partnerForDc() is corrected, every shipment it reclassifies is orphaned: the live
// routing feed builds the new key, finds no row, and offers "Assign BOL" on freight
// that already has one.
//
// That is exactly what happened on 2026-09-14. Exemplar's DCs are numeric, the old
// `if (/^\d+$/) return 'Nordstrom'` claimed all of them, and PO 8928906 to DC 0510 was
// filed as `Nordstrom|0510|8928906` holding BOL NB1731288. Fixing the partner left
// that row detached and the card one click from minting a SECOND BOL for the same
// freight — against the one guarantee in this app that must never break (CLAUDE.md:
// BOL numbers must never be reused, and by extension one shipment gets one number).
//
// ⚠️ IT REFUSES TO MERGE. If the target key already exists, two rows claim the same
// freight and one holds a BOL the other does not; picking a winner here would silently
// discard a minted BOL number. It reports the collision and changes nothing.
//
// ⚠️ DRY BY DEFAULT. `--write` applies.
//
//   node --env-file=.env.local scripts/rekey-shipment-partners.js
//   node --env-file=.env.local scripts/rekey-shipment-partners.js --write

import { pool } from '../src/db.js'
import { partnerForDc } from '../src/model/dc.js'

const write = process.argv.includes('--write')

const { rows } = await pool.query(
  'SELECT id, dc_po_key, partner, dc, member_pos, bol_number, status, shipped_at FROM routing_shipment')

const existing = new Set(rows.map((r) => r.dc_po_key))
const moves = []
const collisions = []

for (const r of rows) {
  const should = partnerForDc(r.dc)
  if (should === r.partner) continue
  // Rebuilt the same way server/queries.js builds it, or the new key would not be the
  // one the live feed looks up — which is the whole failure this repairs.
  const newKey = `${should}|${r.dc}|${(r.member_pos || []).join(',')}`
  if (newKey === r.dc_po_key) continue
  if (existing.has(newKey)) { collisions.push({ ...r, newKey, should }); continue }
  moves.push({ ...r, newKey, should })
}

if (!moves.length && !collisions.length) {
  console.log('✓ Every routing shipment already agrees with partnerForDc(). Nothing to re-file.')
  await pool.end(); process.exit(0)
}

for (const m of moves) {
  console.log(`${m.dc_po_key}\n  → ${m.newKey}`)
  console.log(`  partner ${m.partner} → ${m.should} · DC ${m.dc} · PO ${(m.member_pos || []).join(', ')}`)
  console.log(`  BOL ${m.bol_number || '(none yet)'} · ${m.status}${m.shipped_at ? ' · SHIPPED' : ''}`)
}

for (const c of collisions) {
  console.error(`⛔ ${c.dc_po_key} should be ${c.newKey}, but that key already exists.`)
  console.error('   Two rows claim the same freight. Resolve by hand — this script will not')
  console.error(`   choose between them, because one may hold a minted BOL (${c.bol_number || 'none'}) the other does not.`)
}

if (!write) {
  console.log(`\n${moves.length} shipment${moves.length === 1 ? '' : 's'} to re-file, ${collisions.length} collision${collisions.length === 1 ? '' : 's'}. DRY RUN — pass --write to apply.`)
  await pool.end(); process.exit(collisions.length ? 1 : 0)
}

let done = 0
for (const m of moves) {
  const { rowCount } = await pool.query(
    'UPDATE routing_shipment SET dc_po_key = $1, partner = $2 WHERE id = $3 AND dc_po_key = $4',
    [m.newKey, m.should, m.id, m.dc_po_key])
  done += rowCount
  // ⚠️ The ticks move with the shipment. preship_check is keyed on dc_po_key too, so
  // leaving them behind would silently un-verify a checklist someone had worked through.
  //
  // ⚠️ AND TICKS CAN ALREADY EXIST AT THE NEW KEY. The routing card builds the CURRENT
  // key, so anything ticked since the partner was corrected is filed under the new name
  // while the shipment row still carries the old one — a plain UPDATE then collides on
  // the primary key and aborts the re-file. The newer tick wins, because it is the one
  // someone made against the checklist they were actually looking at.
  const { rowCount: ticks } = await pool.query(
    `UPDATE preship_check p SET dc_po_key = $1 WHERE p.dc_po_key = $2
       AND NOT EXISTS (SELECT 1 FROM preship_check q WHERE q.dc_po_key = $1 AND q.step_key = p.step_key)`,
    [m.newKey, m.dc_po_key])
  const { rowCount: dropped } = await pool.query(
    'DELETE FROM preship_check WHERE dc_po_key = $1', [m.dc_po_key])
  if (ticks) console.log(`  · carried ${ticks} pre-ship tick${ticks === 1 ? '' : 's'}`)
  if (dropped) console.log(`  · ${dropped} older tick${dropped === 1 ? '' : 's'} superseded by one already filed under the new key`)
}

console.log(`\n✓ Re-filed ${done} shipment${done === 1 ? '' : 's'}.`)
if (collisions.length) { console.error(`⛔ ${collisions.length} collision(s) left untouched.`); await pool.end(); process.exit(1) }
await pool.end()
