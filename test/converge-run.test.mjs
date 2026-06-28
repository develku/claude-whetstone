import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runConverge } from '../src/converge.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

// A scorer that reads a file (its first positional arg) from cwd and emits it as the score.
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-csc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}

// A repo with two objective files seeded to `seed` each.
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-crun-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

function baseCfg(scope, scorerDir, overrides = {}) {
  return {
    scope,
    objectivesPath: join(scorerDir, 'objectives.json'), // outside scope
    convergeDir: mkdtempSync(join(tmpdir(), 'whet-cdir-')),
    globalBudgetTokens: 100_000_000,
    globalCap: 12,
    globalStabilityRuns: 2,
    globalPlateauWindow: 3,
    globalMinProgress: 1,
    minDelta: 1,
    objectiveRetries: 1,
    model: 'sonnet',
    effort: 'medium',
    noEscalate: true,
    ...overrides,
  }
}

// stub child: writes `${editScope}/<file>` to the target and commits IN the worktree (childCfg.scope = wt).
// `plan` maps an objective editScope to the files+values its child writes (to model honest vs regressing edits).
function makeStubChild(plan, spend = { spent_usd: 0.01, spent_tokens: 1000 }) {
  return async (childCfg) => {
    const wt = childCfg.scope
    for (const [rel, val] of Object.entries(plan[childCfg.editScope] ?? {})) {
      mkdirSync(join(wt, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
      writeFileSync(join(wt, rel), String(val))
    }
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '--allow-empty', '-m', `child ${childCfg.editScope}`)
    return { state: spend }
  }
}

test('runConverge drives two objectives to done and leaves both at target on the converged tree', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  try {
    const manifest = {
      goal: 'raise both',
      floor: { cmd: 'true' },
      global_budget_tokens: 100_000_000,
      objective_cap: 4,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const { state, verdict } = await runConverge(baseCfg(scope, sc.dir), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    assert.match(verdict.reason, /DECLARED/)
    assert.ok(state.objectives.every((o) => o.met))
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.equal(readFileSync(join(scope, 'b/val.txt'), 'utf8'), '100')
    assert.equal(state.objectives_sufficiency, 'unproven') // honesty constant holds on the done path
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge ROLLS BACK a cross-file regression: an in-scope edit that breaks a sibling is reverted', async () => {
  const sc = writeScorer()
  // objective A depends on b/api.txt (a real cross-file dependency); B owns the whole b/ scope.
  const scope = tempRepo({ 'b/api.txt': '95', 'b/feature.txt': '0' })
  try {
    const manifest = {
      goal: 'raise b without breaking a',
      floor: { cmd: 'true' },
      global_budget_tokens: 100_000_000,
      objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'keep api', scorer: `node ${sc.path} b/api.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'ship feature', scorer: `node ${sc.path} b/feature.txt`, target: 90, editScope: 'b' },
      ],
    }
    // B's child ships its feature (100) but BREAKS the shared api (10) — both edits are inside b/ (in scope)
    const child = makeStubChild({ b: { 'b/feature.txt': 100, 'b/api.txt': 10 } })
    const baseline = git(scope, 'rev-parse', 'HEAD')
    const { state, verdict } = await runConverge(baseCfg(scope, sc.dir, { objectiveRetries: 1 }), manifest, { runChild: child, log: () => {} })
    // A was met at baseline (95); B's integration regressed it to 10 -> rolled back every attempt -> B skipped -> capped
    assert.equal(verdict.status, 'capped')
    assert.equal(readFileSync(join(scope, 'b/api.txt'), 'utf8'), '95') // the regression was rolled back, api intact
    assert.equal(git(scope, 'rev-parse', 'HEAD'), baseline) // last-good never advanced
    assert.equal(state.objectives.find((o) => o.id === 'b').status, 'skipped') // exhausted retries
    assert.ok(state.rounds.some((r) => r.rolledBack)) // a rollback was recorded
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge reports BLOCKED when the deterministic floor fails at baseline', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0' })
  try {
    const manifest = {
      goal: 'g',
      floor: { cmd: 'false' }, // the floor never passes
      global_budget_tokens: 100_000_000,
      objective_cap: 3,
      objectives: [{ id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' }],
    }
    const { verdict } = await runConverge(baseCfg(scope, sc.dir), manifest, { runChild: makeStubChild({ a: { 'a/val.txt': 100 } }), log: () => {} })
    assert.equal(verdict.status, 'blocked')
    assert.match(verdict.reason, /floor failed at baseline/)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge caps when the global budget cannot fund another objective pass (pre-launch reservation)', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  try {
    const manifest = {
      goal: 'g',
      floor: { cmd: 'true' },
      global_budget_tokens: 100, // far below one pass
      objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    let childCalls = 0
    const child = async (cfg) => { childCalls++; return makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })(cfg) }
    const { verdict } = await runConverge(baseCfg(scope, sc.dir, { globalBudgetTokens: 100 }), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'capped')
    assert.match(verdict.reason, /budget/)
    assert.equal(childCalls, 0) // never launched a paid objective it couldn't afford
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge WITHHOLDS done when the global stability re-measure does not reproduce', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0' })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [{ id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' }],
    }
    // injected reMeasure by call order: #1 baseline (unmet 50 -> the loop runs), #2 post-integration
    // (met 95 -> the gate reaches done), #3+ stability re-runs (unmet 50 -> the win does NOT reproduce).
    let n = 0
    const flakyReMeasure = (_scopeDir, _sha, objectives) => {
      n += 1
      const score = n === 2 ? 95 : 50
      return { floor: { score: 100, replicas: 1 }, vector: objectives.map((o) => ({ id: o.id, primaryScore: score, confirmScore: null, critique: '' })), blocked: false }
    }
    const child = makeStubChild({ a: { 'a/val.txt': 100 } })
    const { verdict } = await runConverge(baseCfg(scope, sc.dir), manifest, { runChild: child, reMeasure: flakyReMeasure, log: () => {} })
    assert.equal(verdict.status, 'capped')
    assert.match(verdict.reason, /stability/)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
