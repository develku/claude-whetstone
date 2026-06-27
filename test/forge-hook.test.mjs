// test/forge-hook.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shq } from '../src/shq.mjs'
import { forgeShouldFire, forgeAllowlist, forgeCatalog, runForgeHook } from '../src/forge/hook.mjs'

const CONTENT_SCORER = `node ${shq(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/content-scorer.mjs'))} --needle FORGE_OK`

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

test('runForgeHook threads cfg.forgeOracleCmds and injects a corroborate fn (2a)', async () => {
  const state = {
    goal: 'g', artifact_path: '/run/final.txt', last_critique: '', confirm_vetoed_at_pass: 1,
    history: [{}, { snapshot: 'snapshots/iter_001.txt' }],
  }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: '/run/checks.json', scorerAllow: [], model: 'sonnet', forgeOracleCmds: ['node o1.mjs', 'node o2.mjs --x 1'] }
  let seen = null
  const runForge = async (args) => { seen = args; return { admitted: [], rejected: [], corroborated: true } }
  await runForgeHook({ cfg, state, loopDir: '/run' }, { runForge, generate: async () => ({}), admit: async () => ({}) })
  assert.deepEqual(seen.oracleCmds, ['node o1.mjs', 'node o2.mjs --x 1'])
  assert.equal(typeof seen.corroborate, 'function')
})

test('runForgeHook defaults oracleCmds to [] when cfg has none', async () => {
  const state = { goal: 'g', artifact_path: '/run/final.txt', last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: 'snapshots/iter_000.txt' }] }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: '/run/checks.json', scorerAllow: [], model: 'sonnet' }
  let seen = null
  await runForgeHook({ cfg, state, loopDir: '/run' }, { runForge: async (a) => { seen = a; return {} }, generate: async () => ({}), admit: async () => ({}) })
  assert.deepEqual(seen.oracleCmds, [])
})

test('runForgeHook skips pruneFlaky on a corroboration decline (corroborated:false), still prunes when corroborated', async () => {
  const state = { goal: 'g', artifact_path: '/run/final.txt', last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: 'snapshots/iter_000.txt' }] }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: '/run/checks.json', scorerAllow: [], model: 'sonnet' }

  // Decline: runForge returned corroborated:false (an oracle disputed the labelling). The run learned nothing,
  // so skip the store-maintenance prune too — consistent with scope-hook.mjs. (prune retires only NON-reproducible
  // checks, orthogonal to the dispute, so this is cost+consistency, not a correctness fix — see commit body.)
  let pruneCalls = 0
  await runForgeHook({ cfg, state, loopDir: '/run' }, {
    runForge: async () => ({ admitted: [], rejected: [], corroborated: false }),
    pruneFlaky: async () => { pruneCalls++; return [] },
    generate: async () => ({}), admit: async () => ({}),
  })
  assert.equal(pruneCalls, 0, 'pruneFlaky must NOT run when corroborated:false')

  // Corroborated (incl. the no --forge-oracle passthrough, which also returns corroborated:true): prune runs.
  let goodSeen = null
  await runForgeHook({ cfg, state, loopDir: '/run' }, {
    runForge: async () => ({ admitted: [], rejected: [], corroborated: true }),
    pruneFlaky: async (a) => { goodSeen = a.goodArtifact; return [] },
    generate: async () => ({}), admit: async () => ({}),
  })
  assert.equal(goodSeen, '/run/final.txt', 'pruneFlaky MUST run on the honest good when corroborated')
})

test('runForgeHook routes the admit seam to mutationAdmit when cfg.forgeMutationAdmit is set (item 1)', async () => {
  // No deps.admit override -> the REAL wiring selects the admit fn. mutationAdmit returns a `.mutation` field;
  // plain admitCheck never does — so the field's presence proves the route. good='FORGE_OK' has no mutable
  // site, so the neighbourhood is empty -> base verdict preserved (admit true) + a below-floor note.
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-mut-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'FORGE_OK')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'broken')
  const state = { goal: 'g', artifact_path: good, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: 'snap' }] }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: join(dir, 'checks.json'), scorerAllow: [], model: 'sonnet', forgeMutationAdmit: true, forgeOracleCmds: [CONTENT_SCORER] }
  let captured = null
  await runForgeHook({ cfg, state, loopDir: dir }, {
    goodArtifact: good, badArtifact: bad,
    generate: async () => ({ candidates: [], rejected: [] }),
    pruneFlaky: async () => [],
    runForge: async (args) => { captured = await args.admit({ candidateCmd: CONTENT_SCORER, goodArtifact: good, badArtifact: bad, replayRuns: 2 }); return { admitted: [], rejected: [], corroborated: true } },
  })
  assert.ok(captured.mutation, 'admit must be mutationAdmit (returns a .mutation field)')
  assert.equal(captured.admit, true)
  assert.equal(captured.mutation.confirmedMutants, 0)
})

test('runForgeHook routes the admit seam through admitSurvivesExploits when cfg.forgeExploitRegression is set (brick 1.5)', async () => {
  // admitSurvivesExploits returns an `.exploits` field; plain admitCheck does not. good='FORGE_OK' so the
  // candidate (contains --needle FORGE_OK) is admitted by base and survives the archive (no exploit contains it).
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-exp-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'FORGE_OK')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'broken')
  const state = { goal: 'g', artifact_path: good, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: 'snap' }] }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: join(dir, 'checks.json'), scorerAllow: [], model: 'sonnet', forgeExploitRegression: true }
  let captured = null
  await runForgeHook({ cfg, state, loopDir: dir }, {
    goodArtifact: good, badArtifact: bad,
    generate: async () => ({ candidates: [], rejected: [] }),
    pruneFlaky: async () => [],
    runForge: async (args) => { captured = await args.admit({ candidateCmd: CONTENT_SCORER, goodArtifact: good, badArtifact: bad, replayRuns: 2 }); return { admitted: [], rejected: [], corroborated: true } },
  })
  assert.ok(captured.exploits, 'admit must be admitSurvivesExploits (returns an .exploits field)')
  assert.equal(captured.admit, true)
  assert.equal(captured.exploits.fooledBy.length, 0)
})

test('runForgeHook uses plain admitCheck (no .mutation field) when forgeMutationAdmit is unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-hook-plain-'))
  const good = join(dir, 'good.txt'); writeFileSync(good, 'FORGE_OK')
  const bad = join(dir, 'bad.txt'); writeFileSync(bad, 'broken')
  const state = { goal: 'g', artifact_path: good, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: 'snap' }] }
  const cfg = { forge: true, confirmScorerCmd: 'x', forgeStorePath: join(dir, 'checks.json'), scorerAllow: [], model: 'sonnet' }
  let captured = null
  await runForgeHook({ cfg, state, loopDir: dir }, {
    goodArtifact: good, badArtifact: bad,
    generate: async () => ({ candidates: [], rejected: [] }),
    pruneFlaky: async () => [],
    runForge: async (args) => { captured = await args.admit({ candidateCmd: CONTENT_SCORER, goodArtifact: good, badArtifact: bad, replayRuns: 2 }); return { admitted: [], rejected: [], corroborated: true } },
  })
  assert.equal(captured.admit, true)
  assert.equal(captured.mutation, undefined, 'plain admitCheck returns no .mutation field')
})
