import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseScopeCli, cleanTreeGuard } from '../src/scope-cli.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

test('parseScopeCli maps --scope to the artifact and parses --read-only', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'make tests pass', '--scope', '/repo', '--scorer', 'npm test', '--read-only', 'test/,gate.txt', '--cap', '20'])
  assert.equal(cfg.goal, 'make tests pass')
  assert.equal(cfg.scope, '/repo')
  assert.equal(cfg.artifactPath, '/repo') // the scope dir IS the artifact the loop carries
  assert.equal(cfg.scorerCmd, 'npm test')
  assert.deepEqual(cfg.readOnly, ['test/', 'gate.txt'])
  assert.equal(cfg.hardCap, 20)
})

test('cleanTreeGuard refuses a dirty tree, allows a clean one (risk #2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-guard-'))
  try {
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'x'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    assert.equal(cleanTreeGuard(dir).ok, true) // clean
    writeFileSync(join(dir, 'a.txt'), 'dirty')
    assert.equal(cleanTreeGuard(dir).ok, false) // uncommitted change -> refuse (reset --hard would clobber it)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanTreeGuard refuses a non-git path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-nogit-'))
  try {
    assert.equal(cleanTreeGuard(dir).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
