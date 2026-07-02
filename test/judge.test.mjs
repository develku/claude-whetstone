import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJudgeResponse, reviewFromSpawn } from '../scorers/llm-judge.mjs'

// The judge's model call is nondeterministic and costs money, so we unit-test the
// parsing seam (the part that must be robust to how a model wraps its JSON).

test('parses a clean JSON object', () => {
  const r = parseJudgeResponse('{"score": 73, "critique": "tighten the intro", "findings": []}')
  assert.equal(r.score, 73)
  assert.equal(r.critique, 'tighten the intro')
})

test('tolerates a ```json fenced block', () => {
  const r = parseJudgeResponse('```json\n{"score": 88, "critique": "x"}\n```')
  assert.equal(r.score, 88)
})

test('tolerates surrounding prose around the JSON', () => {
  const r = parseJudgeResponse('Here is my evaluation:\n{"score": 50, "critique": "y"}\nThanks!')
  assert.equal(r.score, 50)
})

test('defaults findings to an array when omitted', () => {
  const r = parseJudgeResponse('{"score": 10, "critique": "z"}')
  assert.deepEqual(r.findings, [])
})

test('rejects an out-of-range score', () => {
  assert.throws(() => parseJudgeResponse('{"score": 150, "critique": "z"}'))
})

test('rejects a response with no JSON object', () => {
  assert.throws(() => parseJudgeResponse('honestly it looks pretty good'))
})

// Regression (found by dogfooding the README run): the rubric asks the judge to cite a
// ```mermaid fence in its critique, so the critique value legitimately contains triple
// backticks. A ```-fence extractor mis-keys on those inner backticks and truncates the
// object before its closing brace. The parse must key off the JSON braces, not the fence.
// reviewFromSpawn turns a `claude -p` spawn result into a review or throws. A NON-ZERO exit must be
// surfaced even when stdout carries a valid-looking result — claude can emit a score JSON and then
// trip a non-zero exit (e.g. error_max_turns), which previously laundered a real failure into a clean
// score that drives the loop's accept decision. (Checked res.error only; not res.status.)
test('reviewFromSpawn surfaces a non-zero claude exit even when stdout carries a valid result', () => {
  const res = { status: 1, error: null, stdout: JSON.stringify({ type: 'result', result: '{"score": 50, "critique": "x"}' }) }
  assert.throws(() => reviewFromSpawn(res), /exit|status/i)
})

test('reviewFromSpawn returns the parsed review on a clean exit-0 result', () => {
  const res = { status: 0, error: null, stdout: JSON.stringify({ type: 'result', result: '{"score": 88, "critique": "ok"}' }) }
  assert.equal(reviewFromSpawn(res).score, 88)
})

test('reviewFromSpawn throws on a spawn error (claude not found / killed)', () => {
  assert.throws(() => reviewFromSpawn({ error: new Error('ENOENT'), status: null, stdout: '' }), /spawn|claude/i)
})

test('reviewFromSpawn picks the result event out of an array-shaped claude output', () => {
  const res = { status: 0, error: null, stdout: JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', result: '{"score": 42, "critique": "ok"}' }]) }
  assert.equal(reviewFromSpawn(res).score, 42)
})

test('reviewFromSpawn throws on unparseable stdout (the retry wrapper treats this as retryable)', () => {
  assert.throws(() => reviewFromSpawn({ status: 0, error: null, stdout: 'not json at all' }), /could not parse/)
})

test('tolerates triple-backticks inside the critique value', () => {
  const raw = '{"score": 84, "critique": "Add an inline ```mermaid flowchart: `flowchart TD` baseline->ACT, only `running` loops back to ACT```", "findings": []}'
  const r = parseJudgeResponse(raw)
  assert.equal(r.score, 84)
  assert.match(r.critique, /```mermaid/)
})
