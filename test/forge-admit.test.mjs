// test/forge-admit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admitCheck } from '../src/forge/admit.mjs'

// stub runCheck: each artifact has a QUEUE of pass-verdicts (to script flakiness across replays)
const stub = (byArtifact) => {
  const q = Object.fromEntries(Object.entries(byArtifact).map(([k, v]) => [k, [...v]]))
  return async (_cmd, artifact) => ({ pass: q[artifact].shift() })
}
const base = { candidateCmd: 'node check.mjs', goodArtifact: 'good', badArtifact: 'bad', replayRuns: 2 }

test('admits a check that passes good and fails bad, reproducibly', async () => {
  const r = await admitCheck({ ...base, runCheck: stub({ good: [true, true], bad: [false, false] }) })
  assert.equal(r.admit, true)
})

test('rejects a TRIVIAL check that also passes the known-bad artifact', async () => {
  const r = await admitCheck({ ...base, runCheck: stub({ good: [true, true], bad: [true, true] }) })
  assert.equal(r.admit, false)
  assert.match(r.reason, /trivial|non-discriminating|known-bad/i)
})

test('rejects a FALSE-POSITIVE check that fails the known-good artifact', async () => {
  const r = await admitCheck({ ...base, runCheck: stub({ good: [false, false], bad: [false, false] }) })
  assert.equal(r.admit, false)
  assert.match(r.reason, /known-good|false-positive/i)
})

test('rejects a check whose verdict on good is not reproducible (flaky)', async () => {
  const r = await admitCheck({ ...base, runCheck: stub({ good: [true, false], bad: [false, false] }) })
  assert.equal(r.admit, false)
  assert.match(r.reason, /reproducible|flaky/i)
})

test('rejects a check whose verdict on bad is not reproducible (flaky)', async () => {
  const r = await admitCheck({ ...base, runCheck: stub({ good: [true, true], bad: [false, true] }) })
  assert.equal(r.admit, false)
  assert.match(r.reason, /reproducible|flaky/i)
})

test('replayRuns=1 does a single read (no flakiness check) and still discriminates', async () => {
  const r = await admitCheck({ ...base, replayRuns: 1, runCheck: stub({ good: [true], bad: [false] }) })
  assert.equal(r.admit, true)
})

import { scorerRunCheck } from '../src/forge/admit.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shq } from '../src/shq.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
// NOTE: shq() added vs plan — repo path contains spaces (iCloud drive); without quoting the shell
// splits the path and node cannot find the module. Fix category: obvious breaking env defect.
const CONTENT_SCORER = `node ${shq(join(REPO, 'test/fixtures/content-scorer.mjs'))} --needle FORGE_OK`

test('scorerRunCheck maps score>=target to pass against a real artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-adapter-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'all FORGE_OK here')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'nothing relevant')
  assert.equal(scorerRunCheck(CONTENT_SCORER, good, { target: 100 }).pass, true)
  assert.equal(scorerRunCheck(CONTENT_SCORER, bad, { target: 100 }).pass, false)
})

test('admitCheck end-to-end with the real scorerRunCheck adapter admits a discriminating check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'FORGE_OK')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'broken')
  const r = await admitCheck({ candidateCmd: CONTENT_SCORER, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck })
  assert.equal(r.admit, true)
})
