// test/gate-audit.test.mjs
// AUD-08: runGateAudit mutates the final artifact and re-scores a small sample of mutants with the PRIMARY
// scorer. survived = scorer let a broken mutant clear target (weak gate); killed = scorer caught it; errored =
// scorer crashed on the mutant (no clean-kill credit). Advisory only — the caller never changes a verdict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGateAudit } from '../src/gate-audit.mjs'

const artifactWith = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'gaudit-')), 'impl.mjs'); writeFileSync(p, src); return p }
// a source with many mutable sites (comparison-flip, arithmetic-swap, boolean-flip, return-constant)
const MUTABLE = [
  'export const cmp = (a, b) => a === b',
  'export const rel = (a, b) => a > b',
  'export const add = (a, b) => a + b',
  'export const mul = (a, b) => a * b',
  'export const flag = () => true',
  'export const g = (x) => { return x }',
].join('\n') + '\n'

test('counts killed vs survived vs errored against the target using an injected scorer', async () => {
  const artifact = artifactWith(MUTABLE)
  // scorer queue: first mutant clears target (survives = weak gate), second is caught (killed), third throws (errored)
  const scores = [95, 10]
  const scoreOutput = async () => { if (scores.length) return scores.shift(); throw new Error('scorer crashed') }
  const r = await runGateAudit({ artifactPath: artifact, targetScore: 90, scoreOutput, sampleSize: 3 })
  assert.equal(r.sampled, 3)
  assert.equal(r.survived, 1)
  assert.equal(r.killed, 1)
  assert.equal(r.errored, 1)
})

test('samples at most sampleSize mutants and spans operators deterministically', async () => {
  const artifact = artifactWith(MUTABLE)
  let calls = 0
  await runGateAudit({ artifactPath: artifact, targetScore: 90, scoreOutput: async () => { calls++; return 10 }, sampleSize: 4 })
  assert.equal(calls, 4)
  // deterministic: same source + same sampleSize -> identical call count on a re-run
  let calls2 = 0
  await runGateAudit({ artifactPath: artifact, targetScore: 90, scoreOutput: async () => { calls2++; return 10 }, sampleSize: 4 })
  assert.equal(calls2, 4)
})

test('skips (no scorer calls) when the artifact has no mutable sites', async () => {
  const artifact = artifactWith('the quick brown fox\n') // prose: the JS-tuned operators find nothing
  let calls = 0
  const r = await runGateAudit({ artifactPath: artifact, targetScore: 90, scoreOutput: async () => { calls++; return 10 } })
  assert.ok(r.skipped)
  assert.equal(calls, 0)
})

test('cleans up its mutant files (no .gate-audit-mutant-* left in the artifact dir)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaudit-clean-'))
  const artifact = join(dir, 'impl.mjs'); writeFileSync(artifact, MUTABLE)
  await runGateAudit({ artifactPath: artifact, targetScore: 90, scoreOutput: async () => 10, sampleSize: 5 })
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('gate-audit-mutant')), [])
})
