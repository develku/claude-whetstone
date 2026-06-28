import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { editScopeAllowed, squashIntegrate } from '../src/converge.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-conv-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}

function write(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// --- editScopeAllowed: a committed path is integrated only if it is INSIDE the editScope AND NOT a gate file ---

test('editScopeAllowed: a file inside the editScope and outside the gate set is allowed', () => {
  assert.equal(editScopeAllowed('src/auth/login.js', 'src/auth', ['test/auth']), true)
})

test('editScopeAllowed: a file OUTSIDE the editScope is rejected (cannot edit a sibling objective source)', () => {
  assert.equal(editScopeAllowed('src/api/routes.js', 'src/auth', []), false)
})

test('editScopeAllowed: prefix trap — src/auth does NOT admit src/authz', () => {
  assert.equal(editScopeAllowed('src/authz/x.js', 'src/auth', []), false)
})

test('editScopeAllowed: a gate/measurement file inside the editScope is rejected (denylist beats allowlist)', () => {
  assert.equal(editScopeAllowed('src/auth/score.mjs', 'src/auth', ['src/auth/score.mjs']), false)
})

// --- squashIntegrate: exactly ONE commit on last-good, carrying ONLY editScope-allowed paths ---

test('squashIntegrate reduces a multi-commit child to ONE commit whose parent IS last-good', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    // child makes TWO commits (incl. an --allow-empty baseline) editing in-scope src/auth
    write(dir, 'src/auth/a.txt', '2')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'child pass 1')
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'child pass 2')
    const childHead = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'reset', '--hard', lastGood) // orchestrator works off SHAs, tree back at last-good

    const r = squashIntegrate(dir, lastGood, childHead, (p) => editScopeAllowed(p, 'src/auth', []))
    assert.equal(r.advanced, true)
    assert.equal(git(dir, 'rev-parse', `${r.sha}^`), lastGood) // PARENT equality (stronger than ancestor)
    assert.deepEqual(git(dir, 'diff', '--name-only', lastGood, r.sha).split('\n'), ['src/auth/a.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrate carries ONLY editScope-allowed paths; an out-of-scope edit is reverted (not integrated)', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    // child edits BOTH its own scope (src/auth) and a sibling's source (src/api)
    write(dir, 'src/auth/a.txt', '2')
    write(dir, 'src/api/b.txt', 'HACKED')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'child')
    const childHead = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'reset', '--hard', lastGood)

    const r = squashIntegrate(dir, lastGood, childHead, (p) => editScopeAllowed(p, 'src/auth', []))
    const names = git(dir, 'diff', '--name-only', lastGood, r.sha)
    assert.equal(names, 'src/auth/a.txt') // only in-scope carried
    assert.ok(r.reverted.includes('src/api/b.txt')) // the cross-objective edit was dropped
    // and the integrated tree still has the ORIGINAL src/api/b.txt (HACK never landed)
    assert.equal(git(dir, 'show', `${r.sha}:src/api/b.txt`), '1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrate handles an in-scope DELETE', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/auth/old.txt', 'remove me')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    rmSync(join(dir, 'src/auth/old.txt'))
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'child deletes old')
    const childHead = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'reset', '--hard', lastGood)

    const r = squashIntegrate(dir, lastGood, childHead, (p) => editScopeAllowed(p, 'src/auth', []))
    assert.equal(r.advanced, true)
    assert.equal(git(dir, 'rev-parse', `${r.sha}^`), lastGood)
    // old.txt is gone in the candidate
    assert.throws(() => git(dir, 'show', `${r.sha}:src/auth/old.txt`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrate does NOT advance when the child changed nothing IN-SCOPE (all edits out of scope)', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    write(dir, 'src/api/b.txt', '2') // only out-of-scope
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'child')
    const childHead = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'reset', '--hard', lastGood)

    const r = squashIntegrate(dir, lastGood, childHead, (p) => editScopeAllowed(p, 'src/auth', []))
    assert.equal(r.advanced, false)
    assert.equal(r.sha, lastGood) // last-good unchanged
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrate does NOT advance for an all-empty (zero tree change) child', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'empty baseline')
    const childHead = git(dir, 'rev-parse', 'HEAD')

    const r = squashIntegrate(dir, lastGood, childHead, (p) => editScopeAllowed(p, 'src/auth', []))
    assert.equal(r.advanced, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
