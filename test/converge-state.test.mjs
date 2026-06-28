import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initConvergeState,
  saveConvergeState,
  loadConvergeState,
  ensureConvergeDir,
  globalBudgetExhausted,
  OBJECTIVES_SUFFICIENCY,
  LAST_GOOD_REF,
} from '../src/converge-state.mjs'

function fixture() {
  const manifest = {
    goal: 'raise the service',
    floor: { cmd: 'npm test', readOnly: ['package.json'] },
    global_budget_tokens: 4_000_000,
    objective_cap: 6,
    objectives: [
      { id: 'auth', goal: 'auth coverage', scorer: 'node test/cov-auth.mjs', target: 90, editScope: 'src/auth', readOnly: ['test/auth'] },
      { id: 'review', goal: 'review quality', scorer: 'node /opt/whet/scorers/llm-judge.mjs', confirmScorer: 'node held.mjs', target: 80, editScope: 'src/review', cap: 4 },
    ],
  }
  const cfg = { scope: '/repo', objectivesPath: '/elsewhere/objectives.json', globalBudgetTokens: 4_000_000, globalCap: 20 }
  return { manifest, cfg }
}

test('initConvergeState stamps the honesty constants on the fresh state', () => {
  const { manifest, cfg } = fixture()
  const s = initConvergeState(cfg, manifest)
  assert.equal(s.objectives_sufficiency, OBJECTIVES_SUFFICIENCY)
  assert.equal(s.objectives_sufficiency, 'unproven')
  assert.equal(s.coverage_score, null)
  assert.equal(s.objectives_source, 'operator-manifest')
  assert.equal(s.last_good_ref, LAST_GOOD_REF)
  assert.equal(s.last_good_sha, null)
})

test('initConvergeState carries the floor block and starts it unscored', () => {
  const { manifest, cfg } = fixture()
  const s = initConvergeState(cfg, manifest)
  assert.equal(s.floor.cmd, 'npm test')
  assert.deepEqual(s.floor.readOnly, ['package.json'])
  assert.equal(s.floor.last_score, null)
})

test('initConvergeState projects each objective, resolves cap, and auto-detects judge-class', () => {
  const { manifest, cfg } = fixture()
  const s = initConvergeState(cfg, manifest)
  assert.equal(s.objectives.length, 2)
  const auth = s.objectives.find((o) => o.id === 'auth')
  const review = s.objectives.find((o) => o.id === 'review')
  assert.equal(auth.cap, 6) // inherits objective_cap default
  assert.equal(auth.judgeClass, false) // a deterministic scorer
  assert.equal(auth.status, 'unmet')
  assert.equal(auth.met, false)
  assert.equal(review.cap, 4) // own cap overrides the default
  assert.equal(review.judgeClass, true) // auto-detected via llm-judge in the scorer
})

test('initConvergeState seeds the global counters and budget from cfg', () => {
  const { manifest, cfg } = fixture()
  const s = initConvergeState(cfg, manifest)
  assert.equal(s.global_pass, 0)
  assert.equal(s.cycle, 0)
  assert.equal(s.spent_tokens, 0)
  assert.equal(s.global_budget_tokens, 4_000_000)
  assert.equal(s.global_cap, 20)
  assert.deepEqual(s.rounds, [])
  assert.deepEqual(s.binding_history, [])
})

test('ensureConvergeDir creates the dir with a self-ignoring .gitignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converge-'))
  ensureConvergeDir(dir)
  assert.ok(existsSync(join(dir, '.gitignore')))
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\*/)
})

test('save then load round-trips the converge state', () => {
  const { manifest, cfg } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'converge-'))
  ensureConvergeDir(dir)
  const s = initConvergeState(cfg, manifest)
  saveConvergeState(dir, s)
  const loaded = loadConvergeState(dir)
  assert.equal(loaded.goal, s.goal)
  assert.equal(loaded.objectives_sufficiency, 'unproven')
  assert.equal(loaded.objectives.length, 2)
  assert.equal(loaded.objectives[1].judgeClass, true)
})

test('globalBudgetExhausted reports when cumulative spend exceeds the pool, else null', () => {
  assert.equal(globalBudgetExhausted({ global_budget_tokens: 1000, spent_tokens: 500 }), null)
  assert.ok(globalBudgetExhausted({ global_budget_tokens: 1000, spent_tokens: 1500 }))
  assert.ok(globalBudgetExhausted({ global_budget_usd: 2, spent_usd: 3 }))
  assert.equal(globalBudgetExhausted({ global_budget_usd: null, global_budget_tokens: null, spent_tokens: 9e9 }), null)
})
