import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runConvergeParallel, convergeRoundParallel } from '../src/converge-parallel.mjs'
import { setupConvergeRun, reMeasureAll } from '../src/converge.mjs'
import { loadConvergeState } from '../src/converge-state.mjs'
import { globalVerdict } from '../src/converge-gate.mjs'

// Track B inc 4 — the CONCURRENT round: reserve → fan-out children → squash-merge survivors → the IDENTICAL
// single-writer gate → accept / whole-batch-rollback+quarantine+fallback. Real-git Tier-2 with stub children.

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

// A scorer that reads its first positional file from cwd and emits it as the score.
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-psc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-prun-'))
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
    objectivesPath: join(scorerDir, 'objectives.json'),
    convergeDir: mkdtempSync(join(tmpdir(), 'whet-pdir-')),
    globalBudgetTokens: 100_000_000,
    globalCap: 12,
    globalStabilityRuns: 2,
    globalPlateauWindow: 3,
    globalMinProgress: 1,
    minDelta: 1,
    objectiveRetries: 1,
    maxParallel: 2,
    maxBatchRegressions: 2,
    flakeCap: 3,
    childTimeoutMs: 5000,
    model: 'sonnet',
    effort: 'medium',
    noEscalate: true,
    ...overrides,
  }
}

// stub child: writes the plan's files for its editScope into its worktree and commits there. `plan` maps an
// objective editScope -> the files+values its child writes.
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

// setupConvergeRun gives a baseline-measured state + globalRO so a SINGLE round can be exercised in isolation.
function baseline(scope, manifest, cfg, deps = {}) {
  const { state, globalRO, blockedVerdict } = setupConvergeRun(cfg, manifest, scope, { runChild: () => {}, log: () => {}, ...deps })
  assert.equal(blockedVerdict, null, 'baseline floor should pass')
  return { state, globalRO }
}

// --- happy path (e2e): a batch of two disjoint objectives both succeed -> ONE merged accept -> done ---

test('runConvergeParallel converges two disjoint objectives in ONE batch round to done', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  try {
    const manifest = {
      goal: 'raise both', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 4,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const { state, verdict } = await runConvergeParallel(baseCfg(scope, sc.dir), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    assert.ok(state.objectives.every((o) => o.met))
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.equal(readFileSync(join(scope, 'b/val.txt'), 'utf8'), '100')
    // exactly ONE batch round merged both objectives
    const batches = state.rounds.filter((r) => r.kind === 'batch' && r.accepted)
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0].survivors.sort(), ['a', 'b'])
    assert.equal(git(scope, 'rev-parse', 'HEAD'), state.last_good_sha)
    assert.equal(state.objectives_sufficiency, 'unproven')
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- single-round whole-batch rollback: the merged candidate regresses a third (met) objective ---

function rollbackManifest(sc) {
  // C is met at baseline (reads a/api seeded 95); A's child ships a/feature(100) but BREAKS a/api(10) -> C
  // regresses on the merged candidate -> whole-batch rollback (B is collateral).
  return {
    goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
    objectives: [
      { id: 'a', goal: 'ship a', scorer: `node ${sc.path} a/feature.txt`, target: 90, editScope: 'a' },
      { id: 'b', goal: 'ship b', scorer: `node ${sc.path} b/feature.txt`, target: 90, editScope: 'b' },
      { id: 'c', goal: 'keep api', scorer: `node ${sc.path} a/api.txt`, target: 90, editScope: 'c' },
    ],
  }
}

test('convergeRoundParallel rolls back the WHOLE batch when the merge regresses a met objective + quarantines + pins sequential', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/feature.txt': '0', 'b/feature.txt': '0', 'a/api.txt': '95', 'c/x.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2 })
  try {
    const manifest = rollbackManifest(sc)
    const { state, globalRO } = baseline(scope, manifest, cfg)
    const lastGood = state.last_good_sha
    const child = makeStubChild({ a: { 'a/feature.txt': 100, 'a/api.txt': 10 }, b: { 'b/feature.txt': 100 } })
    const v = await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })

    assert.equal(state.last_good_sha, lastGood) // never advanced
    assert.equal(readFileSync(join(scope, 'a/api.txt'), 'utf8'), '95') // rollback restored the api
    assert.throws(() => git(scope, 'rev-parse', '--verify', 'whetstone/converge-candidate')) // candidate pin cleaned
    assert.equal(state.sequential_fallback_round, state.cycle) // next round pinned sequential
    assert.equal(state.consecutive_batch_regressions, 1)
    assert.deepEqual([...state.quarantined_batches[0]].sort(), ['a', 'b'])
    const last = state.rounds.at(-1)
    assert.equal(last.kind, 'batch'); assert.equal(last.accepted, false); assert.equal(last.rolledBack, true)
    assert.equal(last.veto_cause, 'cross-file-batch')
    assert.deepEqual(last.survivors.sort(), ['a', 'b'])
    assert.equal(state.objectives.find((o) => o.id === 'a').attempts, 1) // they RAN
    assert.equal(state.objectives.find((o) => o.id === 'b').attempts, 1)
    assert.equal(v.status, 'running') // A,B still unmet -> keep going (sequentially next)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('convergeRoundParallel charges spend for EVERY child even on a whole-batch rollback; reserved released to 0', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/feature.txt': '0', 'b/feature.txt': '0', 'a/api.txt': '95', 'c/x.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2 })
  try {
    const { state, globalRO } = baseline(scope, rollbackManifest(sc), cfg)
    const child = makeStubChild({ a: { 'a/feature.txt': 100, 'a/api.txt': 10 }, b: { 'b/feature.txt': 100 } }, { spent_usd: 0.02, spent_tokens: 1000 })
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    assert.equal(state.spent_tokens, 2000) // both children charged despite the rollback
    assert.equal(state.reserved_tokens, 0) // the batch reservation was released
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('convergeRoundParallel flips parallel_disabled after maxBatchRegressions consecutive batch regressions', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/feature.txt': '0', 'b/feature.txt': '0', 'a/api.txt': '95', 'c/x.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2, maxBatchRegressions: 1 })
  try {
    const { state, globalRO } = baseline(scope, rollbackManifest(sc), cfg)
    const child = makeStubChild({ a: { 'a/feature.txt': 100, 'a/api.txt': 10 }, b: { 'b/feature.txt': 100 } })
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    assert.equal(state.parallel_disabled, true) // one strike with the cap at 1
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- survivor integration: a crashed child does not block the batch; the survivors still merge ---

function threeObjManifest(sc) {
  return {
    goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
    objectives: [
      { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
      { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      { id: 'c', goal: 'raise c', scorer: `node ${sc.path} c/val.txt`, target: 90, editScope: 'c' },
    ],
  }
}

test('convergeRoundParallel integrates the survivors when one child CRASHES; the crash bumps flakes not attempts', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0', 'c/val.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 3 })
  try {
    const { state, globalRO } = baseline(scope, threeObjManifest(sc), cfg)
    const honest = makeStubChild({ a: { 'a/val.txt': 100 }, c: { 'c/val.txt': 100 } })
    const child = async (childCfg) => {
      if (childCfg.editScope === 'b') throw new Error('child b crashed')
      return honest(childCfg)
    }
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    const a = state.objectives.find((o) => o.id === 'a')
    const b = state.objectives.find((o) => o.id === 'b')
    const c = state.objectives.find((o) => o.id === 'c')
    assert.equal(a.met, true); assert.equal(c.met, true) // survivors integrated
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.equal(readFileSync(join(scope, 'c/val.txt'), 'utf8'), '100')
    assert.equal(b.flakes, 1) // crash counted as a flake
    assert.equal(b.attempts, 0) // a crash does NOT bump attempts (it never really ran)
    assert.equal(a.attempts, 1); assert.equal(c.attempts, 1)
    assert.equal(b.status, 'unmet') // re-queued
    const last = state.rounds.at(-1)
    assert.equal(last.accepted, true)
    assert.deepEqual(last.survivors.sort(), ['a', 'c'])
    assert.deepEqual(last.failed, ['b'])
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('convergeRoundParallel drops a HUNG child (timeout) and proceeds with the survivor', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2, childTimeoutMs: 200 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const { state, globalRO } = baseline(scope, manifest, cfg)
    const honest = makeStubChild({ a: { 'a/val.txt': 100 } })
    let killed = null
    const child = async (childCfg) => {
      if (childCfg.editScope === 'b') return new Promise(() => {}) // never settles
      return honest(childCfg)
    }
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, killChild: (id) => { killed = id }, log: () => {} })
    const a = state.objectives.find((o) => o.id === 'a')
    const b = state.objectives.find((o) => o.id === 'b')
    assert.equal(a.met, true) // the survivor merged
    assert.equal(b.flakes, 1) // the hung child is a flake
    assert.equal(b.attempts, 0)
    assert.equal(killed, 'b') // the SIGKILL hook fired for the hung objective
    assert.deepEqual(state.rounds.at(-1).failed, ['b'])
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- GATE-IDENTITY: the merged sha gated by the round === a direct sequential reMeasureAll/globalVerdict ---

test('convergeRoundParallel gate is byte-identical to a direct sequential reMeasureAll/globalVerdict on the merged sha', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const { state, globalRO } = baseline(scope, manifest, cfg)
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    const merged = state.rounds.at(-1).merged_sha
    assert.ok(merged)
    // independent sequential gate on the SAME sha must reproduce the round's accept (both met, floor held)
    const rm = reMeasureAll(scope, merged, state.objectives, state.floor)
    assert.equal(rm.blocked, false)
    assert.equal(rm.floor.score, 100)
    assert.ok(rm.vector.every((v) => v.primaryScore === 100))
    // the round APPLIED that vector -> the objectives are met, the gate says done — identical verdict
    assert.ok(state.objectives.every((o) => o.met))
    assert.equal(globalVerdict(state).status, 'done')
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- degeneracy: K=1 falls to the sequential gate path (runOneObjective), K=0 caps ---

test('convergeRoundParallel runs a width-1 batch via the SEQUENTIAL path (single-objective round, no merge)', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '100' }) // b already met -> only a is unmet
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const { state, globalRO } = baseline(scope, manifest, cfg)
    const child = makeStubChild({ a: { 'a/val.txt': 100 } })
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    const last = state.rounds.at(-1)
    assert.notEqual(last.kind, 'batch') // a single-objective (sequential) round record, NOT a merge
    assert.equal(last.objectiveId, 'a')
    assert.equal(last.accepted, true)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('convergeRoundParallel caps when the global budget cannot fund even one child of the batch', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2, globalBudgetTokens: 100 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const { state, globalRO } = baseline(scope, manifest, cfg)
    let launched = 0
    const child = async (c) => { launched++; return makeStubChild({ a: { 'a/val.txt': 100 } })(c) }
    const v = await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    assert.equal(v.status, 'capped')
    assert.match(v.reason, /budget/)
    assert.equal(launched, 0) // never launched a child it couldn't afford
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- write-intent-before-act: the inflight SET is persisted BEFORE any child spawns ---

test('convergeRoundParallel writes the inflight SET to disk BEFORE spawning, and clears it after', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
      ],
    }
    const { state, globalRO } = baseline(scope, manifest, cfg)
    let seen = null
    const honest = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const child = async (c) => { if (!seen) seen = loadConvergeState(cfg.convergeDir).inflight; return honest(c) }
    await convergeRoundParallel(state, cfg, scope, globalRO, { runChild: child, log: () => {} })
    assert.ok(Array.isArray(seen)) // inflight was a SET on disk when the first child ran
    assert.deepEqual(seen.map((x) => x.objectiveId).sort(), ['a', 'b'])
    assert.equal(state.inflight, null) // cleared after the round
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- combination-only regression TERMINATES (no infinite ping-pong) ---

test('runConvergeParallel TERMINATES when A,B pass alone but A+B together regress a third objective', async () => {
  // C is met unless BOTH a and b are "set"; A+B together flip it to 0. The batch regresses -> quarantine +
  // sequential fallback; the second sequential integration (B on top of A) re-triggers C and rolls B back ->
  // B skips -> capped. The run must terminate, never loop past the global cap doing zero net work.
  const sc = writeScorer()
  const comboDir = mkdtempSync(join(tmpdir(), 'whet-combo-'))
  const comboPath = join(comboDir, 'combo.mjs')
  writeFileSync(comboPath, "import { readFileSync } from 'node:fs'\nconst r = (f) => { try { return readFileSync(f, 'utf8').trim() } catch { return '0' } }\nconst both = r('a/val.txt') !== '0' && r('b/val.txt') !== '0'\nprocess.stdout.write(JSON.stringify({ score: both ? 0 : 100, critique: 'C breaks if both a and b set' }))\n")
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0', 'c/x.txt': '0' })
  const cfg = baseCfg(scope, sc.dir, { maxParallel: 2, globalCap: 10, objectiveRetries: 1 })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
      objectives: [
        { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
        { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
        { id: 'c', goal: 'keep c', scorer: `node ${comboPath}`, target: 90, editScope: 'c' },
      ],
    }
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const { verdict, state } = await runConvergeParallel(cfg, manifest, { runChild: child, log: () => {} })
    assert.ok(['capped', 'plateau'].includes(verdict.status)) // terminated, not done (C cannot coexist with A+B)
    assert.ok(state.global_pass <= state.global_cap + 2) // bounded work, no runaway
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true }); rmSync(comboDir, { recursive: true, force: true })
  }
})

