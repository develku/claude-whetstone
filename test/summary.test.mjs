import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun } from '../src/summary.mjs'

// summarizeRun(state) renders a human-readable run summary. Exact format:
//   line 1: '<STATUS> — best <best_score> @ pass <best_pass>'
//   line 2: '<n> passes / cap <hard_cap> · spent $<spent_usd to 4 decimals> · <spent_tokens> tokens'
//   line 3 (only when escalated): 'escalated at pass <escalated_at_pass>'

const base = {
  status: 'done',
  best_score: 100,
  best_pass: 2,
  hard_cap: 10,
  spent_usd: 0.5,
  spent_tokens: 1234,
  escalated: false,
  escalated_at_pass: null,
  history: [{ pass: 0 }, { pass: 1 }, { pass: 2 }],
}

test('summarizes a finished run in two lines, reporting both spend dials', () => {
  assert.equal(summarizeRun(base), 'DONE — best 100 @ pass 2\n3 passes / cap 10 · spent $0.5000 · 1234 tokens')
})

test('adds an escalation line when the run escalated', () => {
  assert.equal(
    summarizeRun({ ...base, escalated: true, escalated_at_pass: 1 }),
    'DONE — best 100 @ pass 2\n3 passes / cap 10 · spent $0.5000 · 1234 tokens\nescalated at pass 1',
  )
})

test('renders 0 tokens for a pre-feature state that has no spent_tokens', () => {
  const { spent_tokens, ...old } = base
  assert.match(summarizeRun(old), /· 0 tokens/)
})

test('omits the escalation line when the run did not escalate', () => {
  assert.doesNotMatch(summarizeRun(base), /escalated/)
})
