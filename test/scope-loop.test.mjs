import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runFromConfig } from '../src/driver.mjs'
import { recordPass } from '../src/state.mjs'
import { scopeBuildContext } from '../src/scope-context.mjs'
import { gitRestore } from '../src/git-snapshot.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-loop-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}

// A deterministic, no-spend scorer: read progress.txt from cwd (the scope) and emit it as the score.
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-scorer-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst n = Number(readFileSync('progress.txt', 'utf8').trim())\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise progress.txt toward 100' }))\n")
  return { dir, cmd: `node ${path}` }
}

// The scope loop reuses the whole driver and only swaps the I/O context. That swap needs ONE seam:
// runPrepared must route evaluate/persist/confirm through an injected buildContext, else the real one
// runs the bogus scorer 'false' and the run errors instead of reaching done.
test('runFromConfig routes the context through an injected buildContext', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-inj-'))
  try {
    const buildContext = () => ({
      evaluate: async () => ({ score: 100, critique: '', review: { score: 100, critique: '' } }),
      persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: 'x', reviewRef: 'r', costUsd: 0, tokens: 0 }),
      confirm: null,
    })
    const { verdict } = await runFromConfig(
      { goal: 'g', artifactPath: join(loopDir, 'a'), scorerCmd: 'false', targetScore: 90, hardCap: 3, loopDir },
      { buildContext, act: async () => ({ changed: true, costUsd: 0, tokens: 0 }), log: () => {} }
    )
    assert.equal(verdict.status, 'done')
  } finally {
    rmSync(loopDir, { recursive: true, force: true })
  }
})

// CAPSTONE 1 — the whole MVP wired together: a stub editor (no spend) raises a real git repo from a red
// score to green; the code-owned gate stops at done; each pass is a real git commit (gitSnapshot).
test('scope loop drives a repo red -> green and commits each pass (integration, no spend)', async () => {
  const scopeDir = tempRepo()
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-il-'))
  const scorer = writeScorer()
  try {
    writeFileSync(join(scopeDir, 'progress.txt'), '50')
    git(scopeDir, 'add', '-A'); git(scopeDir, 'commit', '-q', '-m', 'seed') // clean tree at 50
    const before = Number(git(scopeDir, 'rev-list', '--count', 'HEAD'))
    let c = 0
    const stubAct = async () => {
      c++
      writeFileSync(join(scopeDir, 'progress.txt'), String(c === 1 ? 80 : 100))
      return { changed: true, costUsd: 0, tokens: 0 }
    }
    const { state, verdict } = await runFromConfig(
      { goal: 'raise it', artifactPath: scopeDir, scorerCmd: scorer.cmd, targetScore: 90, hardCap: 5, noEscalate: true, loopDir },
      { buildContext: scopeBuildContext, act: stubAct, restore: (sha) => gitRestore(scopeDir, sha), log: () => {} }
    )
    assert.equal(verdict.status, 'done')
    assert.equal(state.best_score, 100)
    assert.equal(readFileSync(join(scopeDir, 'progress.txt'), 'utf8'), '100')
    assert.ok(Number(git(scopeDir, 'rev-list', '--count', 'HEAD')) > before) // committed per pass
  } finally {
    rmSync(scopeDir, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true }); rmSync(scorer.dir, { recursive: true, force: true })
  }
})

// CAPSTONE 2 — keep-best across the loop: a pass that regresses is rolled back to the best snapshot via
// git, so an unattended run cannot drift backward. Proves restoreTarget + gitRestore wired through.
test('scope loop rolls a regressing pass back to the best snapshot via git (keep-best)', async () => {
  const scopeDir = tempRepo()
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-kb-'))
  const scorer = writeScorer()
  try {
    writeFileSync(join(scopeDir, 'progress.txt'), '50')
    git(scopeDir, 'add', '-A'); git(scopeDir, 'commit', '-q', '-m', 'seed')
    let c = 0
    // pass 1 improves to 80 (new best); pass 2 regresses to 30 -> keep-best must roll the tree back to 80
    const stubAct = async () => {
      c++
      writeFileSync(join(scopeDir, 'progress.txt'), String(c === 1 ? 80 : 30))
      return { changed: true, costUsd: 0, tokens: 0 }
    }
    const { state, verdict } = await runFromConfig(
      { goal: 'raise it', artifactPath: scopeDir, scorerCmd: scorer.cmd, targetScore: 90, hardCap: 3, noEscalate: true, loopDir },
      { buildContext: scopeBuildContext, act: stubAct, restore: (sha) => gitRestore(scopeDir, sha), log: () => {} }
    )
    assert.equal(verdict.status, 'capped') // never reached 90
    assert.equal(state.best_score, 80)
    assert.equal(readFileSync(join(scopeDir, 'progress.txt'), 'utf8'), '80') // regression rolled back to best
  } finally {
    rmSync(scopeDir, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true }); rmSync(scorer.dir, { recursive: true, force: true })
  }
})
