// test/safe-rel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
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
