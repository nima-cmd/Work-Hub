// test/containerAlias.test.js — one container, however it is spelled.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structuralKey, displayNameFor, aliasesFor, resolveContainer, ALIAS_SOURCES } from '../src/model/containerAlias.js'

test('⚠️ THE TWO SPELLINGS THAT COST 1,439 UNITS KEY THE SAME', () => {
  // The packing slip says "55 LCL carton 2026.9.7"; the transfer order memo says
  // "55 LCL to LA carton 2026.9.7". An exact compare silently unmatched four TOs.
  assert.equal(structuralKey('55 LCL carton 2026.9.7'), structuralKey('55 LCL to LA carton 2026.9.7'))
})

test('a string that is not container-shaped keys to nothing', () => {
  // "PO1616Transfer" and "for SO11677" are real TO memos and must not key anywhere.
  assert.equal(structuralKey('PO1616Transfer'), null)
  assert.equal(structuralKey('for SO11677'), null)
  assert.equal(structuralKey(''), null)
})

test('⚠️ AN AMBIGUOUS KEY RESOLVES TO NEITHER CONTAINER', () => {
  // Attaching real freight to the wrong container is worse than failing to attach it.
  const r = resolveContainer('55 x carton 2026.9.7', { labels: ['55 a carton 2026.9.7', '55 b carton 2026.9.7'] })
  assert.equal(r.label, null)
  assert.equal(r.how, 'ambiguous')
  assert.equal(r.candidates.length, 2)
})

test('⚠️ A RECORDED ALIAS BEATS A DERIVED MATCH, and says which it was', () => {
  // A structural match is a hypothesis; an alias row is a fact someone can correct. The
  // caller needs to know which it got so it can write the hypothesis down.
  const aliases = new Map([['55 LCL to LA carton 2026.9.7', '55 LCL carton 2026.9.7']])
  assert.equal(resolveContainer('55 LCL to LA carton 2026.9.7', { aliases }).how, 'alias')
  assert.equal(resolveContainer('55 other carton 2026.9.7', { labels: ['55 LCL carton 2026.9.7'] }).how, 'structure')
})

test('the display name is readable, and the ugly key stays the key', () => {
  // The 59-carton container's identity contains "(1)" from a duplicate download.
  assert.equal(displayNameFor('59 cartons LCL to LA INVOICE&PL (1) carton 2026.8.17'), '59 cartons · 17 Aug 2026')
  assert.equal(displayNameFor('11 Air 1820 1777 air list carton 2026.9.7'), '11 cartons by air · 7 Sep 2026')
  assert.equal(displayNameFor('1 air carton 2026.8.8'), '1 carton by air · 8 Aug 2026')
})

test('⚠️ AN ENTERED NAME IS NEVER RECOMPUTED', () => {
  assert.equal(displayNameFor('55 LCL carton 2026.9.7', 'The Teak container'), 'The Teak container')
  assert.equal(displayNameFor('55 LCL carton 2026.9.7', '   '), '55 cartons · 7 Sep 2026', 'blank is not a name')
})

test('an unparseable label still gets a name — its own', () => {
  assert.equal(displayNameFor('mystery box'), 'mystery box')
  assert.equal(displayNameFor(''), null)
})

test('⚠️ EVERY ALIAS CARRIES WHERE IT CAME FROM', () => {
  // Two aliases can disagree, and which to trust is a question about origin.
  const a = aliasesFor({
    label: '55 LCL carton 2026.9.7',
    filename: '55 Container 2026.9.7  LCL to LA .xlsx',
    memos: ['55 LCL to LA carton 2026.9.7', '55 LCL to LA carton 2026.9.7'],
    forwarderRef: 'SI0067968',
  })
  assert.equal(a.length, 4, 'the duplicate memo is not stored twice')
  assert.deepEqual(a.map((x) => x.source), ['slip', 'filename', 'memo', 'forwarder'])
  for (const x of a) assert.ok(ALIAS_SOURCES[x.source], `${x.source} must be a known source`)
})

test('blank names are not aliases', () => {
  assert.equal(aliasesFor({ label: 'A', filename: '', memos: [null, '  '] }).length, 1)
})
