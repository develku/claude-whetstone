import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCost, extractTokens } from '../src/act-claude.mjs'

// extractCost parses `claude -p --output-format json` into the per-call costUsd that feeds
// spent_usd — the sole input to the budget stop. Pin every branch, including the best-effort
// ->0 on unparseable output (the dangerous branch; hard_cap is the backstop when it fires).

test('reads total_cost_usd from a single result object', () => {
  assert.equal(extractCost(JSON.stringify({ type: 'result', total_cost_usd: 0.22 })), 0.22)
})

test('reads cost from the result element of a stream array', () => {
  assert.equal(extractCost(JSON.stringify([{ type: 'system' }, { type: 'result', total_cost_usd: 0.05 }])), 0.05)
})

test('falls back to cost_usd when total_cost_usd is absent', () => {
  assert.equal(extractCost(JSON.stringify({ type: 'result', cost_usd: 0.1 })), 0.1)
})

test('returns 0 when no cost field is present', () => {
  assert.equal(extractCost(JSON.stringify({ type: 'result' })), 0)
})

test('returns 0 (best-effort) on unparseable output', () => {
  assert.equal(extractCost('not json at all'), 0)
  assert.equal(extractCost(''), 0)
})

// extractTokens sums the real tokens the call touched (input + output + both cache counts) into the
// per-call value that feeds spent_tokens — the input to the token budget stop (the subscription
// user's real constraint). Same best-effort ->0 contract as extractCost (hard_cap is the backstop).
test('extractTokens sums input, output, and both cache token counts', () => {
  const usage = { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 23525, cache_read_input_tokens: 16726 }
  assert.equal(extractTokens(JSON.stringify({ type: 'result', usage })), 10 + 200 + 23525 + 16726)
})

test('extractTokens reads usage from the result element of a stream array', () => {
  assert.equal(extractTokens(JSON.stringify([{ type: 'system' }, { type: 'result', usage: { input_tokens: 5, output_tokens: 7 } }])), 12)
})

test('extractTokens treats missing token fields as 0', () => {
  assert.equal(extractTokens(JSON.stringify({ type: 'result', usage: { output_tokens: 7 } })), 7)
})

test('extractTokens returns 0 when usage is absent', () => {
  assert.equal(extractTokens(JSON.stringify({ type: 'result' })), 0)
})

test('extractTokens returns 0 (best-effort) on unparseable output', () => {
  assert.equal(extractTokens('not json at all'), 0)
  assert.equal(extractTokens(''), 0)
})
