import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coarseSignalPlateau, readLatestFindings, resolveSubGate, decomposable, splitBudget, buildChildCfg, makeDecomposeAct } from '../src/decompose.mjs'
import { execFileSync } from 'node:child_process'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-dc-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}
// Write a review file so readLatestFindings has data; return a plateau state pointing at it.
function plateauWithFindings(loopDir, findings) {
  mkdirSync(join(loopDir, 'reviews'), { recursive: true })
  writeFileSync(join(loopDir, 'reviews', 'review_003.json'), JSON.stringify({ score: 50, critique: 'x', findings }))
  return {
    goal: 'g', target_score: 90, min_delta: 1, plateau_window: 3, hard_cap: 10, pass: 3,
    best_score: 50, budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0,
    history: [0, 1, 2, 3].map((i) =>
      i === 3 ? { pass: 3, score: 50, critique_ref: 'reviews/review_003.json' } : { pass: i, score: 50, critique_ref: null }),
  }
}
const allowOf = (id, path) => new Map([[id, path]])

// A state the gate reads as `plateau` (best-score flat over plateau_window+1 passes), below target.
function plateauState(over = {}) {
  return {
    goal: 'g', target_score: 90, min_delta: 1, plateau_window: 3, hard_cap: 10, pass: 3,
    best_score: 50, budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0,
    history: [50, 50, 50, 50].map((score, i) => ({ pass: i, score, critique_ref: null })),
    ...over,
  }
}

test('coarseSignalPlateau: true at a real plateau below target', () => {
  assert.equal(coarseSignalPlateau(plateauState()), true)
})

test('coarseSignalPlateau: false when still improving (running)', () => {
  const climbing = plateauState({ history: [50, 60, 70, 80].map((score, i) => ({ pass: i, score, critique_ref: null })), best_score: 80 })
  assert.equal(coarseSignalPlateau(climbing), false)
})

test('readLatestFindings: reads findings from the last review file; [] when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-rf-'))
  try {
    mkdirSync(join(dir, 'reviews'), { recursive: true })
    writeFileSync(join(dir, 'reviews', 'review_003.json'), JSON.stringify({ score: 50, critique: 'x', findings: [{ area: 'test A', severity: 'high', suggestion: 'fix A' }] }))
    const state = plateauState({ history: [{ pass: 3, score: 50, critique_ref: 'reviews/review_003.json' }] })
    assert.deepEqual(readLatestFindings(dir, state).map((f) => f.area), ['test A'])
    assert.deepEqual(readLatestFindings(dir, plateauState({ history: [{ pass: 0, score: 50, critique_ref: null }] })), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const allow = new Map([['test-pass-rate', '/abs/scorers/test-pass-rate.mjs']])
const ctx = { repoDir: '/repo', allowlist: allow }

test('resolveSubGate: builds a shq-quoted command from an allowlisted id', () => {
  const sg = resolveSubGate({ area: 'a', scorer: { id: 'test-pass-rate', args: ['--cmd', 'node --test', '--only', "weird ' name"] } }, ctx)
  assert.equal(sg.scorerCmd, "node '/abs/scorers/test-pass-rate.mjs' '--cmd' 'node --test' '--only' 'weird '\\'' name'")
  assert.equal(sg.editScope, null)
})

test('resolveSubGate: rejects an unknown scorer id (injection/allowlist) [CR#4]', () => {
  assert.equal(resolveSubGate({ area: 'a', scorer: { id: 'rm -rf /', args: [] } }, ctx), null)
  assert.equal(resolveSubGate({ area: 'a' }, ctx), null) // no scorer field -> not decomposable
  assert.equal(resolveSubGate({ area: 'a', scorer: { id: 'test-pass-rate', args: 'not-an-array' } }, ctx), null)
})

test('resolveSubGate: rejects a scope that escapes the repo [CR#5]', () => {
  const f = { area: 'a', scope: '../etc', scorer: { id: 'test-pass-rate', args: [] } }
  assert.equal(resolveSubGate(f, ctx), null)
  const ok = resolveSubGate({ area: 'a', scope: 'src/auth', scorer: { id: 'test-pass-rate', args: [] } }, ctx)
  assert.equal(ok.editScope, 'src/auth')
})

test('decomposable: keeps resolvable, unseen findings only', () => {
  const findings = [
    { area: 'A', scorer: { id: 'test-pass-rate', args: [] } },
    { area: 'B' },                                            // no scorer -> dropped
    { area: 'C', scorer: { id: 'unknown', args: [] } },       // bad id -> dropped
  ]
  const seen = new Set(['A'])                                  // already decomposed -> dropped
  assert.deepEqual(decomposable(findings, seen, ctx).map((x) => x.finding.area), [])
  assert.deepEqual(decomposable(findings, new Set(), ctx).map((x) => x.finding.area), ['A'])
})

test('splitBudget: divides only the dials that are set', () => {
  assert.deepEqual(splitBudget({ usd: 6, tokens: 300000 }, 3), { budgetUsd: 2, budgetTokens: 100000 })
  assert.deepEqual(splitBudget({ usd: null, tokens: null }, 4), { budgetUsd: null, budgetTokens: null })
})

// budget_tokens is a COUNTED integer (validate.mjs requires Number.isInteger); a fractional share would
// make every child's validateConfig throw, so decompose would silently no-op whenever --budget-tokens is
// set to a value not evenly divisible by the child count. Floor the token share (keeps sum <= remaining).
test('splitBudget: floors the token share to an integer; usd may stay fractional', () => {
  const share = splitBudget({ usd: 1, tokens: 100000 }, 3)
  assert.ok(Number.isInteger(share.budgetTokens), `budgetTokens must be an integer, got ${share.budgetTokens}`)
  assert.equal(share.budgetTokens, 33333) // floor(100000/3), not 33333.333…
  assert.equal(share.budgetUsd, 1 / 3) // usd is a compared threshold, fractional is fine
  // invariant preserved: the children's token shares never sum above the remaining budget
  assert.ok(share.budgetTokens * 3 <= 100000)
})

test('buildChildCfg: child repo is the PARENT scope, never finding.scope; no recursion [CR#5]', () => {
  const parentCfg = { scope: '/repo', readOnly: ['test/'], model: 'sonnet', effort: 'medium', escalateModel: 'opus', noEscalate: false, mcpConfig: null }
  const state = { goal: 'make tests pass', target_score: 90 }
  const finding = { area: 'auth login', suggestion: 'fix auth', scope: 'src/auth' }
  const subgate = { editScope: 'src/auth', scorerCmd: "node '/abs/test-pass-rate.mjs' '--only' 'auth login'" }
  const cfg = buildChildCfg(parentCfg, state, finding, subgate, { budgetUsd: 2, budgetTokens: 100000 }, 3, '/parent/loop', 0)
  assert.equal(cfg.scope, '/repo')              // git cwd is the parent repo, NOT finding.scope
  assert.equal(cfg.artifactPath, '/repo')
  assert.equal(cfg.editScope, 'src/auth')        // finding.scope only steers the editor prompt
  assert.equal(cfg.scorerCmd, subgate.scorerCmd)
  assert.equal(cfg.confirmScorerCmd, null)       // the PARENT confirm is the moat; children don't carry it
  assert.equal(cfg.hardCap, 3)
  assert.equal(cfg.budgetUsd, 2)
  assert.equal(cfg.decompose, false)             // depth cap 1
  assert.equal(cfg.noEscalate, true)             // a child is already the parent's escalated tier
  assert.match(cfg.goal, /specifically: fix auth/)
  assert.equal(cfg.loopDir, '/parent/loop/children/auth-login-0')
})

test('makeDecomposeAct: not at a plateau -> delegates to rescue, no children [CR#1]', async () => {
  const repo = tempRepo()
  try {
    const running = { ...plateauWithFindings(repo, []), history: [50, 60, 70, 80].map((score, i) => ({ pass: i, score, critique_ref: null })), best_score: 80 }
    let childRan = false
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: repo, parentCfg: { scope: repo }, runChild: async () => { childRan = true; return { state: {}, verdict: { status: 'done' } } }, rescueAct: async () => ({ changed: true, costUsd: 0.1, tokens: 5, _rescue: true }), allowlist: new Map() })
    const r = await act(running)
    assert.equal(r._rescue, true)
    assert.equal(childRan, false)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('makeDecomposeAct: fans out, aggregates spend, dedups across passes [CR#3]', async () => {
  const repo = tempRepo()
  try {
    const finding = { area: 'A', suggestion: 'fix A', scorer: { id: 'tpr', args: ['--only', 'A'] } }
    const state = plateauWithFindings(repo, [finding])
    const allowlist = allowOf('tpr', '/abs/tpr.mjs')
    let calls = 0
    const runChild = async () => { calls++; writeFileSync(join(repo, 'edit.txt'), `child ${calls}`); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'child'); return { state: { spent_usd: 0.5, spent_tokens: 1000 }, verdict: { status: 'done' } } }
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: repo, parentCfg: { scope: repo, readOnly: [] }, runChild, rescueAct: async () => ({ changed: false, costUsd: 0, tokens: 0 }), allowlist })
    const r1 = await act(state)
    assert.equal(calls, 1)
    assert.equal(r1.changed, true)            // a real edit landed
    assert.equal(r1.costUsd, 0.5)
    assert.equal(r1.tokens, 1000)
    const r2 = await act(state)               // same finding area -> deduped -> rescue, no second child
    assert.equal(calls, 1)
    assert.equal(r2.changed, false)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('makeDecomposeAct: a failed child is rolled back and not counted as a lasting change [CR#2]', async () => {
  const repo = tempRepo()
  try {
    const finding = { area: 'A', suggestion: 'fix A', scorer: { id: 'tpr', args: [] } }
    const state = plateauWithFindings(repo, [finding])
    const head0 = git(repo, 'rev-parse', 'HEAD')
    const runChild = async () => { writeFileSync(join(repo, 'broken.txt'), 'half-done'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'child wip'); return { state: { spent_usd: 0.3, spent_tokens: 10 }, verdict: { status: 'error' } } }
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: repo, parentCfg: { scope: repo, readOnly: [] }, runChild, rescueAct: async () => ({ changed: false, costUsd: 0, tokens: 0 }), allowlist: allowOf('tpr', '/x.mjs') })
    const r = await act(state)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head0)   // rolled back to before the failed child
    assert.equal(r.changed, false)                         // its edits left no lasting change
    assert.equal(r.costUsd, 0.3)                           // but the money it spent is still charged
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('makeDecomposeAct: a done child that leaves a dirty tree is rolled back, money still charged [CR#2]', async () => {
  const repo = tempRepo()
  try {
    const finding = { area: 'A', suggestion: 'fix A', scorer: { id: 'tpr', args: [] } }
    const state = plateauWithFindings(repo, [finding])
    const head0 = git(repo, 'rev-parse', 'HEAD')
    // child "succeeds" (done) but leaves an UNCOMMITTED edit -> dirty tree -> must be rolled back
    const runChild = async () => { writeFileSync(join(repo, 'stray.txt'), 'uncommitted'); return { state: { spent_usd: 0.2, spent_tokens: 7 }, verdict: { status: 'done' } } }
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: repo, parentCfg: { scope: repo, readOnly: [] }, runChild, rescueAct: async () => ({ changed: false, costUsd: 0, tokens: 0 }), allowlist: allowOf('tpr', '/x.mjs') })
    const r = await act(state)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head0)        // rolled back
    assert.equal(git(repo, 'status', '--porcelain'), '')        // dirty edit swept by clean -fdq
    assert.equal(r.changed, false)
    assert.equal(r.costUsd, 0.2)                                // money still charged
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('makeDecomposeAct: fan-out stops when the budget is exhausted [CR#6]', async () => {
  const repo = tempRepo()
  try {
    const findings = [
      { area: 'A', suggestion: 'fix A', severity: 'high', scorer: { id: 'tpr', args: [] } },
      { area: 'B', suggestion: 'fix B', severity: 'high', scorer: { id: 'tpr', args: [] } },
    ]
    const state = { ...plateauWithFindings(repo, findings), budget_usd: 1, spent_usd: 0 }
    let calls = 0
    const runChild = async () => { calls++; writeFileSync(join(repo, `e${calls}.txt`), 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'c'); return { state: { spent_usd: 1.5, spent_tokens: 10 }, verdict: { status: 'done' } } }
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: repo, parentCfg: { scope: repo, readOnly: [] }, runChild, rescueAct: async () => ({ changed: false, costUsd: 0, tokens: 0 }), allowlist: allowOf('tpr', '/x.mjs') })
    const r = await act(state)
    assert.equal(calls, 1)              // first child spent 1.5 > budget 1 -> second child never launches
    assert.equal(r.costUsd, 1.5)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
