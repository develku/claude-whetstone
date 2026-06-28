// test/swe-evo-run-ab.test.mjs
// The one pure piece of the real feasibility CLI: reading a scope-loop state.json into an arm result.
// The rest of run-ab.mjs (docker-cp checkout, spawn scope-cli, offline C/T grading) is Docker/editor
// integration, exercised by the feasibility dry-run, not $0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArmResult } from '../bench/swe-evo/run-ab.mjs'

test('parseArmResult reads V (best score), tokens, usd, and a veto flag from state.json', () => {
  const r = parseArmResult({ best_score: 100, spent_tokens: 12345, spent_usd: 0.34, confirm_vetoed_at_pass: 3 })
  assert.deepEqual(r, { V: 100, veto: 1, tokens: 12345, usd: 0.34 })
})

test('parseArmResult: no veto -> veto 0; missing token/usd fields -> 0; missing score -> null', () => {
  assert.deepEqual(parseArmResult({ best_score: 50, confirm_vetoed_at_pass: null }), { V: 50, veto: 0, tokens: 0, usd: 0 })
  assert.deepEqual(parseArmResult({}), { V: null, veto: 0, tokens: 0, usd: 0 })
})
