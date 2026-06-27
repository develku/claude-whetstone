import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSpend } from '../src/spend-format.mjs'

test('token-primary with USD secondary in parens', () => {
  assert.equal(formatSpend({ tokens: 1234, costUsd: 0.5 }), '1,234 tokens ($0.5000)')
})

test('locale-comma groups large token counts', () => {
  assert.equal(formatSpend({ tokens: 1234567, costUsd: 0.5 }), '1,234,567 tokens ($0.5000)')
})

test('drops the $ paren at zero cost (stub/$0 ledger reads clean)', () => {
  assert.equal(formatSpend({ tokens: 1234, costUsd: 0 }), '1,234 tokens')
})

test('full word "tokens", not "tok"', () => {
  assert.match(formatSpend({ tokens: 5, costUsd: 0 }), /\btokens\b/)
})

test('Number-coerces a stringy costUsd instead of crashing on .toFixed', () => {
  assert.equal(formatSpend({ tokens: 10, costUsd: '0.5' }), '10 tokens ($0.5000)')
})

test('missing/garbage fields degrade to 0, never NaN/undefined', () => {
  assert.equal(formatSpend({}), '0 tokens')
  assert.equal(formatSpend(), '0 tokens')
  assert.equal(formatSpend({ tokens: 'x', costUsd: 'y' }), '0 tokens')
})
