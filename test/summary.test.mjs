import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, thinScorerWarning } from '../src/summary.mjs'

// summarizeRun(state) renders a human-readable run summary. Exact format:
//   line 1: '<STATUS> — best <best_score> @ pass <best_pass>'
//   line 2: '<n> passes / cap <hard_cap> · spent <spent_tokens> tokens ($<spent_usd to 4 decimals>)'
//   (token-primary: tokens lead, notional USD trails in parens — the subscription rate-limit currency wins)
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
  assert.equal(summarizeRun(base), 'DONE — best 100 @ pass 2\n3 passes / cap 10 · spent 1,234 tokens ($0.5000)')
})

test('adds an escalation line when the run escalated', () => {
  assert.equal(
    summarizeRun({ ...base, escalated: true, escalated_at_pass: 1 }),
    'DONE — best 100 @ pass 2\n3 passes / cap 10 · spent 1,234 tokens ($0.5000)\nescalated at pass 1',
  )
})

test('renders 0 tokens for a pre-feature state that has no spent_tokens', () => {
  const { spent_tokens, ...old } = base
  assert.match(summarizeRun(old), /spent 0 tokens/)
})

test('omits the escalation line when the run did not escalate', () => {
  assert.doesNotMatch(summarizeRun(base), /escalated/)
})

test('names each ladder rung when the run escalated more than once (v1.6.0 ladder)', () => {
  assert.equal(
    summarizeRun({
      ...base,
      escalated: true,
      escalated_at_pass: 6,
      escalations: [{ pass: 3, rung: 1 }, { pass: 6, rung: 2 }],
      escalate_models: ['opus', 'fable'],
    }),
    'DONE — best 100 @ pass 2\n3 passes / cap 10 · spent 1,234 tokens ($0.5000)\nescalated at pass 3 → opus, pass 6 → fable',
  )
})

// --- thinScorerWarning: the "converged too easily" thin-scorer suspicion signal ---------------------
// An UNWIRED run (no --confirm-scorer, no --stability-runs) that reaches done in <=1 edit pass is the
// autoresearch eval-evolution signal: evidence the SCORER is thin, not that the artifact is good. The
// warning is code-owned fixed prose + numbers only (capture-clean), and stays quiet when the done-edge
// already paid skepticism (confirm/stability wired) or when convergence took real work (>=2 edits).

const doneBase = {
  status: 'done',
  best_score: 97,
  best_pass: 1,
  hard_cap: 10,
  spent_usd: 0.1,
  spent_tokens: 100,
  escalated: false,
  escalated_at_pass: null,
  target_score: 90,
  current_score: 97,
  history: [{ pass: 0 }, { pass: 1 }], // baseline + ONE edit pass
}

test('thinScorerWarning fires on a 1-edit done with no done-edge check wired, carrying the margin', () => {
  assert.equal(
    thinScorerWarning(doneBase),
    '⚠ thin-scorer suspicion: done in 1 edit pass, margin +7, no done-edge check wired. Consider --confirm-scorer or --stability-runs.',
  )
})

test('thinScorerWarning fires on a baseline done (0 edits) with the stronger message', () => {
  const s = { ...doneBase, history: [{ pass: 0 }], current_score: 95, best_pass: 0 }
  assert.equal(
    thinScorerWarning(s),
    '⚠ done at baseline — 0 edits; the scorer may not discriminate (or the goal was already met). Consider --confirm-scorer or --stability-runs.',
  )
})

test('thinScorerWarning is silent when a confirm scorer is wired (skepticism already paid)', () => {
  assert.equal(thinScorerWarning({ ...doneBase, confirm_scorer_cmd: 'node confirm.mjs' }), null)
})

test('thinScorerWarning is silent when stability probing is wired', () => {
  assert.equal(thinScorerWarning({ ...doneBase, stability_runs: 3 }), null)
})

test('thinScorerWarning is silent when done took two or more edit passes', () => {
  assert.equal(thinScorerWarning({ ...doneBase, history: [{ pass: 0 }, { pass: 1 }, { pass: 2 }] }), null)
})

test('thinScorerWarning is silent on every non-done status', () => {
  for (const status of ['running', 'capped', 'plateau', 'error']) {
    assert.equal(thinScorerWarning({ ...doneBase, status }), null)
  }
})

test('summarizeRun appends the thin-scorer warning line when it fires', () => {
  assert.equal(
    summarizeRun(doneBase),
    'DONE — best 97 @ pass 1\n2 passes / cap 10 · spent 100 tokens ($0.1000)\n⚠ thin-scorer suspicion: done in 1 edit pass, margin +7, no done-edge check wired. Consider --confirm-scorer or --stability-runs.',
  )
})

test('summarizeRun output is unchanged when the warning does not fire', () => {
  assert.doesNotMatch(summarizeRun(base), /thin-scorer|⚠/) // base: 2 edit passes -> silent
})
