// test/poLineReconcile.test.js — built on the real PO 0008928906 / IF7650 pair.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcile, priceReconciliation, pairSubstitutions, editDistance, lineKey, UPC_AUTHORITY,
} from '../src/model/poLineReconcile.js'

// PO 0008928906, 22 lines / 270 units (the Exemplar PO download of 2026-09-02).
const ORDERED = [
  ['SN03014LD', 'ONYX', 8], ['SN03013LD', 'CASHMERE', 20], ['SN03012LD', 'ONYX', 20],
  ['SN03013LD', 'ONYX', 20], ['SN03013LD', 'CHOCOLATE', 20], ['SN41263LD', 'CHOCOLATE', 10],
  ['SN11054LD', 'CASHMERE', 12], ['SN26173LD', 'CHOCOLATE', 10], ['SN41262LD', 'BORDEAUX', 8],
  ['SN41263LD', 'ONYX', 10], ['SN03011VB', 'CASHMERE', 10], ['SN37043NG', 'CHOCOLATE', 10],
  ['SN41263LD', 'CASHMERE', 10], ['SN03013LD', 'BORDEAUX', 12], ['SN03014LD', 'CHOCOLATE', 8],
  ['SN11054LD', 'CHOCOLATE', 16], ['SN37043NG', 'FLOR', 12], ['SN03012LD', 'MOCHA', 12],
  ['SN04023LD', 'CHOCOLATE', 12], ['SN26173LD', 'BORDEAUX', 10], ['SN37043VB', 'CASHMERE', 10],
  ['SN03011LD', 'MOCHA', 10],
].map(([style, colour, qty], i) => ({ line: i + 1, style, colour, qty }))

// IF7650's 22 cartons, in their REAL carton order (NetSuite, 2026-09-11). Written
// out rather than derived from ORDERED: the carton sequence is not the PO line
// sequence, and a fixture that claims to be the real pair has to be it — carton 20
// is the one holding the wrong bag, not carton 6.
const PACKED = [
  ['SN03011LD', 'MOCHA', 10], ['SN03011VB', 'CASHMERE', 10], ['SN03012LD', 'MOCHA', 12],
  ['SN03012LD', 'ONYX', 20], ['SN03013LD', 'BORDEAUX', 12], ['SN03013LD', 'CASHMERE', 20],
  ['SN03013LD', 'CHOCOLATE', 20], ['SN03013LD', 'ONYX', 20], ['SN03014LD', 'CHOCOLATE', 8],
  ['SN03014LD', 'ONYX', 8], ['SN04023LD', 'CHOCOLATE', 12], ['SN11054LD', 'CASHMERE', 12],
  ['SN11054LD', 'CHOCOLATE', 16], ['SN26173LD', 'BORDEAUX', 10], ['SN26173LD', 'CHOCOLATE', 10],
  ['SN37043NG', 'CHOCOLATE', 10], ['SN37043NG', 'FLOR', 12], ['SN37043VB', 'CASHMERE', 10],
  ['SN41262LD', 'BORDEAUX', 8],
  ['SN41262LD', 'CHOCOLATE', 10],   // ⚠️ carton 20 — the Porto SMALL, ordered as the MEDIUM
  ['SN41263LD', 'CASHMERE', 10], ['SN41263LD', 'ONYX', 10],
].map(([style, colour, qty], i) => ({ carton: i + 1, style, colour, qty }))

test('⚠️ THE TOTALS AGREE AND THE SHIPMENT IS WRONG', () => {
  // 270 ordered, 270 packed, 22 lines, 22 cartons. Every total reconciles, and one
  // carton holds a different bag. This is the case a unit-count check calls clean.
  const r = reconcile(ORDERED, PACKED)
  assert.equal(r.orderedUnits, 270)
  assert.equal(r.packedUnits, 270)
  assert.equal(r.totalsAgree, true)
  assert.equal(r.clean, false, 'totals agreeing must never be read as clean')
  assert.equal(r.matched.length, 21)
})

test('⚠️ IT IS REPORTED AS A PAIR, BECAUSE EXEMPLAR CHARGES IT AS BOTH', () => {
  const r = reconcile(ORDERED, PACKED)
  assert.equal(r.short.length, 1)
  assert.equal(r.short[0].key, 'SN41263LD-CHOCOLATE')
  assert.equal(r.short[0].delta, -10)
  assert.equal(r.notOrdered.length, 1)
  assert.equal(r.notOrdered[0].key, 'SN41262LD-CHOCOLATE')
  assert.deepEqual(r.notOrdered[0].cartons, [20])
})

test('⚠️ ONE CHARACTER APART IS CALLED OUT, BECAUSE NOBODY HEARS IT', () => {
  // SN41262 vs SN41263 — Porto Small vs Porto Medium, two different bags. The
  // catalogue also contains SN03013LD vs SN13013LD, which are two versions of the
  // SAME bag. Read aloud, neither pair is distinguishable.
  const r = reconcile(ORDERED, PACKED)
  assert.equal(r.substitutions.length, 1)
  const s = r.substitutions[0]
  assert.equal(s.orderedStyle, 'SN41263LD')
  assert.equal(s.packedStyle, 'SN41262LD')
  assert.equal(s.qty, 10)
  assert.equal(s.oneCharacterApart, true)
  assert.equal(editDistance('SN41262LD', 'SN41263LD'), 1)
  // ⚠️ AND SO IS THE OTHER KNOWN TRAP PAIR. I asserted 2 here and it is 1 —
  // SN03013LD / SN13013LD differ at a single position too. Both of this catalogue's
  // documented confusions are one character, which is why the flag is worth raising
  // at all: it is not a rare coincidence, it is the shape these errors take.
  assert.equal(editDistance('SN03013LD', 'SN13013LD'), 1)
  // Two genuinely different styles are further apart and are not flagged.
  assert.ok(editDistance('SN03011LD', 'SN26173LD') > 1)
})

test('⚠️ A PAIRED SUBSTITUTION IS STILL REPORTED AS A SHORT AND AN OVERAGE', () => {
  // The pairing is a hint, not a conclusion — two separate errors can coincide on
  // quantity. Folding them into a "substitution" bucket would hide a real short ship
  // whenever the guess is wrong, so both lists keep their entries.
  const r = reconcile(ORDERED, PACKED)
  assert.equal(r.short.length, 1)
  assert.equal(r.notOrdered.length, 1)
  assert.equal(r.substitutions[0].likely, true)
  // An unrelated pair of different quantities is NOT paired.
  const noPair = pairSubstitutions([{ style: 'A', delta: -5 }], [{ style: 'B', delta: 3 }])
  assert.equal(noPair.length, 0)
})

test('⚠️ IT COSTS BOTH FEES, AND THE AUDIT PROGRAMME IS THE EXPENSIVE HALF', () => {
  const r = reconcile(ORDERED, PACKED)
  const p = priceReconciliation(r, { banner: 'SFA' })
  // Short shipped $500/incident AND substituted $500/incident — §12.3.
  assert.equal(p.items.length, 2)
  assert.equal(p.estimate, 1000)
  assert.ok(p.items.some((i) => /short shipped/i.test(i.reason)))
  assert.ok(p.items.some((i) => /Substituted/i.test(i.reason)))
  // 10 wrong of 270 is 3.7%, over the 2% trigger.
  assert.equal(p.wrongUnits, 10)
  assert.equal(p.aboveAuditTrigger, true)
  assert.match(p.auditNote, /3\.7% item error rate/)
  assert.match(p.auditNote, /\$1000\/month/)
  // §9.2 — not a fee, and worse than one.
  assert.match(p.receivedNotOrdered, /may keep the units/)
})

test('⚠️ "substituted" IS A SAKS-ONLY CODE, so the banner is carried not assumed', () => {
  const r = reconcile(ORDERED, PACKED)
  const sfa = priceReconciliation(r, { banner: 'SFA' })
  const nmg = priceReconciliation(r, { banner: 'NM' })
  assert.ok(sfa.items.some((i) => /Substituted/i.test(i.reason)))
  assert.ok(!nmg.items.some((i) => /Substituted/i.test(i.reason)))
  assert.ok(nmg.items.some((i) => /over shipped/i.test(i.reason)))
})

test('a shipment that matches the PO is clean and free', () => {
  const r = reconcile(ORDERED, ORDERED.map((o, i) => ({ ...o, carton: i + 1 })))
  assert.equal(r.clean, true)
  assert.equal(r.substitutions.length, 0)
  assert.equal(priceReconciliation(r).estimate, 0)
  assert.equal(priceReconciliation(r).aboveAuditTrigger, false)
})

test('⚠️ RECONCILE ON STYLE + COLOUR, NEVER ON UPC', () => {
  // The PO download carries Exemplar's own UPC and svs numbers in columns beside
  // ours, and theirs look more authoritative. We are approved to ship OUR UPCs, so
  // matching on UPC would report all 22 lines as mismatched.
  assert.equal(UPC_AUTHORITY.useOurs, true)
  assert.equal(UPC_AUTHORITY.reconcileOn, 'style + colour')
  assert.match(UPC_AUTHORITY.theirs, /400270448906/)
  // Case and whitespace do not break the key.
  assert.equal(lineKey(' sn41263ld ', 'chocolate'), 'SN41263LD-CHOCOLATE')
})

test('repeated styles in different colours stay distinct', () => {
  // SN41263LD appears three times on this PO — chocolate, onyx, cashmere. Keying on
  // style alone would collapse them into one 30-unit line and hide the substitution.
  const r = reconcile(ORDERED, PACKED)
  const keys = r.matched.map((m) => m.key)
  assert.ok(keys.includes('SN41263LD-ONYX'))
  assert.ok(keys.includes('SN41263LD-CASHMERE'))
  assert.ok(!keys.includes('SN41263LD-CHOCOLATE'))
})
