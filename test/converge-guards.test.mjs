import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateManifest,
  globalReadOnly,
  convergeNeedsGlobalBudget,
  convergeObjectivesNeedCap,
  convergeEditScopeOverlap,
  convergeJudgeObjectiveNeedsConfirm,
  manifestInsideScope,
  convergeUnsafeObjectiveScorer,
  manifestEditScopeReadOnlyCollision,
  convergeRefusal,
} from '../src/converge-cli.mjs'

// Track C refusal suite: the operator-owned manifest is the meta-gate, so EVERY unsafe shape must be
// refused at start (exit 2), not silently coerced. These mirror scope-cli's guard-suite-then-run shape.

function manifest(overrides = {}) {
  return {
    goal: 'raise the service',
    floor: { cmd: 'npm test', readOnly: ['package.json'] },
    global_budget_tokens: 4_000_000,
    objective_cap: 6,
    objectives: [
      { id: 'auth', goal: 'auth coverage', scorer: 'node /opt/whet/scorers/test-pass-rate.mjs --cmd cov', target: 90, editScope: 'src/auth' },
      { id: 'api', goal: 'api coverage', scorer: 'node /opt/whet/scorers/test-pass-rate.mjs --cmd cov', target: 85, editScope: 'src/api' },
    ],
    ...overrides,
  }
}
const cfg = (m, extra = {}) => ({ scope: '/repo', objectivesPath: '/elsewhere/objectives.json', manifest: m, ...extra })

// --- structural validation (absorbs convergeNeedsFloor + convergeObjectivesNeedEditScope) ---

test('validateManifest accepts a well-formed manifest', () => {
  assert.deepEqual(validateManifest(manifest()), [])
})

test('validateManifest requires a non-empty floor.cmd (the floor is mandatory)', () => {
  assert.ok(validateManifest(manifest({ floor: { readOnly: [] } })).some((e) => /floor\.cmd/.test(e)))
})

test('validateManifest requires every objective to declare an editScope (mandatory positive allowlist)', () => {
  const m = manifest()
  delete m.objectives[1].editScope
  assert.ok(validateManifest(m).some((e) => /editScope/.test(e)))
})

test('validateManifest rejects a non-numeric / out-of-range target', () => {
  const m = manifest()
  m.objectives[0].target = 140
  assert.ok(validateManifest(m).some((e) => /target/.test(e)))
})

test('validateManifest rejects duplicate objective ids', () => {
  const m = manifest()
  m.objectives[1].id = 'auth'
  assert.ok(validateManifest(m).some((e) => /duplicate/.test(e)))
})

test('validateManifest requires a non-empty objectives array', () => {
  assert.ok(validateManifest(manifest({ objectives: [] })).some((e) => /objectives/.test(e)))
})

// --- globalReadOnly construction (floor footprint + own readOnly + project-local scorer scripts) ---

test('globalReadOnly unions floor.readOnly, each objective readOnly, and project-local scorer scripts', () => {
  const m = manifest({
    floor: { cmd: 'npm test', readOnly: ['package.json', 'jest.config.js'] },
    objectives: [
      // a PROJECT-LOCAL scorer (resolves INSIDE the scope) must be auto-protected; an absolute whetstone
      // scorer (outside scope) must NOT be added.
      { id: 'a', goal: 'g', scorer: 'node test/score-a.mjs', target: 90, editScope: 'src/a', readOnly: ['test/fixtures-a'] },
    ],
  })
  const ro = globalReadOnly(m, '/repo')
  assert.ok(ro.includes('package.json'))
  assert.ok(ro.includes('jest.config.js'))
  assert.ok(ro.includes('test/fixtures-a'))
  assert.ok(ro.includes('test/score-a.mjs'))
})

test('globalReadOnly does NOT add an absolute (out-of-scope) scorer script', () => {
  const m = manifest({
    objectives: [{ id: 'a', goal: 'g', scorer: 'node /opt/whet/scorers/test-pass-rate.mjs --cmd x', target: 90, editScope: 'src/a' }],
  })
  const ro = globalReadOnly(m, '/repo')
  assert.ok(!ro.some((p) => p.includes('test-pass-rate')))
})

// --- refusal guards ---

test('convergeNeedsGlobalBudget refuses >=2 objectives with no global budget', () => {
  assert.ok(convergeNeedsGlobalBudget(cfg(manifest({ global_budget_tokens: undefined, global_budget_usd: undefined }))))
  assert.equal(convergeNeedsGlobalBudget(cfg(manifest())), null)
})

test('convergeObjectivesNeedCap refuses an objective with no cap and no objective_cap default', () => {
  const m = manifest({ objective_cap: undefined })
  assert.ok(convergeObjectivesNeedCap(cfg(m))) // neither objective has a cap
  m.objectives.forEach((o) => (o.cap = 4))
  assert.equal(convergeObjectivesNeedCap(cfg(m)), null)
})

test('convergeEditScopeOverlap refuses two objectives whose editScopes overlap (prefix trap aware)', () => {
  // identical
  assert.ok(convergeEditScopeOverlap(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/auth' },
    { id: 'b', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/auth' },
  ] }))))
  // nested (one inside the other)
  assert.ok(convergeEditScopeOverlap(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src' },
    { id: 'b', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/auth' },
  ] }))))
  // disjoint, but a prefix-trap pair that a naive startsWith would falsely flag
  assert.equal(convergeEditScopeOverlap(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/a' },
    { id: 'b', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/app' },
  ] }))), null)
})

test('convergeJudgeObjectiveNeedsConfirm refuses a judge-class objective with no confirmScorer', () => {
  // explicit flag
  assert.ok(convergeJudgeObjectiveNeedsConfirm(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'src/a', judgeClass: true },
  ] }))))
  // auto-detected via llm-judge in the scorer command
  assert.ok(convergeJudgeObjectiveNeedsConfirm(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node /opt/whet/scorers/llm-judge.mjs --rubric x', target: 90, editScope: 'src/a' },
  ] }))))
  // judge WITH a confirm -> ok
  assert.equal(convergeJudgeObjectiveNeedsConfirm(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node /opt/whet/scorers/llm-judge.mjs', confirmScorer: 'node held.mjs', target: 90, editScope: 'src/a' },
  ] }))), null)
})

test('manifestInsideScope refuses a manifest path under --scope', () => {
  assert.ok(manifestInsideScope(cfg(manifest(), { scope: '/repo', objectivesPath: '/repo/objectives.json' })))
  assert.equal(manifestInsideScope(cfg(manifest(), { scope: '/repo', objectivesPath: '/elsewhere/objectives.json' })), null)
  // prefix trap: /repo-other must NOT count as inside /repo
  assert.equal(manifestInsideScope(cfg(manifest(), { scope: '/repo', objectivesPath: '/repo-other/objectives.json' })), null)
})

test('convergeUnsafeObjectiveScorer refuses a scorer that resolves to composite/floor', () => {
  assert.ok(convergeUnsafeObjectiveScorer(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node /opt/whet/scorers/composite.mjs --scorers x', target: 90, editScope: 'src/a' },
  ] }))))
  assert.ok(convergeUnsafeObjectiveScorer(cfg(manifest({ objectives: [
    { id: 'a', goal: 'g', scorer: 'node ok.mjs', confirmScorer: 'node /opt/whet/scorers/floor.mjs --cmd x', target: 90, editScope: 'src/a' },
  ] }))))
  assert.equal(convergeUnsafeObjectiveScorer(cfg(manifest())), null)
})

test('manifestEditScopeReadOnlyCollision refuses an editScope that contains a gate/measurement file', () => {
  // floor footprint package.json placed inside an objective's editScope
  const m = manifest({
    floor: { cmd: 'npm test', readOnly: ['src/auth/package.json'] },
    objectives: [{ id: 'auth', goal: 'g', scorer: 'node /opt/whet/scorers/x.mjs', target: 90, editScope: 'src/auth' }],
    global_budget_tokens: 1,
  })
  assert.ok(manifestEditScopeReadOnlyCollision(cfg(m)))
  // a project-local scorer script inside the editScope it scores -> collision (the editor could game it)
  const m2 = manifest({
    objectives: [{ id: 'auth', goal: 'g', scorer: 'node src/auth/score.mjs', target: 90, editScope: 'src/auth' }],
    global_budget_tokens: 1,
  })
  assert.ok(manifestEditScopeReadOnlyCollision(cfg(m2)))
  // clean separation -> ok
  assert.equal(manifestEditScopeReadOnlyCollision(cfg(manifest())), null)
})

// --- the suite runner returns the FIRST refusal reason, or null ---

test('convergeRefusal returns null for a clean manifest+cfg', () => {
  assert.equal(convergeRefusal(cfg(manifest())), null)
})

test('convergeRefusal surfaces the first violation (e.g. missing global budget)', () => {
  const reason = convergeRefusal(cfg(manifest({ global_budget_tokens: undefined, global_budget_usd: undefined })))
  assert.ok(typeof reason === 'string' && reason.length > 0)
})
