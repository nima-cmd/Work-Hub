import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrepped, needsPackNudge, preppedLabel } from '../src/model/prepped.js'

// Nima, 2026-08-05: "were we can't mark as packed like certain boutique we dont want
// to invoice early we need an alternative way to track them." `Packed` in NetSuite
// tells accounting to invoice, so it cannot double as our own done-marker.

test('the nudge fires only while our part is genuinely outstanding', () => {
  // back in our hands, NetSuite still says picked, nothing recorded → ask for it
  assert.equal(needsPackNudge({ backInPossession: true, packedInNetsuite: false }), true)
  // still with the warehouse → not our move yet
  assert.equal(needsPackNudge({ backInPossession: false, packedInNetsuite: false }), false)
  // already packed → done
  assert.equal(needsPackNudge({ backInPossession: true, packedInNetsuite: true }), false)
})

test('recording our part done silences the nudge without packing anything', () => {
  const held = { backInPossession: true, packedInNetsuite: false, preppedAt: '2026-08-05T10:00:00Z' }
  assert.equal(needsPackNudge(held), false)
  // ...and nothing about it claims the order was packed or invoiced — that is the
  // whole point: no accounting side effect.
  assert.equal(isPrepped(held), true)
})

test('the marker is undoable — latest event wins', () => {
  // A mis-click must be reversible; a marker that can only be set is a trap.
  assert.equal(isPrepped({ preppedAt: '2026-08-05T10:00:00Z', prepClearedAt: '2026-08-05T11:00:00Z' }), false)
  // ...and re-prepping after a clear works too
  assert.equal(isPrepped({ preppedAt: '2026-08-05T12:00:00Z', prepClearedAt: '2026-08-05T11:00:00Z' }), true)
  // cleared with nothing ever set is simply not prepped
  assert.equal(isPrepped({ prepClearedAt: '2026-08-05T11:00:00Z' }), false)
  assert.equal(isPrepped({}), false)
})

test('a held fulfilment says WHY when a reason was left', () => {
  const withNote = preppedLabel({
    ifNumber: 'IF7405', note: 'Julian Gold — do not invoice before the 15th',
    preppedAt: '2026-08-05T10:00:00Z',
  })
  assert.match(withNote, /IF7405 prepped/)
  assert.match(withNote, /held from packing on purpose/)
  assert.match(withNote, /do not invoice before the 15th/)
  // no note is fine — it still must not read as an error
  const bare = preppedLabel({ ifNumber: 'IF7405', preppedAt: '2026-08-05T10:00:00Z' })
  assert.match(bare, /held from packing on purpose/)
  assert.doesNotMatch(bare, /undefined|null/)
})

test('being packed in NetSuite still wins outright', () => {
  // If it IS packed, the marker is irrelevant — accounting has already been told,
  // so there is nothing being held back and nothing to nudge.
  assert.equal(needsPackNudge({
    backInPossession: true, packedInNetsuite: true, preppedAt: '2026-08-05T10:00:00Z',
  }), false)
})
