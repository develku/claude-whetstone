import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReport } from '../src/summary.mjs'

// formatReport(state) composes the run summary (summarizeRun) and the score trajectory
// (formatTrajectory) into one multi-line report block.

const state = {
  status: 'done',
  best_score: 100,
  best_pass: 2,
  hard_cap: 10,
  spent_usd: 0.5,
  escalated: false,
  escalated_at_pass: null,
  history: [{ pass: 0, score: 50 }, { pass: 1, score: 75 }, { pass: 2, score: 100 }],
}

test('formatReport includes the summary line', () => {
  assert.match(formatReport(state), /DONE — best 100 @ pass 2/)
})

test('formatReport includes the trajectory line', () => {
  assert.match(formatReport(state), /#0=50 #1=75 #2=100/)
})

test('formatReport is multi-line (summary + trajectory)', () => {
  assert.ok(formatReport(state).split('\n').length >= 3)
})
