import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scopeChanged, enforceReadOnly } from '../src/scope-guard.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-scope-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 't')
  return dir
}

test('scopeChanged is false on a clean tree and true after an edit', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.js'), 'x')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    assert.equal(scopeChanged(dir), false)
    writeFileSync(join(dir, 'a.js'), 'y')
    assert.equal(scopeChanged(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enforceReadOnly reverts edits to read-only paths, keeps in-scope edits (risk #1)', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'src.js'), 'src')
    writeFileSync(join(dir, 'gate.txt'), 'PASS')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    // an edit that ALSO tampers with the gate it is scored by + sneaks in a fake test
    writeFileSync(join(dir, 'src.js'), 'src-edited')
    writeFileSync(join(dir, 'gate.txt'), 'ALWAYS PASS') // moat breach attempt
    writeFileSync(join(dir, 'sneaky.test.js'), 'fake') // new file under a read-only glob
    const r = enforceReadOnly(dir, ['gate.txt', 'sneaky.test.js'])
    assert.equal(r.violated, true)
    assert.equal(readFileSync(join(dir, 'gate.txt'), 'utf8'), 'PASS') // reverted
    assert.equal(existsSync(join(dir, 'sneaky.test.js')), false) // removed
    assert.equal(readFileSync(join(dir, 'src.js'), 'utf8'), 'src-edited') // in-scope edit kept
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The two clean-pass returns. Both are live on every real run — a scope run with no --read-only takes the
// first on every pass, and a well-behaved editor takes the second — so neither is defensive code.
test('enforceReadOnly is a no-op when no read-only paths are declared', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'src.js'), 'src')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    writeFileSync(join(dir, 'src.js'), 'src-edited')
    assert.deepEqual(enforceReadOnly(dir, []), { violated: false, reverted: [] })
    assert.equal(readFileSync(join(dir, 'src.js'), 'utf8'), 'src-edited') // nothing reverted
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enforceReadOnly leaves a well-behaved pass untouched (read-only paths declared, none touched)', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'src.js'), 'src')
    writeFileSync(join(dir, 'gate.txt'), 'PASS')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    writeFileSync(join(dir, 'src.js'), 'src-edited') // in-scope only — the gate is untouched
    assert.deepEqual(enforceReadOnly(dir, ['gate.txt']), { violated: false, reverted: [] })
    assert.equal(readFileSync(join(dir, 'src.js'), 'utf8'), 'src-edited') // the good edit survives
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
