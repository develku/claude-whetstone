// test/gate-probe.test.mjs
// AUD-10: runGateSelfProbe mutates the accepted artifact and probes the composed confirm gate. A reproducible
// `pass` (the gate let a broken mutant through) is a survivor; sequential with early-stop at survivorCap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGateSelfProbe } from '../src/forge/gate-probe.mjs'

const artifactWith = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'gprobe-')), 'impl.mjs'); writeFileSync(p, src); return p }
const MUTABLE = [
  'export const cmp = (a, b) => a === b',
  'export const rel = (a, b) => a > b',
  'export const add = (a, b) => a + b',
  'export const flag = () => true',
].join('\n') + '\n'

test('a mutant the gate reproducibly PASSES is a survivor; reject/error/flaky are not (AUD-10)', async () => {
  const artifact = artifactWith(MUTABLE)
  // gate lets EVERY mutant pass -> the first is a survivor, early-stop at survivorCap=1 stops there
  const alwaysPass = async () => ({ pass: true })
  const r = await runGateSelfProbe({ artifactPath: artifact, composedConfirmCmd: 'GATE', runCheck: alwaysPass, sampleSize: 4, survivorCap: 1 })
  assert.equal(r.survivors.length, 1, 'early-stop at survivorCap=1')
  assert.equal(r.probed, 1, 'sequential: stopped after the first survivor (no wasted paid gate runs)')
  r.cleanup()
})

test('a gate that catches every mutant yields zero survivors and probes the whole sample (AUD-10)', async () => {
  const artifact = artifactWith(MUTABLE)
  const alwaysReject = async () => ({ pass: false })
  const r = await runGateSelfProbe({ artifactPath: artifact, composedConfirmCmd: 'GATE', runCheck: alwaysReject, sampleSize: 4, survivorCap: 1 })
  assert.equal(r.survivors.length, 0)
  assert.equal(r.probed, 4, 'no survivors -> probes the full sample')
})

test('early-stop bounds paid work: survivorCap=2 stops after the 2nd survivor (AUD-10)', async () => {
  const artifact = artifactWith(MUTABLE)
  const r = await runGateSelfProbe({ artifactPath: artifact, composedConfirmCmd: 'GATE', runCheck: async () => ({ pass: true }), sampleSize: 4, survivorCap: 2 })
  assert.equal(r.survivors.length, 2)
  assert.equal(r.probed, 2)
  r.cleanup()
})

test('survivor files persist for routing, non-survivors are cleaned immediately, cleanup() removes the rest (AUD-10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gprobe-clean-'))
  const artifact = join(dir, 'impl.mjs'); writeFileSync(artifact, MUTABLE)
  const r = await runGateSelfProbe({ artifactPath: artifact, composedConfirmCmd: 'GATE', runCheck: async () => ({ pass: true }), sampleSize: 4, survivorCap: 1 })
  assert.equal(r.survivors.length, 1)
  assert.ok(existsSync(r.survivors[0].path), 'the survivor file is kept for the caller to route to learning')
  r.cleanup()
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('gate-probe-mutant')), [], 'cleanup removes the survivor file')
})

test('skips (no gate runs) when the artifact has no mutable sites (AUD-10)', async () => {
  const artifact = artifactWith('the quick brown fox\n')
  let calls = 0
  const r = await runGateSelfProbe({ artifactPath: artifact, composedConfirmCmd: 'GATE', runCheck: async () => { calls++; return { pass: true } } })
  assert.ok(r.skipped)
  assert.equal(calls, 0)
})
