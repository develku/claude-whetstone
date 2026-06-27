// test/git-snapshot-forge.test.mjs — the scope-Forge git primitives (materialize-and-hold, diff, sha guard)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitMaterialize, gitCleanup, gitDiffNames, isSha } from '../src/git-snapshot.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
const initRepo = () => {
  const d = mkdtempSync(join(tmpdir(), 'gsf-'))
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 't@e.com'); git(d, 'config', 'user.name', 't')
  return d
}

test('gitMaterialize checks out a ref to a HELD worktree (not removed); gitCleanup removes it', () => {
  const d = initRepo()
  writeFileSync(join(d, 'a.txt'), 'one'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', '1')
  const sha1 = git(d, 'rev-parse', 'HEAD')
  writeFileSync(join(d, 'a.txt'), 'two'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', '2')
  const wt = gitMaterialize(d, sha1)
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'one') // pristine old state, still present (held across await)
  gitCleanup(d, wt)
  assert.equal(existsSync(wt), false)
})

test('gitDiffNames lists only the files whose content changed between two commits', () => {
  const d = initRepo()
  mkdirSync(join(d, 'src'))
  writeFileSync(join(d, 'src', 'm.mjs'), 'a'); writeFileSync(join(d, 'keep.txt'), 'k'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', '1')
  const s1 = git(d, 'rev-parse', 'HEAD')
  writeFileSync(join(d, 'src', 'm.mjs'), 'b'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', '2')
  const s2 = git(d, 'rev-parse', 'HEAD')
  assert.deepEqual(gitDiffNames(d, s1, s2), ['src/m.mjs'])
})

test('isSha accepts hex commit ids, rejects junk/path-like input (trust-boundary guard)', () => {
  assert.equal(isSha('a'.repeat(40)), true)
  assert.equal(isSha('abc1234'), true)
  assert.equal(isSha('../evil'), false)
  assert.equal(isSha('HEAD~1'), false)
  assert.equal(isSha(''), false)
  assert.equal(isSha(null), false)
})
