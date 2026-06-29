import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareGlobalResume } from '../src/converge.mjs'
import { initConvergeState, ensureConvergeDir, saveConvergeState } from '../src/converge-state.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-rsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-rrun-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}
function cfgFor(scope, sc) {
  return {
    scope, objectivesPath: join(sc.dir, 'objectives.json'), convergeDir: mkdtempSync(join(tmpdir(), 'whet-rcd-')),
    globalBudgetTokens: 100_000_000, globalCap: 12, globalStabilityRuns: 2, minDelta: 1, objectiveRetries: 1,
    model: 'sonnet', effort: 'medium', noEscalate: true,
  }
}
function manifestFor(sc) {
  return {
    goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 3,
    objectives: [{ id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' }],
  }
}
const childWrites = (val) => async (childCfg) => {
  writeFileSync(join(childCfg.scope, 'a', 'val.txt'), String(val))
  git(childCfg.scope, 'add', '-A'); git(childCfg.scope, 'commit', '-q', '--allow-empty', '-m', 'child')
  return { state: { spent_usd: 0, spent_tokens: 1000 } }
}

test('prepareGlobalResume HARD-RESETS to last_good_sha, discarding an ahead/tampered commit', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '100' }) // a is met (>= 90) at this good state
  try {
    const cfg = cfgFor(scope, sc)
    const lastGood = git(scope, 'rev-parse', 'HEAD')
    const state = initConvergeState(cfg, manifestFor(sc))
    state.last_good_sha = lastGood
    ensureConvergeDir(cfg.convergeDir)
    saveConvergeState(cfg.convergeDir, state)
    // simulate a kill-mid-revert / gate-tampered tree committed AHEAD of last-good
    writeFileSync(join(scope, 'a/val.txt'), '0')
    git(scope, 'add', '-A'); git(scope, 'commit', '-q', '-m', 'tamper ahead of last-good')
    assert.notEqual(git(scope, 'rev-parse', 'HEAD'), lastGood)

    let childCalls = 0
    const { verdict } = await prepareGlobalResume(cfg, { runChild: async (c) => { childCalls++; return childWrites(100)(c) }, log: () => {} })
    assert.equal(git(scope, 'rev-parse', 'HEAD'), lastGood) // the ahead commit was discarded
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100') // re-derived from last-good
    assert.equal(verdict.status, 'done') // a met at last-good
    assert.equal(childCalls, 0) // nothing to do — no objective launched
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('prepareGlobalResume RE-DERIVES met by re-measuring — a stale recorded "met" is not trusted', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '50' }) // a is actually UNMET (50 < 90) at last-good
  try {
    const cfg = cfgFor(scope, sc)
    const lastGood = git(scope, 'rev-parse', 'HEAD')
    const state = initConvergeState(cfg, manifestFor(sc))
    state.last_good_sha = lastGood
    // a LIE in the recorded ledger: claims done although the SHA re-measures unmet
    state.objectives[0].met = true
    state.objectives[0].primaryScore = 95
    state.objectives[0].status = 'met'
    ensureConvergeDir(cfg.convergeDir)
    saveConvergeState(cfg.convergeDir, state)

    let childCalls = 0
    const { verdict } = await prepareGlobalResume(cfg, { runChild: async (c) => { childCalls++; return childWrites(100)(c) }, log: () => {} })
    assert.ok(childCalls >= 1) // did NOT trust the stale 'met' — re-derived unmet and ran the objective
    assert.equal(verdict.status, 'done') // the child then genuinely raised it
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('prepareGlobalResume REFUSES with a blocked verdict when the deterministic floor fails at last-good', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '50' })
  try {
    const cfg = cfgFor(scope, sc)
    // the repo's deterministic floor broke at last-good between the crash and the resume (e.g. a dependency
    // removed / environment changed). Resume must refuse cleanly — NOT spend tokens editing on a broken repo.
    const manifest = { ...manifestFor(sc), floor: { cmd: 'false' } }
    const state = initConvergeState(cfg, manifest)
    state.last_good_sha = git(scope, 'rev-parse', 'HEAD')
    ensureConvergeDir(cfg.convergeDir)
    saveConvergeState(cfg.convergeDir, state)
    let childCalls = 0
    const { verdict } = await prepareGlobalResume(cfg, { runChild: async (c) => { childCalls++; return childWrites(100)(c) }, log: () => {} })
    assert.equal(verdict.status, 'blocked')
    assert.match(verdict.reason, /floor.*last-good/i)
    assert.equal(childCalls, 0) // no objective launched against a floor-failing repo
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('prepareGlobalResume REFUSES (throws actionable) when the global budget is already exhausted', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '50' })
  try {
    const cfg = cfgFor(scope, sc)
    const state = initConvergeState(cfg, manifestFor(sc))
    state.last_good_sha = git(scope, 'rev-parse', 'HEAD')
    state.global_budget_tokens = 100
    state.spent_tokens = 5000 // already over budget
    ensureConvergeDir(cfg.convergeDir)
    saveConvergeState(cfg.convergeDir, state)
    await assert.rejects(
      () => prepareGlobalResume(cfg, { runChild: childWrites(100), log: () => {} }),
      /cannot resume/,
    )
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
