// test/io-assert.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCase, evaluateCases } from '../scorers/io-assert.mjs'

const IO = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-assert.mjs')
const run = (output, args) => spawnSync('node', [IO, '--output', output, ...args], { encoding: 'utf8' })
const artifact = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'io-')), 'impl.mjs'); writeFileSync(p, src); return p }

test('parseCase splits IN=>OUT as JSON values', () => {
  assert.deepEqual(parseCase('5=>1'), { input: 5, output: 1 })
  assert.deepEqual(parseCase('3=>"fizz"'), { input: 3, output: 'fizz' })
  assert.deepEqual(parseCase('4=>true'), { input: 4, output: true })
})

test('evaluateCases passes a correct fn, fails on a mismatch', () => {
  const honest = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0)
  assert.equal(evaluateCases(honest, [{ input: 5, output: 1 }, { input: -3, output: -1 }]).pass, true)
  assert.equal(evaluateCases(() => 0, [{ input: 5, output: 1 }]).pass, false)
})

test('evaluateCases spreads an array INPUT as the argument list', () => {
  assert.equal(evaluateCases((a, b) => a + b, [{ input: [1, 2], output: 3 }]).pass, true)
  assert.equal(evaluateCases((n) => Math.sign(n), [{ input: [5], output: 1 }]).pass, true) // [5] => f(5)
})

test('io-assert scores 100 for a behaviourally-correct artifact in ANY phrasing (not brittle)', () => {
  const honest = artifact('export const f = (n) => Math.sign(n)\n') // no "n < 0" — a contains check would miss this
  const r = run(honest, ['--fn', 'f', '--case', '5=>1', '--case', '-3=>-1', '--case', '0=>0'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('io-assert scores 0 for a gamed artifact that fails a held-out case', () => {
  const gamed = artifact('export function f(n) {\n  if (n === 5) return 1\n  return 0\n}\n')
  const r = run(gamed, ['--fn', 'f', '--case', '5=>1', '--case', '-3=>-1'])
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('io-assert exits 2 when the named export is missing', () => {
  const a = artifact('export const g = 1\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '5=>1']).status, 2)
})
