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
