import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/validate.mjs'
import { initState } from '../src/state.mjs'

// Boundary validation: validateConfig(state) returns an array of human-readable error
// strings (empty array when the config is valid). Checks the loop's invariants up front
// so a bad run fails fast with a clear message instead of looping on nonsense.

const valid = () => initState({ goal: 'g', artifactPath: 'a.txt', scorerCmd: 's', targetScore: 90, hardCap: 10 })

test('a valid config produces no errors', () => {
  assert.deepEqual(validateConfig(valid()), [])
})

test('flags target_score outside 0..100', () => {
  const errs = validateConfig({ ...valid(), target_score: 150 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /target_score/)
})

test('flags hard_cap below 1', () => {
  const errs = validateConfig({ ...valid(), hard_cap: 0 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /hard_cap/)
})

test('flags a missing scorer_cmd', () => {
  const errs = validateConfig({ ...valid(), scorer_cmd: null })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /scorer/)
})

test('collects multiple errors at once', () => {
  const errs = validateConfig({ ...valid(), target_score: -5, hard_cap: 0 })
  assert.equal(errs.length, 2)
})

// NaN slips through every `<`/`>` comparison (NaN < 1 === false), so a non-numeric
// limit (--cap abc -> Number() -> NaN) would silently disable that ceiling. Guard with
// Number.isFinite — critical because the cap/budget are this tool's only cost stops.
test('flags a non-numeric hard_cap (NaN)', () => {
  const errs = validateConfig({ ...valid(), hard_cap: NaN })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /hard_cap/)
})

test('flags a non-finite hard_cap (Infinity)', () => {
  const errs = validateConfig({ ...valid(), hard_cap: Infinity })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /hard_cap/)
})

test('flags a non-numeric target_score (NaN)', () => {
  const errs = validateConfig({ ...valid(), target_score: NaN })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /target_score/)
})

test('flags a non-numeric budget_usd (NaN)', () => {
  const errs = validateConfig({ ...valid(), budget_usd: NaN })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /budget/)
})

test('allows a valid positive budget', () => {
  assert.deepEqual(validateConfig({ ...valid(), budget_usd: 2.5 }), [])
})

test('allows an unset budget (null)', () => {
  assert.deepEqual(validateConfig({ ...valid(), budget_usd: null }), [])
})

// hard_cap is COUNTED (gate: `pass >= hard_cap`, pass is integer), so a fractional cap
// silently rounds up the effective ceiling (--cap 1.5 stops at pass 2). The typed cap must
// mean what it says.
test('flags a non-integer hard_cap', () => {
  const errs = validateConfig({ ...valid(), hard_cap: 1.5 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /hard_cap/)
})

// min_delta and plateau_window feed the plateau stop — the same NaN/0/negative class:
// NaN disables the stop, plateau_window=0 falsely trips it on a healthy run (premature
// Opus escalation). Guard them too so the invariant is uniform across every loop numeric.
test('flags a non-numeric min_delta (NaN)', () => {
  const errs = validateConfig({ ...valid(), min_delta: NaN })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /min_delta/)
})

test('flags a negative min_delta', () => {
  const errs = validateConfig({ ...valid(), min_delta: -1 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /min_delta/)
})

test('allows a min_delta of 0 (any improvement counts as progress)', () => {
  assert.deepEqual(validateConfig({ ...valid(), min_delta: 0 }), [])
})

test('flags a non-integer plateau_window', () => {
  const errs = validateConfig({ ...valid(), plateau_window: 2.5 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /plateau_window/)
})

test('flags a plateau_window below 1', () => {
  const errs = validateConfig({ ...valid(), plateau_window: 0 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /plateau_window/)
})

test('flags a non-numeric plateau_window (NaN)', () => {
  const errs = validateConfig({ ...valid(), plateau_window: NaN })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /plateau_window/)
})
