// Track A milestone (inc 7): the stub planner generates a manifest that drives the UNCHANGED Track C
// engine to `done` — $0 (stub planCall + stub child + a real git temp repo). No new src. This proves the
// integration seam: a planner-authored manifest is consumed by runConverge exactly as an operator's is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { planManifest } from '../src/plan.mjs'
import { loadPlanAllowlist } from '../src/plan-allowlist.mjs'
import { runConverge } from '../src/converge.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

// A DATA-only scorer (reads a file from cwd, emits its number as the score; no child_process) — registered
// via --scorer-allow so the planner allowlist includes it (id 'score'). It lives OUTSIDE the scope.
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-psc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-pconv-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

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

function convergeCfg(scope, scorerDir, overrides = {}) {
  return {
    scope,
    objectivesPath: join(scorerDir, 'objectives.json'), // outside scope
    convergeDir: mkdtempSync(join(tmpdir(), 'whet-pcdir-')),
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

test('Track A end-to-end ($0): stub plan -> generated manifest -> runConverge -> done, provenance threaded', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0', 'README.md': 'readme' })
  try {
    const allowlist = loadPlanAllowlist([sc.path]) // operator allows the custom data-only 'score'
    const proposals = [
      { id: 'a', goal: 'raise a', scorerId: 'score', args: ['a/val.txt'], editScope: 'a', target: 90 },
      { id: 'b', goal: 'raise b', scorerId: 'score', args: ['b/val.txt'], editScope: 'b', target: 90 },
    ]
    const planCfg = {
      goal: 'raise a and b to target',
      scopeDir: scope,
      floor: { cmd: 'true', readOnly: ['README.md'] },
      objectiveCap: 4,
      globalBudgetTokens: 100_000_000,
      repoContext: 'files: a/val.txt b/val.txt',
    }
    const { manifest, report } = await planManifest(planCfg, {
      planCall: async () => ({ text: JSON.stringify({ objectives: proposals }) }),
      allowlist,
      repoFiles: ['a/val.txt', 'b/val.txt', 'README.md'],
    })

    // hand the GENERATED manifest to the UNCHANGED engine, threading the honest planner provenance (inc 0)
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100 } })
    const { state, verdict } = await runConverge(
      convergeCfg(scope, sc.dir, { objectivesSource: 'planner', coverageScore: report.coverage_score }),
      manifest,
      { runChild: child, log: () => {} },
    )

    assert.equal(verdict.status, 'done')
    assert.ok(state.objectives.every((o) => o.met))
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.equal(readFileSync(join(scope, 'b/val.txt'), 'utf8'), '100')
    // honesty: the SET is never proven sufficient; the planner provenance + coverage_score thread through
    assert.equal(state.objectives_sufficiency, 'unproven')
    assert.equal(state.objectives_source, 'planner')
    assert.equal(state.coverage_score, report.coverage_score)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('Track A inherits anti-capture: a child edit OUTSIDE its editScope is discarded by the editScope-positive squash', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0', 'b/val.txt': '0', 'README.md': 'readme' })
  try {
    const allowlist = loadPlanAllowlist([sc.path])
    const proposals = [
      { id: 'a', goal: 'raise a', scorerId: 'score', args: ['a/val.txt'], editScope: 'a', target: 90 },
      { id: 'b', goal: 'raise b', scorerId: 'score', args: ['b/val.txt'], editScope: 'b', target: 90 },
    ]
    const { manifest } = await planManifest(
      { goal: 'raise a and b', scopeDir: scope, floor: { cmd: 'true', readOnly: ['README.md'] }, objectiveCap: 4, globalBudgetTokens: 100_000_000 },
      { planCall: async () => ({ text: JSON.stringify({ objectives: proposals }) }), allowlist, repoFiles: ['a/val.txt', 'b/val.txt'] },
    )
    // B's child raises b/val.txt (legit, in scope) AND tries to sabotage a/val.txt=999 (OUT of B's editScope)
    const child = makeStubChild({ a: { 'a/val.txt': 100 }, b: { 'b/val.txt': 100, 'a/val.txt': 999 } })
    const { state, verdict } = await runConverge(convergeCfg(scope, sc.dir), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    // B's out-of-scope a/val.txt=999 was dropped by the squash; A's own child set it to 100
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.ok(state.objectives.every((o) => o.met))
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
