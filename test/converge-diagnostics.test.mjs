import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { plateaued, noTraction, heldOutFailingObjectives, recentRollbackObjectives, detectStructuralSignal } from '../src/converge-diagnostics.mjs'
import { runConverge } from '../src/converge.mjs'

// --- Inc 2: structural-feedback detector (pure helpers) ---

test('plateaued: true when the binding gains < minProgress over the window, false while still climbing', () => {
  assert.equal(plateaued([40, 40, 40, 40], 3, 1), true)
  assert.equal(plateaued([40, 50, 60, 70], 3, 1), false)
  assert.equal(plateaued([0, 0, 0], 3, 1), false) // needs window+1 readings
})

test('noTraction: true only when every recent binding reading sits at/below zero', () => {
  assert.equal(noTraction([0, 0, 0], 3, 0), true)
  assert.equal(noTraction([0, 0, 5], 3, 0), false)
  assert.equal(noTraction([0, 0], 3, 0), false) // needs `window` readings
})

test('heldOutFailingObjectives: a judge objective that passes visible but fails held-out', () => {
  const objs = [
    { id: 'a', judgeClass: true, primaryScore: 95, confirmScore: 40, target: 90 }, // visible pass, held-out fail
    { id: 'b', judgeClass: true, primaryScore: 95, confirmScore: 95, target: 90 }, // genuinely met
    { id: 'c', judgeClass: false, primaryScore: 95, confirmScore: null, target: 90 }, // deterministic -> not a held-out fail
  ]
  assert.deepEqual(heldOutFailingObjectives(objs).map((o) => o.id), ['a'])
})

test('recentRollbackObjectives: distinct objectives that rolled back within the window', () => {
  const rounds = [
    { objectiveId: 'a', accepted: true },
    { objectiveId: 'b', rolledBack: true },
    { objectiveId: 'a', rolledBack: true },
    { objectiveId: 'a', rolledBack: true },
  ]
  assert.deepEqual(recentRollbackObjectives(rounds, 3).sort(), ['a', 'b'])
  assert.deepEqual(recentRollbackObjectives(rounds, 1), ['a']) // only the last round
})

// --- the classifier ---

test('detectStructuralSignal: healthy climbing progress -> no signal', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [10, 40, 60, 80],
    objectives: [{ id: 'a', status: 'unmet', judgeClass: true, primaryScore: 80, confirmScore: 80, target: 90 }],
    rounds: [{ objectiveId: 'a', accepted: true }],
  }
  assert.equal(detectStructuralSignal(state).signal, null)
})

test('detectStructuralSignal: held_out_fail (visible passes, held-out fails) takes priority over a plateau', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [40, 40, 40, 40], // also plateaued
    objectives: [{ id: 'a', status: 'unmet', judgeClass: true, primaryScore: 95, confirmScore: 40, target: 90 }],
    rounds: [],
  }
  const r = detectStructuralSignal(state)
  assert.equal(r.signal, 'held_out_fail')
})

test('detectStructuralSignal: an Inc-1 winner-curse reject round is read as held_out_fail', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [50, 50],
    objectives: [{ id: 'a', status: 'unmet', judgeClass: true, primaryScore: 50, confirmScore: 50, target: 90 }],
    rounds: [{ objectiveId: 'a', accepted: false, structural_signal: 'held_out_no_progress' }],
  }
  assert.equal(detectStructuralSignal(state).signal, 'held_out_fail')
})

test('detectStructuralSignal: >=2 objectives rolling back -> contradiction', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [30, 30, 30, 30],
    objectives: [
      { id: 'a', status: 'unmet', judgeClass: false, primaryScore: 30, confirmScore: null, target: 90 },
      { id: 'b', status: 'unmet', judgeClass: false, primaryScore: 30, confirmScore: null, target: 90 },
    ],
    rounds: [{ objectiveId: 'a', rolledBack: true }, { objectiveId: 'b', rolledBack: true }],
  }
  assert.equal(detectStructuralSignal(state).signal, 'contradiction')
})

test('detectStructuralSignal: plateau + zero traction -> impossibility', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [0, 0, 0, 0],
    objectives: [{ id: 'a', status: 'unmet', judgeClass: false, primaryScore: 0, confirmScore: null, target: 90 }],
    rounds: [{ objectiveId: 'a', accepted: false }],
  }
  assert.equal(detectStructuralSignal(state).signal, 'impossibility')
})

test('detectStructuralSignal: plateau WITH traction (stuck above zero) -> plain plateau', () => {
  const state = {
    global_plateau_window: 3, global_min_progress: 1,
    binding_history: [40, 40, 40, 40],
    objectives: [{ id: 'a', status: 'unmet', judgeClass: false, primaryScore: 40, confirmScore: null, target: 90 }],
    rounds: [{ objectiveId: 'a', accepted: false }],
  }
  assert.equal(detectStructuralSignal(state).signal, 'plateau')
})

// --- observability: the signal is attached to the final state of a non-done converge run (no authority) ---

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-dsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-drepo-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

test('runConverge attaches a structural_signal to the final state of a non-done (capped) run', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0' })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 1e9, objective_cap: 2,
      objectives: [{ id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' }],
    }
    // a child that never moves the score (writes 0) -> plateau + zero traction -> capped with a signal
    const child = async (childCfg) => { writeFileSync(join(childCfg.scope, 'a/val.txt'), '0'); git(childCfg.scope, 'add', '-A'); git(childCfg.scope, 'commit', '-q', '--allow-empty', '-m', 'noop'); return { state: { spent_usd: 0, spent_tokens: 0 } } }
    const cfg = { scope, objectivesPath: join(sc.dir, 'objectives.json'), convergeDir: mkdtempSync(join(tmpdir(), 'whet-ddir-')), globalBudgetTokens: 1e9, globalCap: 4, globalStabilityRuns: 2, globalPlateauWindow: 3, globalMinProgress: 1, minDelta: 1, objectiveRetries: 3, model: 'sonnet', effort: 'medium', noEscalate: true }
    const { state, verdict } = await runConverge(cfg, manifest, { runChild: child, log: () => {} })
    assert.notEqual(verdict.status, 'done')
    assert.ok(['plateau', 'impossibility', 'held_out_fail', 'contradiction'].includes(state.structural_signal))
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
