// test/forge-corroborate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corroborateLabels } from '../src/forge/corroborate.mjs'

// stub runCheck: a QUEUE of pass-verdicts per "cmd|artifact" (so we can script flakiness per oracle/artifact)
const stub = (byKey) => {
  const q = Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, [...v]]))
  return async (cmd, artifact) => ({ pass: q[`${cmd}|${artifact}`].shift() })
}
const base = { goodArtifact: 'good', badArtifact: 'bad', replayRuns: 2 }

test('no oracles configured -> trivially corroborated (passthrough, today\'s behavior)', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: [], runCheck: stub({}) })
  assert.deepEqual(r, { corroborated: true, conflicts: [], excluded: [], checked: 0 })
})

test('one independent oracle that AGREES (passes good, fails bad) corroborates', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [true, true], 'o1|bad': [false, false] }) })
  assert.equal(r.corroborated, true)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.checked, 1)
})

test('an oracle that REJECTS the good artifact is a dissent -> decline (primary veto disputed)', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [false, false], 'o1|bad': [false, false] }) })
  assert.equal(r.corroborated, false)
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0].reason, /good|reject/i)
})

test('an oracle that ACCEPTS the bad artifact is a dissent -> decline', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [true, true], 'o1|bad': [true, true] }) })
  assert.equal(r.corroborated, false)
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0].reason, /bad|accept/i)
})

test('a FLAKY oracle (unstable on good) is EXCLUDED, NOT a dissent -> still corroborated (no kill-switch)', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [true, false], 'o1|bad': [false, false] }) })
  assert.equal(r.corroborated, true) // one flaky oracle does NOT veto all learning
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.excluded.length, 1)
  assert.match(r.excluded[0].reason, /reproducible|flaky|excluded/i)
})

test('a FLAKY oracle (unstable on bad) is EXCLUDED, not a dissent', async () => {
  const r = await corroborateLabels({ ...base, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [true, true], 'o1|bad': [false, true] }) })
  assert.equal(r.corroborated, true)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.excluded.length, 1)
})

test('UNANIMITY: among two oracles, a single dissent declines even though the other agrees', async () => {
  const r = await corroborateLabels({
    ...base, oracleCmds: ['o1', 'o2'],
    runCheck: stub({ 'o1|good': [true, true], 'o1|bad': [false, false], 'o2|good': [false, false], 'o2|bad': [false, false] }),
  })
  assert.equal(r.corroborated, false)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].oracleCmd, 'o2')
})

test('collects ALL conflicts (no early return) when multiple oracles dissent', async () => {
  const r = await corroborateLabels({
    ...base, oracleCmds: ['o1', 'o2'],
    runCheck: stub({ 'o1|good': [false, false], 'o1|bad': [false, false], 'o2|good': [true, true], 'o2|bad': [true, true] }),
  })
  assert.equal(r.corroborated, false)
  assert.equal(r.conflicts.length, 2)
  assert.deepEqual(r.conflicts.map((c) => c.oracleCmd).sort(), ['o1', 'o2'])
})

test('a stable agreeing oracle corroborates even when a sibling oracle is flaky-excluded', async () => {
  const r = await corroborateLabels({
    ...base, oracleCmds: ['stable', 'flaky'],
    runCheck: stub({ 'stable|good': [true, true], 'stable|bad': [false, false], 'flaky|good': [true, false], 'flaky|bad': [false, false] }),
  })
  assert.equal(r.corroborated, true)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.excluded.length, 1)
  assert.equal(r.excluded[0].oracleCmd, 'flaky')
})

test('replayRuns=1 does a single read per artifact (no flakiness check) and still corroborates', async () => {
  const r = await corroborateLabels({ ...base, replayRuns: 1, oracleCmds: ['o1'], runCheck: stub({ 'o1|good': [true], 'o1|bad': [false] }) })
  assert.equal(r.corroborated, true)
})

// end-to-end with the real scorerRunCheck adapter against real artifacts (mirrors forge-admit.test.mjs)
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shq } from '../src/shq.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT_SCORER = `node ${shq(join(REPO, 'test/fixtures/content-scorer.mjs'))} --needle FORGE_OK`

test('corroborateLabels end-to-end with the real scorerRunCheck adapter (agreeing oracle)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-corr-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'FORGE_OK')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'broken')
  const r = await corroborateLabels({ goodArtifact: good, badArtifact: bad, oracleCmds: [CONTENT_SCORER], replayRuns: 2, runCheck: scorerRunCheck })
  assert.equal(r.corroborated, true)
  assert.deepEqual(r.conflicts, [])
})
