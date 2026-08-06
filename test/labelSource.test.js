// Where labels are made. One switch, and it must fail CLOSED.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pushingAllowed, LABEL_SOURCE, PUSH_DISABLED_REASON } from '../src/model/labelSource.js'

test('labels are made in NetSuite right now', () => {
  assert.equal(LABEL_SOURCE, 'netsuite')
  assert.equal(pushingAllowed(), false)
})

test('it fails CLOSED — only an explicit force or a flipped source opens it', () => {
  // A truthy-but-not-true value must not sneak past; the whole point is that pushing
  // creates a second live label on a box that already has one.
  for (const bad of [undefined, null, 0, '', 'yes', 1, {}]) {
    assert.equal(pushingAllowed({ force: bad }), false, JSON.stringify(bad))
  }
  assert.equal(pushingAllowed({ force: true }), true)
  assert.equal(pushingAllowed({ source: 'shipstation' }), true)
})

test('the reason names the file to read and the actual hazard', () => {
  // A block whose message does not say why becomes a mystery in three weeks.
  assert.match(PUSH_DISABLED_REASON, /labelSource\.js/)
  assert.match(PUSH_DISABLED_REASON, /second live label/)
  assert.match(PUSH_DISABLED_REASON, /force/)
})
