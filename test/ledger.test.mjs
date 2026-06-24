import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger } from '../src/ledger.mjs'

// buildLedger(state) gives the editor a compact, code-owned memory of the trajectory so it
// does not repeat failed edits or oscillate — the bounded middle between amnesia (only the last
// critique) and the harmful full-history context that degrades long refinement loops. Pure;
// derived only from scores (numbers), so it carries NO untrusted scorer free-text.

test('returns null until there are two real scores (nothing to compare yet)', () => {
  assert.equal(buildLedger({ history: [], best_score: null }), null)
  assert.equal(buildLedger({ history: [{ pass: 0, score: 50 }], best_score: 50 }), null)
})

test('reports the recent trajectory, the best bar, and an improving last edit', () => {
  const out = buildLedger({ history: [{ pass: 0, score: 50 }, { pass: 1, score: 70 }], best_score: 70 })
  assert.match(out, /#0=50 #1=70/)
  assert.match(out, /[Bb]est.*70/)
  assert.match(out, /\+20/)
  assert.match(out, /improv/i)
})

test('flags a regressed last edit so the editor changes approach', () => {
  const out = buildLedger({ history: [{ pass: 0, score: 80 }, { pass: 1, score: 60 }], best_score: 80 })
  assert.match(out, /-20/)
  assert.match(out, /regress/i)
})

test('flags a no-change last edit (the gradient did not move)', () => {
  const out = buildLedger({ history: [{ pass: 0, score: 80 }, { pass: 1, score: 80 }], best_score: 80 })
  assert.match(out, /no change|did ?n[o']t move/i)
})

test('caps the trajectory to the last four scored passes', () => {
  const history = [0, 1, 2, 3, 4, 5].map((p) => ({ pass: p, score: 50 + p }))
  const out = buildLedger({ history, best_score: 55 })
  assert.doesNotMatch(out, /#0=50/) // older passes dropped
  assert.doesNotMatch(out, /#1=51/)
  assert.match(out, /#2=52 #3=53 #4=54 #5=55/)
})

test('ignores non-finite scores (a baseline-error pass) when computing the delta', () => {
  // two finite scores exist among the history; the null must not poison the trajectory/delta.
  const out = buildLedger({ history: [{ pass: 0, score: null }, { pass: 1, score: 60 }, { pass: 2, score: 75 }], best_score: 75 })
  assert.match(out, /\+15/)
  assert.doesNotMatch(out, /NaN/)
})
