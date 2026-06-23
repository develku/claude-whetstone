import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTrajectory } from '../src/trajectory.mjs'

// formatTrajectory(state) renders the score history as a compact one-line summary
// for reports. Exact format (so the loop has an unambiguous target):
//   empty history -> 'no passes yet'
//   otherwise     -> '#<pass>=<score>' for each pass, space-joined,
//                    then ' | best <best_score>@<best_pass> | <status>'

test('empty history reads "no passes yet"', () => {
  assert.equal(formatTrajectory({ history: [], best_score: null, best_pass: null, status: 'running' }), 'no passes yet')
})

test('a single pass renders the pass plus the summary', () => {
  const s = { history: [{ pass: 0, score: 50 }], best_score: 50, best_pass: 0, status: 'running' }
  assert.equal(formatTrajectory(s), '#0=50 | best 50@0 | running')
})

test('multiple passes are space-joined with the best marker and status', () => {
  const s = {
    history: [{ pass: 0, score: 50 }, { pass: 1, score: 75 }, { pass: 2, score: 100 }],
    best_score: 100,
    best_pass: 2,
    status: 'done',
  }
  assert.equal(formatTrajectory(s), '#0=50 #1=75 #2=100 | best 100@2 | done')
})

test('a baseline-error run (no valid score) renders "best —", not a nonsensical "best 0@-1"', () => {
  // when the very first scorer call returns null, Math.max(...[null]) is 0 and indexOf(0) is -1.
  const s = { history: [{ pass: 0, score: null }], best_score: null, best_pass: 0, status: 'error' }
  const out = formatTrajectory(s)
  assert.match(out, /best —/)
  assert.doesNotMatch(out, /best 0@-1/)
})
