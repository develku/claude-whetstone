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
