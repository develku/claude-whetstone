// test/swe-evo-seal.test.mjs
// The "sealed-slice" seal step: collapse a materialized editor checkout to a single seed commit so the
// editor cannot mine the upstream fix out of .git history (Cursor's measured 9% git-history leak vector; the
// test run already pins `--network none` for the other 57% web vector). All $0 — pure local git, no Docker.
// The seal+editorCodePatch test proves the threading: after the original base_commit is wiped from the editor
// tree, the editor's diff must be captured against the SEALED seed SHA, and it still lands intact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealCheckout } from '../bench/swe-evo/seal.mjs'
import { editorCodePatch } from '../bench/swe-evo/runner.mjs'

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim()

// A checkout whose .git holds the upstream FIX on a side branch — the leak an unsealed harness exposes. The
// working tree is left at base content (return 1), exactly like a SWE-bench image checked out at base_commit.
function repoWithHistory() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-seal-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), 'def f():\n    return 1\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base feature')
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', '-b', 'upstream-fix')
  writeFileSync(join(dir, 'app.py'), 'def f():\n    return 2  # the fix\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'FIX: the upstream patch that resolves the issue')
  git(dir, 'checkout', '-q', '-') // back to the base branch; working tree returns to base content
  return { dir, base }
}

test('sealCheckout collapses all history/branches to a single seed commit (kills git-history mining)', () => {
  const { dir } = repoWithHistory()
  try {
    assert.ok(Number(git(dir, 'rev-list', '--count', '--all')) >= 2, 'precondition: multi-commit history')
    const sha = sealCheckout(dir)
    assert.match(sha, /^[0-9a-f]{40}$/)
    assert.equal(git(dir, 'rev-list', '--count', '--all'), '1') // every ref collapses to one commit
    assert.equal(git(dir, 'rev-parse', 'HEAD'), sha) // returns the seed SHA (the editor base to thread)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sealCheckout removes the upstream fix commit, all branches, and any remote (the leak is gone)', () => {
  const { dir } = repoWithHistory()
  try {
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
    sealCheckout(dir)
    assert.doesNotMatch(git(dir, 'log', '--all', '--oneline'), /FIX: the upstream patch/) // not mineable
    assert.equal(git(dir, 'branch', '--list', 'upstream-fix'), '') // the fix branch is gone
    assert.equal(git(dir, 'remote'), '') // no remote to re-fetch the history from
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sealCheckout preserves the working tree byte-for-byte (the editor still starts from the exact base)', () => {
  const { dir } = repoWithHistory()
  try {
    const before = readFileSync(join(dir, 'app.py'), 'utf8')
    sealCheckout(dir)
    assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), before)
    // a reset to the seed restores that exact tree — what runArm does between attempts
    writeFileSync(join(dir, 'app.py'), 'def f():\n    return 999\n')
    git(dir, 'reset', '--hard', 'HEAD'); git(dir, 'clean', '-fdxq')
    assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('seal + editorCodePatch captures the editor diff against the SEALED base (history wiped, patch intact)', () => {
  const { dir } = repoWithHistory()
  try {
    const sealed = sealCheckout(dir) // the original base_commit SHA is now gone from this tree
    writeFileSync(join(dir, 'app.py'), 'def f():\n    return 42  # editor fix\n')
    const patch = editorCodePatch(dir, sealed) // threading: diff against the seed SHA, not the wiped base_commit
    assert.match(patch, /\+ {4}return 42 {2}# editor fix/) // the editor's change is in the patch
    assert.match(patch, /app\.py/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('after sealing, the original base_commit SHA no longer resolves (why editorBase MUST be threaded)', () => {
  const { dir, base } = repoWithHistory()
  try {
    sealCheckout(dir)
    // diffing the editor tree against the pre-seal base_commit is now impossible — the harness must use the
    // sealed seed SHA for the editor tree (the grading container keeps the real base_commit separately).
    const r = spawnSync('git', ['-C', dir, 'cat-file', '-e', base], { encoding: 'utf8' })
    assert.notEqual(r.status, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
