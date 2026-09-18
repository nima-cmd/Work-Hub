// test/vendorName.test.js — short factory names for a narrow column.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorShort } from '../src/model/vendorName.js'

test('the two factories get the names Nima uses', () => {
  assert.equal(vendorShort('Guangzhou Fantasy Leather Factory (Chelly)').short, 'Chelly')
  assert.equal(vendorShort('Hong Kong Milestone LTD').short, 'Shoe factory')
})

test('the full name is kept, for the tooltip', () => {
  const v = vendorShort('Guangzhou Fantasy Leather Factory (Chelly)')
  assert.equal(v.full, 'Guangzhou Fantasy Leather Factory (Chelly)')
  assert.equal(v.abbreviated, true)
})

test('⚠️ an unknown vendor keeps its FULL name rather than being truncated', () => {
  // Truncating would give "Guangzhou Fa" for two different Guangzhou factories. A long
  // name is a visible prompt to add it to the list; a wrong short one is a mislabel.
  const v = vendorShort('Elite Jewelry Factory Limited')
  assert.equal(v.short, 'Elite Jewelry Factory Limited')
  assert.equal(v.abbreviated, false)
})

test('no vendor is null, not an empty abbreviation', () => {
  assert.equal(vendorShort(null).short, null)
  assert.equal(vendorShort('').short, null)
})
