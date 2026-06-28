import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realPlanCall, extractPlannerText } from '../src/plan-call.mjs'

const okStdout = JSON.stringify({
  type: 'result',
  result: '{"objectives":[{"id":"o1"}]}',
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
})

test('realPlanCall: returns text + token-primary spend from a successful claude -p json result', async () => {
  let captured
  const spawn = (bin, args, opts) => { captured = { bin, args, opts }; return { status: 0, stdout: okStdout, stderr: '' } }
  const r = await realPlanCall('PROMPT', { spawn, model: 'opus' })
  assert.equal(r.text, '{"objectives":[{"id":"o1"}]}')
  assert.equal(r.spentTokens, 150) // input + output + both cache
  assert.equal(r.spentUsd, 0.01)
  // argv reuses buildClaudeArgs: -p PROMPT, json output, the model, single-shot
  assert.ok(captured.args.includes('-p') && captured.args.includes('PROMPT'))
  assert.ok(captured.args.includes('--output-format') && captured.args.includes('json'))
  assert.ok(captured.args.includes('--model') && captured.args.includes('opus'))
  assert.ok(captured.args.includes('--max-turns') && captured.args.includes('1'))
  // SIGKILL wall-clock cap (a hung planner can't wedge an unattended run)
  assert.equal(captured.opts.killSignal, 'SIGKILL')
  assert.ok(captured.opts.timeout > 0)
  // MECHANICAL no-edit guarantee: the planner must NOT auto-accept edits (default mode in headless -p
  // denies edits; acceptEdits would auto-apply them) — power-review M1
  assert.equal(captured.args.includes('acceptEdits'), false)
  assert.equal(captured.args.includes('--permission-mode'), false)
})

test('realPlanCall: a spawn error throws (a hung/missing claude is surfaced, not a silent $0 no-op)', async () => {
  const spawn = () => ({ error: { code: 'ETIMEDOUT' } })
  await assert.rejects(realPlanCall('p', { spawn }), /planner .*failed.*ETIMEDOUT/)
})

test('realPlanCall: a non-zero exit throws with stderr context', async () => {
  const spawn = () => ({ status: 1, stdout: '', stderr: 'rate limit reached' })
  await assert.rejects(realPlanCall('p', { spawn }), /exited 1.*rate limit/)
})

test('extractPlannerText: pulls result.result; falls back to raw stdout on non-JSON', () => {
  assert.equal(extractPlannerText(JSON.stringify({ type: 'result', result: 'HELLO' })), 'HELLO')
  assert.equal(extractPlannerText('plain {"objectives":[]} text'), 'plain {"objectives":[]} text')
})
