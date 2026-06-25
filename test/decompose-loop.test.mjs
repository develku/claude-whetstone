import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeDecomposeAct, readLatestFindings } from '../src/decompose.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-dl-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'app.txt'), 'start'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// A full fan-out with two findings: both children "fix" their slice and commit. Assert the parent tree
// changed, spend aggregated, and the repo did NOT accumulate the children's loop-dir files.
test('decompose fan-out: two children edit the shared repo, spend aggregates, no loopdir pollution', async () => {
  const repo = tempRepo()
  const loopDir = join(repo, '.loop', 'run')
  try {
    mkdirSync(join(loopDir, 'reviews'), { recursive: true })
    writeFileSync(join(loopDir, '.gitignore'), '*\n') // mirrors ensureLoopDir's self-ignoring run dir
    const findings = [
      { area: 'A', suggestion: 'fix A', severity: 'high', scorer: { id: 'tpr', args: ['--only', 'A'] } },
      { area: 'B', suggestion: 'fix B', severity: 'high', scorer: { id: 'tpr', args: ['--only', 'B'] } },
    ]
    writeFileSync(join(loopDir, 'reviews', 'review_003.json'), JSON.stringify({ score: 50, critique: 'x', findings }))
    const state = {
      goal: 'g', target_score: 90, min_delta: 1, plateau_window: 3, hard_cap: 10, pass: 3, best_score: 50,
      budget_usd: 10, budget_tokens: null, spent_usd: 0, spent_tokens: 0,
      history: [0, 1, 2, 3].map((i) => ({ pass: i, score: 50, critique_ref: i === 3 ? 'reviews/review_003.json' : null })),
    }
    const runChild = async (cfg) => {
      // a child writes its area's file under the repo and commits (its own gitignored loopDir is created too)
      mkdirSync(cfg.loopDir, { recursive: true }); writeFileSync(join(cfg.loopDir, '.gitignore'), '*\n')
      writeFileSync(join(cfg.loopDir, 'state.json'), '{}')
      const f = cfg.goal.includes('fix A') ? 'a' : 'b'
      writeFileSync(join(repo, `${f}.txt`), 'fixed'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', `child ${f}`)
      return { state: { spent_usd: 1.5, spent_tokens: 2000 }, verdict: { status: 'done' } }
    }
    const act = makeDecomposeAct({ repoDir: repo, parentLoopDir: loopDir, parentCfg: { scope: repo, readOnly: [] }, runChild, rescueAct: async () => ({ changed: false, costUsd: 0, tokens: 0 }), allowlist: new Map([['tpr', '/x/tpr.mjs']]) })
    const r = await act(state)
    assert.equal(r.changed, true)
    assert.equal(r.costUsd, 3)                                  // 1.5 + 1.5 aggregated
    assert.equal(r.tokens, 4000)
    // the children's edits are committed; the loop dirs are NOT in the repo tree
    const tracked = git(repo, 'ls-files')
    assert.match(tracked, /a\.txt/)
    assert.match(tracked, /b\.txt/)
    assert.doesNotMatch(tracked, /state\.json/)                 // loopdir self-ignored -> never committed
    assert.equal(git(repo, 'status', '--porcelain'), '')        // clean tree after fan-out
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
