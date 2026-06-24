import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareResume } from '../src/resume.mjs'
import { initState, recordPass } from '../src/state.mjs'

// prepareResume(loadedState, overrides) is the PURE half of --resume: it applies the
// explicitly-provided overrides (cap/budget/target/model) onto a loaded state, resets
// the run-control fields (status running, editor ladder cleared), and re-uses the GATE
// as the single source of truth for "can this run actually make progress?". It returns
// { state } when resumable or { error } (with an actionable hint) when not — so a capped
// run cannot be resumed straight back into an instant re-cap.

const buildState = ({ scores, ...over }) => {
  let s = initState({ goal: 'g', artifactPath: 'a.txt', scorerCmd: 's', targetScore: 90, hardCap: 10, ...over })
  for (const score of scores) s = recordPass(s, { score, snapshot: `iter_${s.history.length}.txt` })
  return s
}

test('applies a higher cap and returns a runnable resumed state', () => {
  const s = { ...buildState({ scores: [40, 75], hardCap: 1 }), status: 'capped' } // pass 1, capped
  const { state, error } = prepareResume(s, { hard_cap: 4 })
  assert.equal(error, undefined)
  assert.equal(state.hard_cap, 4)
  assert.equal(state.status, 'running')
  assert.equal(state.status_reason, null)
})

test('refuses when the new cap is still at or below the current pass', () => {
  const s = { ...buildState({ scores: [40, 75], hardCap: 1 }), status: 'capped' }
  const { state, error } = prepareResume(s, { hard_cap: 1 })
  assert.equal(state, undefined)
  assert.match(error, /cap/i)
})

test('refuses to resume a run that already reached the target', () => {
  const s = { ...buildState({ scores: [40, 95], hardCap: 1 }), status: 'capped' }
  const { error } = prepareResume(s, { hard_cap: 5 })
  assert.match(error, /target/i)
})

test('refuses when resuming would immediately plateau', () => {
  const s = {
    ...buildState({ scores: [50, 50, 50, 50, 50], hardCap: 4, plateauWindow: 3, minDelta: 1 }),
    status: 'plateau',
  }
  const { error } = prepareResume(s, { hard_cap: 10 })
  assert.match(error, /plateau/i)
})

test('restarts the editor ladder by clearing escalation state', () => {
  const s = { ...buildState({ scores: [40, 75], hardCap: 1 }), status: 'capped', escalated: true, escalated_at_pass: 1 }
  const { state } = prepareResume(s, { hard_cap: 5 })
  assert.equal(state.escalated, false)
  assert.equal(state.escalated_at_pass, null)
})

test('refuses to resume a budget-exhausted run when the budget is not raised', () => {
  // The budget cap lives in the LOOP, not the gate — so prepareResume must guard it
  // explicitly, or resume would spend one paid act() pass before re-capping on budget.
  let s = { ...buildState({ scores: [40, 60], hardCap: 10, budgetUsd: 1.0 }), status: 'capped' }
  s = { ...s, spent_usd: 1.1 } // already over budget
  const { state, error } = prepareResume(s, {}) // no --budget raise
  assert.equal(state, undefined)
  assert.match(error, /budget/i)
})

test('resumes a budget-exhausted run once the budget is raised', () => {
  let s = { ...buildState({ scores: [40, 60], hardCap: 10, budgetUsd: 1.0 }), status: 'capped' }
  s = { ...s, spent_usd: 1.1 }
  const { state, error } = prepareResume(s, { budget_usd: 5.0 })
  assert.equal(error, undefined)
  assert.equal(state.budget_usd, 5.0)
  assert.equal(state.status, 'running')
})

test('resumes a confirm-vetoed last pass (primary met target, confirm rejected it) instead of refusing it as done', () => {
  // a kill mid-rescue leaves disk state whose primary >= target; without veto-awareness the gate
  // would call it done and refuse resume — the opposite of why --confirm-scorer was added.
  const s = { ...buildState({ scores: [40, 95], hardCap: 10 }), confirm_vetoed_at_pass: 1 } // pass 1, primary 95 >= 90
  const { state, error } = prepareResume(s, {})
  assert.equal(error, undefined)
  assert.equal(state.status, 'running')
})

test('a confirm-vetoed last pass still refuses to resume when the cap is already hit', () => {
  // veto-awareness must not bypass the cap (the gate hides cap behind done when primary >= target).
  const s = { ...buildState({ scores: [40, 95], hardCap: 1 }), confirm_vetoed_at_pass: 1 } // pass 1 >= cap 1
  const { state, error } = prepareResume(s, {}) // no cap raise
  assert.equal(state, undefined)
  assert.match(error, /cap/i)
})

test('overrides only the provided keys and preserves history', () => {
  const s = { ...buildState({ scores: [40, 75], hardCap: 1, targetScore: 90 }), status: 'capped' }
  const { state } = prepareResume(s, { hard_cap: 5 })
  assert.equal(state.target_score, 90) // untouched
  assert.equal(state.budget_usd, null) // untouched (initState default)
  assert.equal(state.history.length, 2) // preserved
  assert.equal(state.best_score, 75)
})
