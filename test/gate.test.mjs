import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateVerdict } from '../src/gate.mjs'

// The gate is the heart of loop engineering: CODE — not the model — decides
// continue/stop. These tests pin that contract. A scored pass is {pass, score}.

const base = {
  target_score: 90,
  hard_cap: 10,
  min_delta: 1,
  plateau_window: 3,
}

function withHistory(scores, overrides = {}) {
  const history = scores.map((score, i) => ({ pass: i, score }))
  return {
    ...base,
    ...overrides,
    pass: history.length - 1,
    current_score: scores.at(-1),
    history,
  }
}

test('done when latest score meets the target', () => {
  assert.equal(gateVerdict(withHistory([40, 70, 91])).status, 'done')
})

test('done when score exactly equals the target', () => {
  assert.equal(gateVerdict(withHistory([10, 90])).status, 'done')
})

test('running when below target with budget and progress left', () => {
  assert.equal(gateVerdict(withHistory([40, 55, 70])).status, 'running')
})

test('capped when pass index reaches the hard cap and target not met', () => {
  const s = withHistory([10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 88], { hard_cap: 10 })
  assert.equal(s.pass, 10)
  assert.equal(gateVerdict(s).status, 'capped')
})

test('done beats capped: hitting the target on the final allowed pass is success', () => {
  const s = withHistory([10, 20, 30, 40, 50, 60, 70, 80, 88, 90, 92], { hard_cap: 10 })
  assert.equal(s.pass, 10)
  assert.equal(gateVerdict(s).status, 'done')
})

test('plateau when best score has not improved by min_delta across the window', () => {
  // best-so-far stalls at 80 for the last 3 passes (window=3, min_delta=1)
  const s = withHistory([50, 70, 80, 80, 80, 80])
  assert.equal(gateVerdict(s).status, 'plateau')
})

test('not plateau when best score is still climbing within the window', () => {
  const s = withHistory([50, 70, 80, 82, 84, 86])
  assert.equal(gateVerdict(s).status, 'running')
})

test('plateau compares the best now against the best plateau_window passes ago (needs window+1 passes)', () => {
  // window=2: with 3 scored passes the best now (80) is compared to the best 2 passes ago (50) ->
  // improved by 30 -> still running. One more flat pass -> best now (80) vs best 2 ago (80) -> plateau.
  assert.equal(gateVerdict(withHistory([50, 80, 80], { plateau_window: 2 })).status, 'running')
  assert.equal(gateVerdict(withHistory([50, 80, 80, 80], { plateau_window: 2 })).status, 'plateau')
})

test('plateau is measured on best-so-far, not current — a single noise dip does not reset it', () => {
  // current oscillates but best stays 80; still a plateau
  const s = withHistory([50, 70, 80, 78, 80, 79])
  assert.equal(gateVerdict(s).status, 'plateau')
})

test('error when the score is null (scorer produced nothing)', () => {
  assert.equal(gateVerdict(withHistory([40, 60, null])).status, 'error')
})

test('error when the score is out of the 0..100 range', () => {
  assert.equal(gateVerdict(withHistory([40, 140])).status, 'error')
  assert.equal(gateVerdict(withHistory([40, -5])).status, 'error')
})

test('error when the score is not a number', () => {
  assert.equal(gateVerdict(withHistory([40, NaN])).status, 'error')
  assert.equal(gateVerdict(withHistory([40, '80'])).status, 'error')
})

test('error beats done: a malformed score never counts as success', () => {
  assert.equal(gateVerdict(withHistory([40, 999])).status, 'error')
})

test('every verdict carries a human-readable reason', () => {
  const v = gateVerdict(withHistory([40, 91]))
  assert.equal(typeof v.reason, 'string')
  assert.ok(v.reason.length > 0)
})
