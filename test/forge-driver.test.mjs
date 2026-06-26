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
