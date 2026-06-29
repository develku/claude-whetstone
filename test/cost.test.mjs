import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCost, extractTokens, editorFailureReason, editorResultSubtype, editorExitDisposition } from '../src/act-claude.mjs'

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

test('coerces a PRESENT-but-non-numeric cost field to 0 (the || 0 guard, distinct from the missing-field path)', () => {
  // a future claude -p shape that emits a STRING cost must not inject NaN into spent_usd — that would make
  // every `NaN > budget` false and defeat the budget stop. This exercises the `|| 0` operator itself, which
  // the missing-field tests never reach (they short-circuit at `?? 0` before Number() runs).
  assert.equal(extractCost(JSON.stringify({ type: 'result', total_cost_usd: 'abc' })), 0)
  assert.equal(extractCost(JSON.stringify({ type: 'result', total_cost_usd: null, cost_usd: 'x' })), 0)
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

test('extractTokens coerces a PRESENT-but-non-numeric token field to 0 (per-field || 0 guard)', () => {
  // a malformed usage field (string instead of number) must contribute 0, not NaN, to the token total
  assert.equal(extractTokens(JSON.stringify({ type: 'result', usage: { input_tokens: 'xx', output_tokens: 5 } })), 5)
})

// editorFailureReason turns a non-zero `claude -p --output-format json` exit into an ACTIONABLE reason.
// The bug it fixes: the old head-slice grabbed the FIRST array element (the init message) and discarded
// the real error (the LAST element, type:'result'), so every transient editor failure looked identical
// and undiagnosable. Pin the surfacing order: stderr, then the result element, then the stdout tail.
test('editorFailureReason surfaces the result element error, not the init message', () => {
  const stdout = JSON.stringify([
    { type: 'system', subtype: 'init', tools: ['Bash', 'Edit'] },
    { type: 'result', is_error: true, subtype: 'error_during_execution', api_error_status: 'overloaded_error', result: 'Overloaded' },
  ])
  const r = editorFailureReason(stdout, '')
  assert.match(r, /error_during_execution/)
  assert.match(r, /overloaded_error/)
  assert.doesNotMatch(r, /init/)
})

test('editorFailureReason prefers a non-empty (trimmed) stderr', () => {
  assert.equal(editorFailureReason('[{"type":"result","is_error":true}]', '  rate limit reached  '), 'rate limit reached')
})

test('editorFailureReason reads a single result object too (not only arrays)', () => {
  assert.match(editorFailureReason(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns' }), ''), /error_max_turns/)
})

test('editorFailureReason uses the LAST result element when more than one is present', () => {
  const stdout = JSON.stringify([
    { type: 'result', is_error: false, subtype: 'success' }, // an earlier (success) result — must be skipped
    { type: 'result', is_error: true, subtype: 'error_during_execution', api_error_status: 'overloaded_error' },
  ])
  const r = editorFailureReason(stdout, '')
  assert.match(r, /overloaded_error/)
})

test('editorFailureReason: init-only truncation (no result element) -> stdout tail, not subtype=init', () => {
  const initOnly = JSON.stringify([{ type: 'system', subtype: 'init', tools: ['Bash'] }])
  const r = editorFailureReason(initOnly, '')
  assert.doesNotMatch(r, /subtype=init/)
  assert.match(r, /init/) // the tail still contains the raw text, honestly
})

test('editorFailureReason falls back to the stdout TAIL on a truncated/partial stream (no throw)', () => {
  const partial = '[{"type":"system","subtype":"init"' // unterminated JSON
  const r = editorFailureReason(partial, '')
  assert.ok(typeof r === 'string' && r.length > 0)
})

test('editorFailureReason: empty in -> a generic marker, never empty', () => {
  assert.equal(editorFailureReason('', ''), '(no editor output)')
})

// editorResultSubtype / editorExitDisposition decide whether a non-zero `claude -p` exit is a real
// failure or a NORMAL turn-limit truncation. error_max_turns means the editor used its per-pass turn
// budget — its incremental edits (acceptEdits) are applied and persist — so the loop must score them and
// continue, NOT treat the whole pass as fatal (which killed the H1 audit). Everything else stays fatal.
test('editorResultSubtype reads the last result subtype; null on unparseable', () => {
  assert.equal(editorResultSubtype(JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success' }])), 'success')
  assert.equal(editorResultSubtype(JSON.stringify({ type: 'result', subtype: 'error_max_turns' })), 'error_max_turns')
  assert.equal(editorResultSubtype('not json'), null)
})

test('editorExitDisposition: a clean exit 0 is non-fatal', () => {
  assert.deepEqual(editorExitDisposition(0, ''), { fatal: false, truncated: false })
})

test('editorExitDisposition: a turn-limit hit (error_max_turns, exit!=0) is non-fatal/truncated', () => {
  const stdout = JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', is_error: true, subtype: 'error_max_turns' }])
  assert.deepEqual(editorExitDisposition(1, stdout), { fatal: false, truncated: true })
})

test('editorExitDisposition: any OTHER non-zero exit is fatal (incl. unparseable -> cannot confirm max_turns)', () => {
  assert.equal(editorExitDisposition(1, JSON.stringify([{ type: 'result', is_error: true, subtype: 'error_during_execution' }])).fatal, true)
  assert.equal(editorExitDisposition(1, 'unparseable').fatal, true)
})
