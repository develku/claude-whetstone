import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareResumeState } from '../src/converge.mjs'
import { prepareGlobalResumeParallel } from '../src/converge-parallel.mjs'
import { initConvergeState, ensureConvergeDir, saveConvergeState, inflightList } from '../src/converge-state.mjs'

// Track B inc 5 — crash-resume for a parallel run + the inflight-as-SET state deltas. A run killed MID-BATCH
// leaves an inflight SET whose children's actual spend was never charged; resume reclaims their worktrees,
// cleans their tmp dirs, and bias-UP charges their reserved tokens before re-checking the budget.

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-prsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-prr-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}
function cfgFor(scope, sc, over = {}) {
  return {
    scope, objectivesPath: join(sc.dir, 'objectives.json'), convergeDir: mkdtempSync(join(tmpdir(), 'whet-prcd-')),
    globalBudgetTokens: 100_000_000, globalCap: 12, globalStabilityRuns: 2, minDelta: 1, objectiveRetries: 1,
    maxParallel: 2, model: 'sonnet', effort: 'medium', noEscalate: true, ...over,
  }
}
function manifestFor(sc) {
  return {
    goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 4,
    objectives: [
      { id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' },
      { id: 'b', goal: 'raise b', scorer: `node ${sc.path} b/val.txt`, target: 90, editScope: 'b' },
    ],
  }
}
const childWrites = (plan) => async (childCfg) => {
  for (const [rel, val] of Object.entries(plan[childCfg.editScope] ?? {})) {
    mkdirSync(join(childCfg.scope, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(childCfg.scope, rel), String(val))
  }
  git(childCfg.scope, 'add', '-A'); git(childCfg.scope, 'commit', '-q', '--allow-empty', '-m', 'child')
  return { state: { spent_usd: 0, spent_tokens: 1000 } }
}

// Build a state that looks like a parallel run killed MID-BATCH: an inflight SET of 2 children with reserved
// tokens + on-disk tmp dirs, an ahead/tampered HEAD, reserved_tokens committed, spent not yet charged.
function crashedMidBatch(scope, sc, cfg, { reserved = 600_000 } = {}) {
  const lastGood = git(scope, 'rev-parse', 'HEAD')
  const state = initConvergeState(cfg, manifestFor(sc))
  state.last_good_sha = lastGood
  ensureConvergeDir(cfg.convergeDir)
  const dirs = {}
  for (const id of ['a', 'b']) {
    const d = join(cfg.convergeDir, 'children', `${id}-1`)
    mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'state.json'), '{}')
    dirs[id] = d
  }
  state.inflight = [
    { objectiveId: 'a', childTmpDir: dirs.a, reservedTokens: reserved },
    { objectiveId: 'b', childTmpDir: dirs.b, reservedTokens: reserved },
  ]
  state.reserved_tokens = reserved * 2
  state.spent_tokens = 0
  saveConvergeState(cfg.convergeDir, state)
  // a tampered commit ahead of last-good (the killed-mid-revert tree)
  writeFileSync(join(scope, 'a/val.txt'), '7'); git(scope, 'add', '-A'); git(scope, 'commit', '-q', '-m', 'tamper')
  return { lastGood, dirs }
}

// --- inflightList normalizer: object | array | null -> array ---

test('inflightList normalizes object | array | null to an array', () => {
  assert.deepEqual(inflightList({ inflight: null }), [])
  assert.deepEqual(inflightList({}), [])
  assert.deepEqual(inflightList({ inflight: { objectiveId: 'a' } }), [{ objectiveId: 'a' }])
  const arr = [{ objectiveId: 'a' }, { objectiveId: 'b' }]
  assert.deepEqual(inflightList({ inflight: arr }), arr)
})

// --- prepareResumeState: the crash-recovery cleanup (isolated, before the loop drives) ---

test('prepareResumeState bias-UP charges crashed children reserved tokens, cleans tmp dirs, prunes, resets reserved', () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = cfgFor(scope, sc)
  try {
    const { lastGood, dirs } = crashedMidBatch(scope, sc, cfg, { reserved: 600_000 })
    const { state, blockedVerdict } = prepareResumeState(cfg, scope, { runChild: () => {}, log: () => {} })
    assert.equal(blockedVerdict, null)
    assert.equal(git(scope, 'rev-parse', 'HEAD'), lastGood) // ahead/tampered commit discarded
    assert.equal(state.spent_tokens, 1_200_000) // both reserved shares charged (bias up)
    assert.equal(state.reserved_tokens, 0) // the in-flight reservation is resolved into spent
    assert.equal(state.inflight, null) // cleared + re-queued
    assert.equal(existsSync(dirs.a), false) // child tmp dirs cleaned
    assert.equal(existsSync(dirs.b), false)
    // the bias-up landed on the per-objective ledger too
    assert.equal(state.objectives.find((o) => o.id === 'a').spent_tokens, 600_000)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('prepareResumeState charges an inflight entry whose objective the manifest no longer has to the GLOBAL pool (bias up, never under-count)', () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = cfgFor(scope, sc)
  try {
    crashedMidBatch(scope, sc, cfg, { reserved: 600_000 })
    // simulate a manifest edited between crash and resume: rename the inflight objective 'b' to a vanished id
    const loaded = JSON.parse(readFileSync(join(cfg.convergeDir, 'converge-state.json'), 'utf8'))
    loaded.inflight[1].objectiveId = 'vanished'
    writeFileSync(join(cfg.convergeDir, 'converge-state.json'), JSON.stringify(loaded))
    const { state } = prepareResumeState(cfg, scope, { runChild: () => {}, log: () => {} })
    assert.equal(state.spent_tokens, 1_200_000) // BOTH reserved shares hit the global pool, even the vanished one
    assert.equal(state.objectives.find((o) => o.id === 'a').spent_tokens, 600_000) // 'a' also on its own ledger
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('prepareResumeState REFUSES when the bias-up charge pushes spend over the budget', () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  // budget 1M, two reserved shares of 600K each -> biased-up spend 1.2M > 1M -> refuse
  const cfg = cfgFor(scope, sc, { globalBudgetTokens: 1_000_000 })
  try {
    const { lastGood } = crashedMidBatch(scope, sc, cfg, { reserved: 600_000 })
    void lastGood
    assert.throws(() => prepareResumeState(cfg, scope, { runChild: () => {}, log: () => {} }), /cannot resume/)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

// --- end-to-end: a crashed parallel run resumes in PARALLEL and converges ---

test('prepareGlobalResumeParallel resumes a crashed parallel run and drives it to done', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0' })
  const cfg = cfgFor(scope, sc)
  try {
    crashedMidBatch(scope, sc, cfg, { reserved: 600_000 })
    const child = childWrites({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const { state, verdict } = await prepareGlobalResumeParallel(cfg, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    assert.ok(state.objectives.every((o) => o.met))
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.equal(readFileSync(join(scope, 'b/val.txt'), 'utf8'), '100')
    assert.ok(state.spent_tokens >= 1_200_000) // carries the bias-up charge plus the resumed run's spend
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
