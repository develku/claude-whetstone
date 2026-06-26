// test/forge-hook.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgeShouldFire, forgeAllowlist, forgeCatalog, runForgeHook } from '../src/forge/hook.mjs'

const CFG = { forge: true, confirmScorerCmd: 'x', forgeStorePath: '/s/checks.json' }
const DONE = { status: 'done' }
const RECOVERED = { confirm_vetoed_at_pass: 0 }

test('forgeShouldFire fires on a recovered-veto done with forge+confirm+store', () => {
  assert.equal(forgeShouldFire(CFG, RECOVERED, DONE), true)
})

test('forgeShouldFire is false when any condition is missing', () => {
  assert.equal(forgeShouldFire({ ...CFG, forge: false }, RECOVERED, DONE), false)
  assert.equal(forgeShouldFire(CFG, RECOVERED, { status: 'capped' }), false)
  assert.equal(forgeShouldFire(CFG, { confirm_vetoed_at_pass: null }, DONE), false)
  assert.equal(forgeShouldFire({ ...CFG, confirmScorerCmd: null }, RECOVERED, DONE), false)
  assert.equal(forgeShouldFire({ ...CFG, forgeStorePath: null }, RECOVERED, DONE), false)
})

test('forgeAllowlist maps each --scorer-allow path to basename->absolute', () => {
  const m = forgeAllowlist(['/a/contains.mjs', 'rel/test-pass-rate.mjs'])
  assert.equal(m.get('contains'), '/a/contains.mjs')
  assert.match(m.get('test-pass-rate'), /\/rel\/test-pass-rate\.mjs$/)
})

test('forgeCatalog lists allowlist ids with a usage hint (default empty)', () => {
  const cat = forgeCatalog(new Map([['contains', '/a/contains.mjs'], ['custom', '/a/custom.mjs']]))
  assert.match(cat.find((c) => c.id === 'contains').usage, /--needle/) // contains carries a usage hint
  assert.deepEqual(cat.find((c) => c.id === 'custom'), { id: 'custom', usage: '' }) // unknown id -> empty
})

test('runForgeHook sources good=final artifact + bad=vetoed snapshot and calls runForge', async () => {
  const state = {
    goal: 'g', artifact_path: '/run/final.txt', last_critique: 'gamed it', confirm_vetoed_at_pass: 2,
    history: [{}, {}, { snapshot: 'snapshots/iter_002.txt' }],
  }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: '/run/checks.json', scorerAllow: ['/a/contains.mjs'], model: 'sonnet' }
  let seen = null
  const runForge = async (args) => { seen = args; return { admitted: [], rejected: [] } }
  await runForgeHook({ cfg, state, loopDir: '/run' }, { runForge, generate: async () => ({}), admit: async () => ({}) })
  assert.equal(seen.goodArtifact, '/run/final.txt')
  assert.match(seen.badArtifact, /snapshots\/iter_002\.txt$/)
  assert.equal(seen.storePath, '/run/checks.json')
  assert.equal(seen.allowlist.get('contains'), '/a/contains.mjs')
  assert.equal(seen.critique, 'gamed it')
})
