// test/containerIdentity.test.js — the filename guess that decides the label.
//
// ⚠️ WHY THIS IS WORTH A TEST FILE OF ITS OWN. The guess feeds containerNum, which
// feeds containerLabel, which is the identity of the stored container AND is embedded
// in every External ID NetSuite will hold. A wrong guess imports cleanly and only
// surfaces later, when post-import verification cannot find the receipt/transfer pair.
// The port already shipped one bug of exactly that shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestContainerFields, containerLabel } from '../src/model/containerIdentity.js'

test('the two real fixture filenames give the bare number and the printed date', () => {
  assert.deepEqual(suggestContainerFields('55-container-2026.9.7.xlsx'), {
    containerNum: '55', containerDate: '2026.9.7',
  })
  // ⚠️ "11 air", NOT "11 Air". The live records read `1 air carton 2026.8.8`, and I
  // had this Title-casing every word — inventing a convention, and making a guess
  // look authoritative enough that nobody would edit it.
  assert.deepEqual(suggestContainerFields('11-air-2026.9.9.xlsx'), {
    containerNum: '11 air', containerDate: '2026.9.9',
  })
})

test('the word "container" is dropped — every one of these is a container', () => {
  // The live labels are "321", "16", "264", "39", "1 air". None says "container".
  assert.equal(suggestContainerFields('55 Container 2026.9.7.xlsx').containerNum, '55')
  assert.equal(suggestContainerFields('321-containers-2026.7.10.csv').containerNum, '321')
})

test('either date separator is read, and leading zeros are stripped', () => {
  // ⚠️ "2026.9.7", not "2026.09.07" — the label NetSuite holds has no padding, so a
  // padded guess would mint a second, near-identical External ID for one container.
  assert.equal(suggestContainerFields('16-2026-07-09.xlsx').containerDate, '2026.7.9')
  assert.equal(suggestContainerFields('16-2026/07/09.xlsx').containerDate, '2026.7.9')
})

test('a filename with no date leaves the date NULL rather than inventing one', () => {
  // ⚠️ Today's date would be a fabricated document date. containerLabel then reads
  // "<num> carton", which is the shape the original emits for a dateless slip.
  const g = suggestContainerFields('1 DHL express.xlsx')
  assert.equal(g.containerDate, null)
  assert.equal(containerLabel({ containerNum: g.containerNum, containerDate: g.containerDate }), '1 DHL express carton')
})

test('the guess composes the label the live records actually carry', () => {
  const g = suggestContainerFields('321-2026.7.10.xlsx')
  const label = containerLabel({ containerNum: g.containerNum, containerDate: g.containerDate })
  assert.equal(label, '321 carton 2026.7.10')
  // Verified against NetSuite 2026-09-09: IR1867 / TO200 on PO1706.
  assert.equal(`EXT-IR-${label}1706`, 'EXT-IR-321 carton 2026.7.101706')
  assert.equal(`EXT-${label}1706`, 'EXT-321 carton 2026.7.101706')
})
