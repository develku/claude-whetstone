import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planManifest, buildAllowlistMenu, computeEditableSurface } from '../src/plan.mjs'
import { loadPlanAllowlist } from '../src/plan-allowlist.mjs'
import { convergeRefusal } from '../src/converge-cli.mjs'

const allowlist = loadPlanAllowlist() // the real shipped data-only set ($0 dir read)
const stub = (objectives) => async () => ({ text: JSON.stringify({ objectives }) })

const baseCfg = {
  goal: 'raise coverage across the service',
  scopeDir: '/repo',
  floor: { cmd: 'npm test', readOnly: ['package.json'] },
  objectiveCap: 6,
  globalBudgetTokens: 4_000_000,
}
const repoFiles = ['src/auth/a.mjs', 'src/api/b.mjs', 'src/db/c.mjs', 'package.json']

const twoGood = [
  { id: 'auth', goal: 'auth cases', scorerId: 'io-assert', args: ['--case', 'a=>b'], editScope: 'src/auth', target: 85 },
  { id: 'api', goal: 'api cases', scorerId: 'contains', args: ['--needle', 'ok'], editScope: 'src/api', target: 80 },
]

test('planManifest: a clean stub plan yields a manifest that passes convergeRefusal VERBATIM', async () => {
  const r = await planManifest(baseCfg, { planCall: stub(twoGood), allowlist, repoFiles })
  assert.equal(r.manifest.objectives.length, 2)
  assert.equal(convergeRefusal({ scope: '/repo', manifest: r.manifest }), null) // the same gate an operator's manifest survives
  // scorers were CODE-constructed from the allowlist (model never emitted a command string)
  assert.match(r.manifest.objectives[0].scorer, /^node '.*io-assert\.mjs' /)
  assert.equal(r.manifest.objective_cap, 6)
  assert.equal(r.manifest.global_budget_tokens, 4_000_000)
})

test('planManifest: the report carries coverage + the unproven-sufficiency + the loud disclosures', async () => {
  const r = await planManifest(baseCfg, { planCall: stub(twoGood), allowlist, repoFiles })
  assert.equal(r.report.objectives_sufficiency, 'unproven')
  assert.equal(typeof r.report.coverage_score, 'number')
  // package.json (a floor read-only) is subtracted from the editable-surface denominator
  assert.equal(r.report.editable_surface_size, 3)
  assert.ok(r.report.disclosures.length >= 4)
})

test('planManifest: same goal + same stub reply => byte-identical manifest (deterministic; the prompt nonce does not leak in)', async () => {
  const a = await planManifest(baseCfg, { planCall: stub(twoGood), allowlist, repoFiles })
  const b = await planManifest(baseCfg, { planCall: stub(twoGood), allowlist, repoFiles })
  assert.deepEqual(a.manifest, b.manifest)
})

test('planManifest: a sub-floor target refuses the WHOLE run at the target guard (not silent-skip), exitCode 2', async () => {
  const mix = [
    { id: 'good', goal: 'x', scorerId: 'io-assert', args: [], editScope: 'src/good', target: 90 },
    { id: 'bad', goal: 'x', scorerId: 'io-assert', args: [], editScope: 'src/bad', target: 20 },
  ]
  await assert.rejects(planManifest(baseCfg, { planCall: stub(mix), allowlist, repoFiles }), (e) => e.exitCode === 2 && /target/.test(e.message))
})

test('planManifest: a traversal editScope is dropped by the fence; all-dropped => exit-2 refusal', async () => {
  const trav = [{ id: 't', goal: 'x', scorerId: 'io-assert', args: [], editScope: '../etc', target: 90 }]
  await assert.rejects(planManifest(baseCfg, { planCall: stub(trav), allowlist, repoFiles }), /dropped/i)
})

test('planManifest: a repo-root editScope is dropped by the fence', async () => {
  const root = [{ id: 'r', goal: 'x', scorerId: 'io-assert', args: [], editScope: '.', target: 90 }]
  await assert.rejects(planManifest(baseCfg, { planCall: stub(root), allowlist, repoFiles }), /dropped/i)
})

test('planManifest: a shell scorerId is dropped by the fence (not in the data-only allowlist)', async () => {
  const shell = [{ id: 's', goal: 'x', scorerId: 'test-pass-rate', args: ['--cmd', 'sh'], editScope: 'src/s', target: 90 }]
  await assert.rejects(planManifest(baseCfg, { planCall: stub(shell), allowlist, repoFiles }), /dropped/i)
})

test('planManifest: overlapping editScopes are caught by convergeRefusal (verbatim gate)', async () => {
  const overlap = [
    { id: 'a', goal: 'x', scorerId: 'io-assert', args: [], editScope: 'src/auth', target: 90 },
    { id: 'b', goal: 'x', scorerId: 'io-assert', args: [], editScope: 'src/auth/sub', target: 90 },
  ]
  await assert.rejects(planManifest(baseCfg, { planCall: stub(overlap), allowlist, repoFiles }), /overlap|disjoint/i)
})

test('planManifest: a non-JSON model reply throws with exitCode 2 (planner failure, the CLI/API contract)', async () => {
  await assert.rejects(planManifest(baseCfg, { planCall: async () => ({ text: 'I cannot help.' }), allowlist, repoFiles }), (e) => e.exitCode === 2 && /JSON/.test(e.message))
})

test('planManifest: a planCall that throws surfaces as an exitCode-2 planner failure (not an engine crash)', async () => {
  const boom = async () => { throw new Error('network down') }
  await assert.rejects(planManifest(baseCfg, { planCall: boom, allowlist, repoFiles }), (e) => e.exitCode === 2 && /planner call failed/.test(e.message))
})

test('planManifest: spend from the planCall is reported (token-primary)', async () => {
  const r = await planManifest(baseCfg, { planCall: async () => ({ text: JSON.stringify({ objectives: twoGood }), spentTokens: 1234, spentUsd: 0.05 }), allowlist, repoFiles })
  assert.equal(r.spentTokens, 1234)
  assert.equal(r.spentUsd, 0.05)
})

test('buildAllowlistMenu: lists every allowlisted id with a description', () => {
  const menu = buildAllowlistMenu(allowlist)
  assert.match(menu, /io-assert/)
  assert.match(menu, /contains/)
  assert.equal(menu.includes('test-pass-rate'), false) // shell scorers are not in the data-only menu
})

test('computeEditableSurface: subtracts globalReadOnly + test dirs from git ls-files', () => {
  const manifest = { floor: { cmd: 'npm test', readOnly: ['package.json'] }, objectives: [{ id: 'o', scorer: 'x', editScope: 'src/a', readOnly: ['src/a/fixtures'] }] }
  const surface = computeEditableSurface(['src/a/x.mjs', 'src/a/fixtures/f.json', 'package.json', 'test/t.mjs', 'src/b/y.mjs'], manifest, '/repo', ['test'])
  assert.deepEqual(surface.sort(), ['src/a/x.mjs', 'src/b/y.mjs'])
})
