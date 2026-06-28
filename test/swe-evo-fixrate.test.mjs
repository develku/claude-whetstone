// test/swe-evo-fixrate.test.mjs
// Pins SWE-EVO's grading semantics (paper Eq. 1) used for the V/C/T scorers. Pure: the Docker
// runner (later) produces a {node -> pass|fail|missing} results map; this grades it. Decoupling
// execution from grading lets the metric be validated at $0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFixRate, isResolved } from '../bench/swe-evo/fixrate.mjs'

const R = (obj) => obj // results map: nodeId -> 'pass' | 'fail' | 'missing'

test('all FAIL_TO_PASS pass, no regression -> 100', () => {
  const r = computeFixRate({ results: R({ 'f::a': 'pass', 'f::b': 'pass', 'p::x': 'pass' }), failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  assert.equal(r, 100)
})

test('half of FAIL_TO_PASS pass -> 50', () => {
  const r = computeFixRate({ results: R({ 'f::a': 'pass', 'f::b': 'fail', 'p::x': 'pass' }), failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  assert.equal(r, 50)
})

test('ANY PASS_TO_PASS failure -> hard 0 (regression), even with all FAIL_TO_PASS passing (Eq.1)', () => {
  const r = computeFixRate({ results: R({ 'f::a': 'pass', 'f::b': 'pass', 'p::x': 'fail' }), failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  assert.equal(r, 0)
})

test('a missing/errored FAIL_TO_PASS node counts as not-passing', () => {
  const r = computeFixRate({ results: R({ 'f::a': 'pass', 'p::x': 'pass' }), failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  assert.equal(r, 50) // f::b missing -> not passing
})

test('empty failNodes with no regression -> 100 (vacuous); with a regression -> 0', () => {
  assert.equal(computeFixRate({ results: R({ 'p::x': 'pass' }), failNodes: [], passToPass: ['p::x'] }), 100)
  assert.equal(computeFixRate({ results: R({ 'p::x': 'fail' }), failNodes: [], passToPass: ['p::x'] }), 0)
})

test('isResolved: true iff every FAIL_TO_PASS and PASS_TO_PASS passes', () => {
  assert.equal(isResolved({ results: R({ 'f::a': 'pass', 'p::x': 'pass' }), failNodes: ['f::a'], passToPass: ['p::x'] }), true)
  assert.equal(isResolved({ results: R({ 'f::a': 'fail', 'p::x': 'pass' }), failNodes: ['f::a'], passToPass: ['p::x'] }), false)
  assert.equal(isResolved({ results: R({ 'f::a': 'pass', 'p::x': 'fail' }), failNodes: ['f::a'], passToPass: ['p::x'] }), false)
})
