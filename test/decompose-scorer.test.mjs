import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSubGateArgs, quoteOnly } from '../scorers/test-pass-rate.mjs'

test('quoteOnly: appends a single-quoted --test-name-pattern, injection-safe', () => {
  assert.equal(quoteOnly('node --test', "a ' b"), "node --test --test-name-pattern 'a '\\'' b'")
})

test('buildSubGateArgs: a finding carries a self-referential, decomposable sub-gate', () => {
  const sg = buildSubGateArgs('node --test', 'auth login fails')
  assert.deepEqual(sg, { id: 'test-pass-rate', args: ['--cmd', 'node --test', '--only', 'auth login fails'] })
})
