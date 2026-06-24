import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scopeBuildContext } from '../src/scope-context.mjs'
import { initState, ensureLoopDir } from '../src/state.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-ctx-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}
const stateFor = (scopeDir, over = {}) => ({
  ...initState({ goal: 'g', artifactPath: scopeDir, scorerCmd: 'cat score.json #', targetScore: 90, hardCap: 5 }),
  ...over,
})

test('scope persist commits via git and records the commit SHA as the snapshot', () => {
  const scopeDir = tempRepo()
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-loop-'))
  try {
    ensureLoopDir(loopDir)
    const { persist } = scopeBuildContext(loopDir)
    writeFileSync(join(scopeDir, 'src.js'), 'edited') // a pass's edit
    const next = persist(stateFor(scopeDir), { score: 80, critique: 'c', review: { score: 80, critique: 'c' }, costUsd: 0, tokens: 0 })
    assert.equal(next.history.length, 1)
    assert.match(next.history[0].snapshot, /^[0-9a-f]{40}$/)
    assert.equal(git(scopeDir, 'rev-parse', 'HEAD'), next.history[0].snapshot) // a real commit
    assert.equal(existsSync(join(loopDir, 'reviews', 'review_000.json')), true)
  } finally {
    rmSync(scopeDir, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true })
  }
})

test('scope evaluate runs the scorer in cwd=scopeDir and returns its score', async () => {
  const scopeDir = tempRepo()
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-loop-'))
  try {
    ensureLoopDir(loopDir)
    writeFileSync(join(scopeDir, 'score.json'), '{"score":42,"critique":"c"}') // exists ONLY in the scope
    const { evaluate } = scopeBuildContext(loopDir)
    const r = await evaluate(stateFor(scopeDir))
    assert.equal(r.score, 42) // read score.json from cwd=scopeDir; a wrong cwd would ENOENT and throw
  } finally {
    rmSync(scopeDir, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true })
  }
})
