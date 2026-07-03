// test/forge-driver.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFromConfig, parseCli } from '../src/driver.mjs'
import { recordPass } from '../src/state.mjs'

test('parseCli parses --forge / --forge-store / --scorer-allow', () => {
  const cfg = parseCli(['node', 'driver.mjs', 'goal', '--artifact', 'a', '--scorer', 's', '--forge', '--forge-store', '/c.json', '--scorer-allow', '/a/x.mjs,/a/y.mjs'])
  assert.equal(cfg.forge, true)
  assert.equal(cfg.forgeStorePath, '/c.json')
  assert.deepEqual(cfg.scorerAllow, ['/a/x.mjs', '/a/y.mjs'])
})

test('parseCli collects REPEATABLE --forge-oracle into an array (defaults to [])', () => {
  // oracle values are full scorer command strings (commas/spaces), so they must REPEAT, not comma-split.
  const cfg = parseCli(['node', 'driver.mjs', 'g', '--artifact', 'a', '--scorer', 's', '--forge-oracle', 'node o1.mjs --needle Z', '--forge-oracle', 'node o2.mjs'])
  assert.deepEqual(cfg.forgeOracleCmds, ['node o1.mjs --needle Z', 'node o2.mjs'])
  assert.deepEqual(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'a', '--scorer', 's']).forgeOracleCmds, [])
})

// A stubbed run that goes done at baseline, gets vetoed once by confirm, then confirms on the next pass.
const recoverRun = (loopDir, extra) => {
  let confirmCalls = 0
  const deps = {
    buildContext: () => ({
      evaluate: async () => ({ score: 100, critique: '', review: { score: 100, critique: '' } }),
      persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: 'snapshots/iter_000.txt', reviewRef: 'r', costUsd: 0, tokens: 0 }),
      confirm: async () => ({ score: confirmCalls++ === 0 ? 0 : 100, critique: 'c' }),
    }),
    act: async () => ({ changed: true, costUsd: 0, tokens: 0 }),
    log: () => {},
    ...extra,
  }
  return runFromConfig({ goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'c', targetScore: 90, hardCap: 5, loopDir, forge: true, forgeStorePath: join(loopDir, 'checks.json'), scorerAllow: [] }, deps)
}

test('runPrepared fires the Forge hook on a recovered-veto done when --forge is set', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-'))
  let fired = null
  await recoverRun(loopDir, { runForgeHook: async ({ state }) => { fired = state.confirm_vetoed_at_pass } })
  assert.equal(fired, 0)
})

test('a THROWING Forge hook does NOT fail an already-successful run (fail-safe) and logs forge-error', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-'))
  const events = []
  const { verdict } = await recoverRun(loopDir, {
    runForgeHook: async () => { throw new Error('boom') },
    log: (e) => events.push(e),
  })
  assert.equal(verdict.status, 'done') // the paid, completed run still succeeds
  const fe = events.find((e) => e.status === 'forge-error')
  assert.ok(fe && /boom/.test(fe.reason))
})

test('runPrepared logs forge-declined (not forge) when the hook returns corroborated:false', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-'))
  const events = []
  await recoverRun(loopDir, {
    runForgeHook: async () => ({ admitted: [], rejected: [], conflicts: [{ oracleCmd: 'o', reason: 'disputed' }], excluded: [], corroborated: false }),
    log: (e) => events.push(e),
  })
  assert.ok(events.find((e) => e.status === 'forge-declined'), 'a corroboration decline is logged distinctly')
  assert.equal(events.find((e) => e.status === 'forge'), undefined) // not mislabeled as a normal learn
})

test('runPrepared does NOT fire the Forge hook without --forge', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-'))
  let fired = false
  let confirmCalls = 0
  await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'c', targetScore: 90, hardCap: 5, loopDir, forge: false },
    { buildContext: () => ({ evaluate: async () => ({ score: 100, critique: '', review: {} }), persist: (s, ev) => recordPass(s, { score: ev.score, snapshot: 'x', reviewRef: 'r' }), confirm: async () => ({ score: confirmCalls++ === 0 ? 0 : 100, critique: 'c' }) }), act: async () => ({ changed: true }), log: () => {}, runForgeHook: async () => { fired = true } },
  )
  assert.equal(fired, false)
})

// --- easy-done fire site (v1.8.0) ------------------------------------------------------------------
// An unwired 1-edit done (the thinScorerWarning condition) fires the forge with trigger 'easy-done';
// bad = baseline snapshot. Provenance lands in the forge log reason. Fail-safe like the veto trigger.
const easyRun = (loopDir, extra) => {
  let pass = 0
  const deps = {
    buildContext: () => ({
      evaluate: async () => {
        const score = pass++ === 0 ? 50 : 100 // baseline below target, one edit to done
        return { score, critique: 'c', review: { score, critique: 'c' } }
      },
      persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: `snapshots/iter_00${s.history.length}.txt`, reviewRef: 'r' }),
      confirm: async () => { throw new Error('unwired run must never call confirm') },
    }),
    act: async () => ({ changed: true, costUsd: 0, tokens: 0 }),
    log: () => {},
    ...extra,
  }
  // NO confirmScorerCmd — the unwired done-edge is the trigger condition
  return runFromConfig({ goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', targetScore: 90, hardCap: 5, loopDir, forge: true, forgeStorePath: join(loopDir, 'checks.json'), scorerAllow: [] }, deps)
}

test('runPrepared fires the Forge hook with trigger easy-done on an unwired 1-edit done', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-easy-'))
  let seen = null
  const events = []
  await easyRun(loopDir, {
    runForgeHook: async ({ trigger }) => { seen = trigger; return { admitted: [], rejected: [] } },
    log: (e) => events.push(e),
  })
  assert.equal(seen, 'easy-done')
  const f = events.find((e) => e.status === 'forge')
  assert.ok(f && /\(easy-done\)/.test(f.reason), 'forge log carries the trigger provenance')
})

test('runPrepared does NOT fire easy-done on a 0-edit baseline done (no good/bad pair)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-easy0-'))
  let fired = false
  await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', targetScore: 90, hardCap: 5, loopDir, forge: true, forgeStorePath: join(loopDir, 'checks.json'), scorerAllow: [] },
    {
      buildContext: () => ({
        evaluate: async () => ({ score: 100, critique: '', review: { score: 100, critique: '' } }),
        persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: 'snapshots/iter_000.txt', reviewRef: 'r' }),
        confirm: async () => ({ score: 100, critique: '' }),
      }),
      act: async () => ({ changed: true }),
      log: () => {},
      runForgeHook: async () => { fired = true },
    },
  )
  assert.equal(fired, false)
})

test('a THROWING easy-done hook still returns done (fail-safe) and names the trigger in forge-error', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-easyboom-'))
  const events = []
  const { verdict } = await easyRun(loopDir, {
    runForgeHook: async () => { throw new Error('boom') },
    log: (e) => events.push(e),
  })
  assert.equal(verdict.status, 'done')
  const fe = events.find((e) => e.status === 'forge-error')
  assert.ok(fe && /easy-done: boom/.test(fe.reason))
})

test('a recovered-veto done still fires with trigger recovered-veto, exactly once (provenance regression)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-drv-prov-'))
  const triggers = []
  const events = []
  await recoverRun(loopDir, {
    runForgeHook: async ({ trigger }) => { triggers.push(trigger); return { admitted: [], rejected: [] } },
    log: (e) => events.push(e),
  })
  assert.deepEqual(triggers, ['recovered-veto'])
  assert.ok(events.find((e) => e.status === 'forge' && /\(recovered-veto\)/.test(e.reason)))
})
