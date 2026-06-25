import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scopeChanged, buildScopePrompt, enforceReadOnly } from '../src/scope-act.mjs'

test('buildScopePrompt: editScope narrows the edit instruction', () => {
  const state = { goal: 'g', last_critique: 'do x', history: [], escalated: false }
  const p = buildScopePrompt(state, { scopeDir: '/repo', readOnly: [], editScope: 'src/auth' })
  assert.match(p, /src\/auth/)        // the focus path appears
  assert.match(p, /\/repo/)           // still anchored to the repo
})

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

test('buildScopePrompt allows multi-file edits in scope but forbids the read-only gate', () => {
  const p = buildScopePrompt(
    { goal: 'make tests pass', last_critique: 'fix the parser', history: [] },
    { scopeDir: '/repo', readOnly: ['test/', 'gate.txt'] }
  )
  assert.match(p, /make tests pass/) // goal
  assert.match(p, /fix the parser/) // critique, fenced
  assert.match(p, /\/repo/) // scope
  assert.match(p, /test\//) // names the read-only paths
  assert.match(p, /gate\.txt/)
  assert.match(p, /do not (edit|modify|touch)/i) // explicit read-only instruction
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
