import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCost } from '../src/act-claude.mjs'

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
