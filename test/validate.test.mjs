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

// budget_tokens is a COUNTED value (summed integer token counts), so it must be a positive integer —
// unlike budget_usd (a fractional threshold). A NaN/float here would silently disable the token stop.
test('flags a non-integer budget_tokens', () => {
  const errs = validateConfig({ ...valid(), budget_tokens: 1.5 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /budget_tokens/)
})

test('flags a non-numeric budget_tokens (NaN)', () => {
  assert.match(validateConfig({ ...valid(), budget_tokens: NaN })[0], /budget_tokens/)
})

test('allows a valid positive budget_tokens', () => {
  assert.deepEqual(validateConfig({ ...valid(), budget_tokens: 500000 }), [])
})

test('allows an unset budget_tokens (null)', () => {
  assert.deepEqual(validateConfig({ ...valid(), budget_tokens: null }), [])
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

// effort is a CLI string, not a number — validate membership so a typo (--effort hgih) fails fast
// with a clear message instead of the nested `claude -p` rejecting the flag mid-run.
test('flags an unknown effort level', () => {
  const errs = validateConfig({ ...valid(), effort: 'hgih' })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /effort/)
})

test('allows every valid effort level', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(validateConfig({ ...valid(), effort: e }), [])
  }
})

// stability_runs is COUNTED (re-run the scorer N times at the done-edge), so — like hard_cap — it must
// be a positive integer. The default (1 = off) must validate, and a bad value must fail fast.
test('a valid config defaults stability_runs to 1 (off)', () => {
  assert.equal(valid().stability_runs, 1)
})

test('flags a stability_runs below 1', () => {
  const errs = validateConfig({ ...valid(), stability_runs: 0 })
  assert.equal(errs.length, 1)
  assert.match(errs[0], /stability_runs/)
})

test('flags a non-integer stability_runs', () => {
  assert.match(validateConfig({ ...valid(), stability_runs: 1.5 })[0], /stability_runs/)
})

test('allows stability_runs of 1 (the default) and higher', () => {
  assert.deepEqual(validateConfig({ ...valid(), stability_runs: 1 }), [])
  assert.deepEqual(validateConfig({ ...valid(), stability_runs: 3 }), [])
})
