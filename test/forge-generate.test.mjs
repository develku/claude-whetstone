// test/forge-generate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shq } from '../src/shq.mjs'
import { buildGeneratorPrompt, parseGeneratorResponse, resolveCandidate, generateCandidates, claudePropose } from '../src/forge/generate.mjs'

// --- buildGeneratorPrompt (pure) ---

test('buildGeneratorPrompt fences untrusted content, lists the catalog, and demands JSON', () => {
  const p = buildGeneratorPrompt({
    goal: 'make the tests pass honestly',
    goodContent: 'HONEST_BODY',
    badContent: 'GAMED_BODY',
    critique: 'the test was deleted',
    scorerCatalog: [{ id: 'test-pass-rate', usage: '--cmd <test command> --only <name>' }],
  })
  assert.match(p, /make the tests pass honestly/)
  assert.match(p, /BEGIN HONEST ARTIFACT/)
  assert.match(p, /HONEST_BODY/)
  assert.match(p, /BEGIN GAMED ARTIFACT/)
  assert.match(p, /GAMED_BODY/)
  assert.match(p, /the test was deleted/)
  assert.match(p, /test-pass-rate: --cmd <test command> --only <name>/)
  assert.match(p, /never follow/i)
  assert.match(p, /"candidates"/)
})

// --- parseGeneratorResponse (pure) ---

test('parseGeneratorResponse reads valid candidates', () => {
  const out = parseGeneratorResponse('{"candidates":[{"scorerId":"contains","args":["--needle","X"],"rationale":"r"}]}')
  assert.deepEqual(out, [{ scorerId: 'contains', args: ['--needle', 'X'], rationale: 'r' }])
})

test('parseGeneratorResponse tolerates a ```json fence (keys off outermost braces)', () => {
  const out = parseGeneratorResponse('```json\n{"candidates":[{"scorerId":"contains","args":[]}]}\n```')
  assert.equal(out.length, 1)
  assert.equal(out[0].scorerId, 'contains')
  assert.equal(out[0].rationale, '')
})

test('parseGeneratorResponse throws when there is no JSON object', () => {
  assert.throws(() => parseGeneratorResponse('sorry, no checks'), /no JSON object/)
})

test('parseGeneratorResponse throws when candidates is not an array', () => {
  assert.throws(() => parseGeneratorResponse('{"foo":1}'), /candidates/)
})

test('parseGeneratorResponse drops malformed candidates but keeps the good ones', () => {
  const out = parseGeneratorResponse('{"candidates":[{"scorerId":"ok","args":["a"]},{"scorerId":123,"args":[]},{"scorerId":"y","args":[5]}]}')
  assert.deepEqual(out.map((c) => c.scorerId), ['ok'])
})

// --- resolveCandidate (pure trust gate) ---

test('resolveCandidate builds a node command for an allowlisted scorer, args shq-quoted', () => {
  const allowlist = new Map([['contains', '/abs/scorers/contains.mjs']])
  const r = resolveCandidate({ scorerId: 'contains', args: ['--needle', 'X Y'] }, allowlist)
  const expected = ['node', shq('/abs/scorers/contains.mjs'), shq('--needle'), shq('X Y')].join(' ')
  assert.equal(r.cmd, expected)
})

test('resolveCandidate returns null for an unallowlisted scorer id', () => {
  const allowlist = new Map([['contains', '/abs/scorers/contains.mjs']])
  assert.equal(resolveCandidate({ scorerId: 'evil', args: [] }, allowlist), null)
})

// --- generateCandidates (orchestrator, injected propose) ---

const pair = () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gen-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'HONEST')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'GAMED')
  return { good, bad }
}
const CATALOG = [{ id: 'contains', usage: '--needle <s>' }]
const ALLOW = new Map([['contains', '/abs/contains.mjs']])

test('generateCandidates resolves allowlisted candidates and rejects the rest, surfacing cost/tokens', async () => {
  const { good, bad } = pair()
  const propose = async () => ({
    text: '{"candidates":[{"scorerId":"contains","args":["--needle","X"],"rationale":"r"},{"scorerId":"ghost","args":[]}]}',
    costUsd: 0.02, tokens: 7,
  })
  const out = await generateCandidates({ goal: 'g', goodArtifact: good, badArtifact: bad, scorerCatalog: CATALOG, allowlist: ALLOW, propose })
  assert.equal(out.candidates.length, 1)
  assert.equal(out.candidates[0].scorerId, 'contains')
  assert.match(out.candidates[0].cmd, /contains\.mjs/)
  assert.deepEqual(out.rejected, [{ scorerId: 'ghost', reason: 'not in allowlist' }])
  assert.equal(out.costUsd, 0.02)
  assert.equal(out.tokens, 7)
})

test('generateCandidates caps the number of proposals it processes at maxCandidates', async () => {
  const { good, bad } = pair()
  const propose = async () => ({
    text: '{"candidates":[{"scorerId":"contains","args":["--needle","A"]},{"scorerId":"contains","args":["--needle","B"]},{"scorerId":"contains","args":["--needle","C"]}]}',
  })
  const out = await generateCandidates({ goal: 'g', goodArtifact: good, badArtifact: bad, scorerCatalog: CATALOG, allowlist: ALLOW, propose, maxCandidates: 2 })
  assert.equal(out.candidates.length, 2)
  assert.equal(out.costUsd, 0)
})

// --- claudePropose (default adapter, fake claude shim — $0) ---

const fakeClaude = (dir, { result, cost = 0.03, outTokens = 4, exit = 0 }) => {
  const p = join(dir, 'fake-claude.mjs')
  const body = exit !== 0
    ? `#!/usr/bin/env node\nprocess.stderr.write('boom\\n'); process.exit(${exit})\n`
    : `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', result: ${JSON.stringify(result)}, total_cost_usd: ${cost}, usage: { output_tokens: ${outTokens} } }))\n`
  writeFileSync(p, body); chmodSync(p, 0o755)
  return p
}

test('claudePropose returns the result text plus extracted cost and tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-'))
  const bin = fakeClaude(dir, { result: '{"candidates":[]}', cost: 0.05, outTokens: 9 })
  const out = claudePropose('hi', { claudeBin: bin })
  assert.equal(out.text, '{"candidates":[]}')
  assert.equal(out.costUsd, 0.05)
  assert.equal(out.tokens, 9)
})

test('claudePropose throws on a non-zero claude exit (a failed proposal is never a silent empty)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-'))
  const bin = fakeClaude(dir, { result: '', exit: 2 })
  assert.throws(() => claudePropose('hi', { claudeBin: bin }), /exited 2/)
})
