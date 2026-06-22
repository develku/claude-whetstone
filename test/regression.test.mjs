import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restoreTarget } from '../src/regression.mjs'

// keep-best: when the latest pass (state.current_score) scored LOWER than the best so
// far, the loop should restore the best snapshot before the next edit, so a bad edit
// can't poison the chain. restoreTarget(state) -> the snapshot path, or null.

const stateWith = (over) => ({
  regression_policy: 'keep-best',
  current_score: 70, // the latest pass's score
  best_score: 90,
  best_pass: 1,
  history: [
    { pass: 0, score: 50, snapshot: 'snapshots/iter_000.mjs' },
    { pass: 1, score: 90, snapshot: 'snapshots/iter_001.mjs' },
    { pass: 2, score: 70, snapshot: 'snapshots/iter_002.mjs' },
  ],
  ...over,
})

test('returns the best snapshot when the latest pass regressed', () => {
  assert.equal(restoreTarget(stateWith({})), 'snapshots/iter_001.mjs')
})

test('returns null when the latest pass did not regress (current == best)', () => {
  assert.equal(restoreTarget(stateWith({ current_score: 90 })), null)
})

test('returns null under the keep-latest policy (never restore)', () => {
  assert.equal(restoreTarget(stateWith({ regression_policy: 'keep-latest' })), null)
})

test('returns null when there is no history', () => {
  assert.equal(restoreTarget(stateWith({ history: [], best_pass: null, current_score: null })), null)
})
