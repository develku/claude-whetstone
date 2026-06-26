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
