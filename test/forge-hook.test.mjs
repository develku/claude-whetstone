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
  const m = forgeAllowlist(['/a/contains.mjs', 'rel/io-assert.mjs'])
  assert.equal(m.get('contains'), '/a/contains.mjs')
  assert.match(m.get('io-assert'), /\/rel\/io-assert\.mjs$/)
})

test('forgeAllowlist excludes command-executing scorers (denylist)', () => {
  // A scorer whose contract is "run my argument" (--cmd via shell:true) turns shq-quoted data back
  // into code INSIDE the scorer, downstream of the Forge fence — so it must never be a proposable check.
  const m = forgeAllowlist(['/a/test-pass-rate.mjs', '/a/composite.mjs', '/a/io-assert.mjs'])
  assert.equal(m.has('test-pass-rate'), false)
  assert.equal(m.has('composite'), false)
  assert.equal(m.get('io-assert'), '/a/io-assert.mjs') // data-only behavioural check stays
})

test('forgeAllowlist denylist resists rename/case/extension dodges (normalization-mismatch bypass)', () => {
  // The original Phase A filter compared a single-extension-strip, case-preserving id against a
  // lowercase/extensionless Set — so these all slipped past and re-opened RCE-by-replay.
  const m = forgeAllowlist(['/a/composite.v2.mjs', '/a/Composite.mjs', '/a/composite', '/a/test-pass-rate.backup.mjs', '/a/io-assert.mjs'])
  assert.equal(m.has('composite.v2'), false)
  assert.equal(m.has('Composite'), false)
  assert.equal(m.has('composite'), false)
  assert.equal(m.has('test-pass-rate.backup'), false)
  assert.equal(m.get('io-assert'), '/a/io-assert.mjs') // the one safe scorer survives
})

test('forgeCatalog never advertises a denylisted scorer even if --scorer-allow names it', () => {
  const cat = forgeCatalog(forgeAllowlist(['/a/test-pass-rate.mjs', '/a/io-assert.mjs']))
  assert.equal(cat.find((c) => c.id === 'test-pass-rate'), undefined)
  assert.ok(cat.find((c) => c.id === 'io-assert'))
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
