import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitSnapshot, gitRestore } from '../src/git-snapshot.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-git-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}

test('gitSnapshot commits the current scope state and returns a resolvable SHA', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one')
    const sha = gitSnapshot(dir, 'pass 1')
    assert.match(sha, /^[0-9a-f]{40}$/)
    assert.equal(git(dir, 'rev-parse', 'HEAD'), sha) // the snapshot is the new HEAD
    assert.equal(git(dir, 'show', `${sha}:a.txt`), 'one') // and it captured the file
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitRestore rolls the tree back to a snapshot: edits revert and new files vanish', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'good')
    const best = gitSnapshot(dir, 'best')
    // a regressing pass: mutate the file AND add junk, then snapshot it
    writeFileSync(join(dir, 'a.txt'), 'bad')
    writeFileSync(join(dir, 'junk.txt'), 'regression')
    gitSnapshot(dir, 'regressed')
    // keep-best rollback to the good snapshot
    gitRestore(dir, best)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'good')
    assert.equal(existsSync(join(dir, 'junk.txt')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
