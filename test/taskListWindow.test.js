import test from 'node:test'
import assert from 'node:assert/strict'
import { taskListMeta, DEFAULT_DONE_WINDOW_DAYS } from '../src/model/taskListWindow.js'

// The whole point of this module: a windowed array must never be the source of a
// total. Tasks.jsx computed `doneCount = tasks.length - openCount` and called it
// "done" — trim the list and it says 116 while still labelled done.

test('the done total comes from the TABLE, never from the returned array', () => {
  const m = taskListMeta({ doneTotal: 739, openTotal: 11, returned: 127, windowDays: 7 })
  assert.equal(m.doneTotal, 739, 'the truth about the table')
  assert.equal(m.returned, 127, 'and separately, what the array holds')
  assert.notEqual(m.doneTotal, m.returned - m.openTotal, 'the subtraction that was wrong')
})

test('windowed says so out loud, and names what is missing', () => {
  const m = taskListMeta({ doneTotal: 739, openTotal: 11, returned: 127, windowDays: 7 })
  assert.equal(m.windowed, true)
  assert.equal(m.withheld, 623)
  assert.match(m.moreLabel, /Show all 750/)
  assert.match(m.moreLabel, /623 older completed not loaded/)
})

test('nothing withheld → NOT windowed, and no button', () => {
  // A button offering to load 0 more rows is a lie about there being more.
  const m = taskListMeta({ doneTotal: 739, openTotal: 11, returned: 750, windowDays: 7 })
  assert.equal(m.windowed, false)
  assert.equal(m.withheld, 0)
  assert.equal(m.moreLabel, null)
  assert.equal(m.windowDays, null, 'a window that withheld nothing was not a window')
})

test('the all=true case reports no window at all', () => {
  const m = taskListMeta({ doneTotal: 739, openTotal: 11, returned: 750, windowDays: null })
  assert.equal(m.windowed, false)
  assert.equal(m.moreLabel, null)
})

test('an empty board is not "windowed"', () => {
  const m = taskListMeta({ doneTotal: 0, openTotal: 0, returned: 0, windowDays: 7 })
  assert.equal(m.windowed, false)
  assert.equal(m.moreLabel, null)
})

test('string counts from a SQL COUNT are coerced, not concatenated', () => {
  // pg returns bigint as a STRING. '739' + '11' would be '73911'.
  const m = taskListMeta({ doneTotal: '739', openTotal: '11', returned: 127, windowDays: 7 })
  assert.equal(m.withheld, 623)
  assert.match(m.moreLabel, /Show all 750/)
})

test('the default window is 7 days', () => {
  assert.equal(DEFAULT_DONE_WINDOW_DAYS, 7)
})
