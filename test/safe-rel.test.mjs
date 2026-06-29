// test/safe-rel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveOutput } from '../src/safe-rel.mjs'

test('resolveOutput returns --output unchanged when no --rel', () => {
  assert.equal(resolveOutput('/repo', undefined), '/repo')
  assert.equal(resolveOutput('/repo', ''), '/repo')
})

test('resolveOutput joins a repo-relative rel onto output (resolved absolute)', () => {
  assert.equal(resolveOutput('/repo', 'src/x.mjs'), resolve('/repo', 'src/x.mjs'))
  assert.equal(resolveOutput('/repo/', 'a/b/c.mjs'), resolve('/repo', 'a/b/c.mjs'))
})

test('resolveOutput rejects a rel that escapes --output (CR#5 containment)', () => {
  assert.throws(() => resolveOutput('/repo', '../evil.mjs'), /escape/i)
  assert.throws(() => resolveOutput('/repo', 'a/../../evil.mjs'), /escape/i)
})

test('resolveOutput rejects an absolute rel', () => {
  assert.throws(() => resolveOutput('/repo', '/etc/passwd'), /absolute|relative/i)
})

test('resolveOutput rejects an in-scope symlink whose target escapes --output (realpath containment, not just lexical)', () => {
  // The lexical guard is realpath-blind: an in-scope symlink pointing OUTSIDE --output passes it, and the
  // caller (readFileSync / await import) FOLLOWS the link — an out-of-repo read + import-RCE. Block it.
  const scope = mkdtempSync(join(tmpdir(), 'saferel-'))
  const outside = mkdtempSync(join(tmpdir(), 'saferel-out-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(scope, 'ext')) // in-scope symlink -> external dir
    assert.throws(() => resolveOutput(scope, 'ext/secret.txt'), /symlink|escape/i)
    writeFileSync(join(scope, 'real.txt'), 'y')
    assert.equal(resolveOutput(scope, 'real.txt'), resolve(scope, 'real.txt')) // a genuine in-scope file still resolves
    // a not-yet-materialized path has no symlink to follow — must return the lexical path, not throw
    assert.equal(resolveOutput(scope, 'src/notyet.mjs'), resolve(scope, 'src/notyet.mjs'))
  } finally {
    rmSync(scope, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
