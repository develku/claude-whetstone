// test/forge-prune.test.mjs — auto-flaky retirement: find + tombstone stored checks that give a
// non-reproducible (flaky) verdict on a known-good artifact. SAFE boundary: a STABLE-failing check is NOT
// pruned (ambiguous — may be a genuine catch the base gate missed; stays operator-retired, per brick 4b).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flakyActiveChecks, pruneFlaky } from '../src/forge/prune.mjs'
import { emptyStore, addCheck, listActiveChecks, saveStore, loadStore, checkStorePath } from '../src/forge/store.mjs'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { shq } from '../src/shq.mjs'

// stub runCheck: a queue of pass-verdicts per cmd (to script per-check flakiness).
const stub = (byCmd) => {
  const q = Object.fromEntries(Object.entries(byCmd).map(([k, v]) => [k, [...v]]))
  return async (cmd) => ({ pass: q[cmd].shift() })
}

test('flakyActiveChecks flags an unstable check and keeps a stable-passing one', async () => {
  let s = addCheck(emptyStore(), { cmd: 'node flaky.mjs', target: 100 })
  s = addCheck(s, { cmd: 'node stable.mjs', target: 100 })
  const runCheck = stub({ 'node flaky.mjs': [true, false], 'node stable.mjs': [true, true] })
  const out = await flakyActiveChecks(s, { goodArtifact: '/good', runCheck, replayRuns: 2, kind: 'file' })
  assert.equal(out.length, 1)
  assert.equal(out[0].cmd, 'node flaky.mjs')
  assert.match(out[0].reason, /flaky|reproducible/i)
})

test('flakyActiveChecks does NOT retire a stable-FAILING check (ambiguous: may be a genuine catch)', async () => {
  const s = addCheck(emptyStore(), { cmd: 'node fails.mjs', target: 100 })
  const out = await flakyActiveChecks(s, { goodArtifact: '/good', runCheck: stub({ 'node fails.mjs': [false, false] }), replayRuns: 2, kind: 'file' })
  assert.equal(out.length, 0)
})

test('flakyActiveChecks filters by kind (a scope prune ignores file checks) and skips retired', async () => {
  let s = addCheck(emptyStore(), { cmd: 'node scope.mjs --rel x', target: 100, kind: 'scope' })
  s = addCheck(s, { cmd: 'node file.mjs', target: 100 }) // file — must be skipped by a scope prune
  const out = await flakyActiveChecks(s, { goodArtifact: '/g', runCheck: stub({ 'node scope.mjs --rel x': [true, false] }), replayRuns: 2, kind: 'scope' })
  assert.equal(out.length, 1)
  assert.equal(out[0].cmd, 'node scope.mjs --rel x')
})

test('pruneFlaky tombstones the flaky check in the store and returns the retired cmds', async () => {
  let store = addCheck(emptyStore(), { cmd: 'node flaky.mjs', target: 100 })
  store = addCheck(store, { cmd: 'node stable.mjs', target: 100 })
  let saved = null
  const retired = await pruneFlaky({
    storePath: '/s.json', goodArtifact: '/good', kind: 'file', replayRuns: 2,
    runCheck: stub({ 'node flaky.mjs': [true, false], 'node stable.mjs': [true, true] }),
    loadStore: () => store, saveStore: (_p, s) => { saved = s },
  })
  assert.deepEqual(retired, ['node flaky.mjs'])
  assert.deepEqual(listActiveChecks(saved, 'file'), [{ cmd: 'node stable.mjs', target: 100, reason: null }]) // flaky folded out, stable kept
})

test('pruneFlaky is a no-op (no save) when nothing is flaky', async () => {
  const store = addCheck(emptyStore(), { cmd: 'node stable.mjs', target: 100 })
  let saved = false
  const retired = await pruneFlaky({
    storePath: '/s.json', goodArtifact: '/good', kind: 'file', runCheck: stub({ 'node stable.mjs': [true, true] }),
    loadStore: () => store, saveStore: () => { saved = true },
  })
  assert.deepEqual(retired, [])
  assert.equal(saved, false)
})

// --- end-to-end with REAL scorer subprocesses ($0, no model) ---
const writeScorer = (body) => { const p = join(mkdtempSync(join(tmpdir(), 'sc-')), 's.mjs'); writeFileSync(p, body); return p }
// flaky: a per-script counter file makes the verdict alternate across spawns (non-reproducible).
const FLAKY = "import { readFileSync, writeFileSync } from 'node:fs'\nimport { dirname } from 'node:path'\nimport { fileURLToPath } from 'node:url'\nconst c = dirname(fileURLToPath(import.meta.url)) + '/.n'\nlet n = 0\ntry { n = Number(readFileSync(c, 'utf8')) || 0 } catch {}\nwriteFileSync(c, String(n + 1))\nprocess.stdout.write(JSON.stringify({ score: n % 2 === 0 ? 100 : 0, critique: '', findings: [] }))\n"
const STABLE = "process.stdout.write(JSON.stringify({ score: 100, critique: '', findings: [] }))\n"
const STABLE_FAIL = "process.stdout.write(JSON.stringify({ score: 0, critique: '', findings: [] }))\n"

test('pruneFlaky end-to-end with REAL scorer subprocesses: retires flaky, keeps stable-pass AND stable-fail', async () => {
  const flaky = `node ${shq(writeScorer(FLAKY))}`
  const stable = `node ${shq(writeScorer(STABLE))}`
  const stableFail = `node ${shq(writeScorer(STABLE_FAIL))}`
  let store = emptyStore()
  store = addCheck(store, { cmd: flaky, target: 100 })
  store = addCheck(store, { cmd: stable, target: 100 })
  store = addCheck(store, { cmd: stableFail, target: 100 })
  const storePath = checkStorePath(mkdtempSync(join(tmpdir(), 'ps-')))
  saveStore(storePath, store)
  const good = join(mkdtempSync(join(tmpdir(), 'g-')), 'art.txt'); writeFileSync(good, 'x')

  const retired = await pruneFlaky({ storePath, goodArtifact: good, kind: 'file', runCheck: scorerRunCheck, replayRuns: 2 })
  assert.deepEqual(retired, [flaky]) // only the flaky one
  const active = listActiveChecks(loadStore(storePath), 'file').map((c) => c.cmd)
  assert.equal(active.includes(flaky), false) // flaky retired (self-heal)
  assert.ok(active.includes(stable)) // stable-pass kept
  assert.ok(active.includes(stableFail)) // stable-FAIL kept — ambiguous, stays operator-retired (4b)
})
