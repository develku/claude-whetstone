// test/scorer-safety.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scorerStem, isUnsafeScorer } from '../src/scorer-safety.mjs'

test('scorerStem strips ALL extensions and lowercases', () => {
  assert.equal(scorerStem('/a/composite.mjs'), 'composite')
  assert.equal(scorerStem('/a/composite.v2.mjs'), 'composite') // multi-extension dodge
  assert.equal(scorerStem('/a/Composite.mjs'), 'composite') // case dodge
  assert.equal(scorerStem('/a/composite'), 'composite') // no-extension dodge
  assert.equal(scorerStem('rel/test-pass-rate.backup.mjs'), 'test-pass-rate')
})

const DENY = new Set(['composite', 'test-pass-rate'])

test('isUnsafeScorer catches name-stem variants of a denylisted scorer (the Phase A bypasses)', () => {
  assert.equal(isUnsafeScorer('/a/composite.mjs', DENY), true)
  assert.equal(isUnsafeScorer('/a/composite.v2.mjs', DENY), true)
  assert.equal(isUnsafeScorer('/a/Composite.mjs', DENY), true)
  assert.equal(isUnsafeScorer('/a/composite', DENY), true)
  assert.equal(isUnsafeScorer('/a/test-pass-rate.copy.mjs', DENY), true)
})

test('isUnsafeScorer allows a genuinely different scorer', () => {
  assert.equal(isUnsafeScorer('/a/io-assert.mjs', DENY), false)
  assert.equal(isUnsafeScorer('/a/contains.mjs', DENY), false)
})

test('isUnsafeScorer catches a symlink to a shipped-unsafe scorer by realpath (name-stem cannot)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scorer-safety-'))
  const target = join(dir, 'real-unsafe.mjs')
  writeFileSync(target, '// pretend command-executing scorer\n')
  const link = join(dir, 'innocent.mjs')
  symlinkSync(target, link)
  // stem 'innocent' is NOT in the denylist, but realpath(link) === realpath(target)
  assert.equal(isUnsafeScorer(link, new Set(['nothing']), [target]), true)
  // a non-symlinked unrelated file is still allowed
  const other = join(dir, 'safe.mjs')
  writeFileSync(other, '// ok\n')
  assert.equal(isUnsafeScorer(other, new Set(['nothing']), [target]), false)
})

test('isUnsafeScorer tolerates a missing path (falls through to name-stem only)', () => {
  assert.equal(isUnsafeScorer('/does/not/exist/foo.mjs', DENY, ['/also/missing.mjs']), false)
  assert.equal(isUnsafeScorer('/does/not/exist/composite.v9.mjs', DENY, ['/also/missing.mjs']), true)
})
