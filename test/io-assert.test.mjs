// test/io-assert.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCase, judgeCases } from '../scorers/io-assert.mjs'

const IO = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-assert.mjs')
const run = (output, args) => spawnSync('node', [IO, '--output', output, ...args], { encoding: 'utf8' })
const artifact = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'io-')), 'impl.mjs'); writeFileSync(p, src); return p }

test('parseCase splits IN=>OUT as JSON values', () => {
  assert.deepEqual(parseCase('5=>1'), { input: 5, output: 1 })
  assert.deepEqual(parseCase('3=>"fizz"'), { input: 3, output: 'fizz' })
  assert.deepEqual(parseCase('4=>true'), { input: 4, output: true })
})

test('judgeCases passes when every inert result deep-equals its expected output, fails on a mismatch', () => {
  assert.equal(judgeCases([{ value: 1 }, { value: -1 }], [{ input: 5, output: 1 }, { input: -3, output: -1 }]).pass, true)
  assert.equal(judgeCases([{ value: 0 }], [{ input: 5, output: 1 }]).pass, false)
})

test('judgeCases fails a case the artifact threw on (per-case error, not a crash)', () => {
  const r = judgeCases([{ threw: true, error: 'boom' }], [{ input: 5, output: 1 }])
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /boom/)
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

test('io-assert: a fn returning undefined FAILS a =>null case (undefined !== null; not coerced)', () => {
  // io-trace normalizes a VOID method to null by design; a pure value-check must NOT — undefined is an anomaly.
  const a = artifact('export const f = () => undefined\n')
  const r = run(a, ['--fn', 'f', '--case', '1=>null'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('io-assert exits 2 when the named export is missing', () => {
  const a = artifact('export const g = 1\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '5=>1']).status, 2)
})

test('io-assert --rel targets a file inside the --output root (scope mode)', () => {
  const root = mkdtempSync(join(tmpdir(), 'io-rel-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'm.mjs'), 'export const f = (n) => n * 2\n')
  const r = run(root, ['--rel', 'src/m.mjs', '--fn', 'f', '--case', '3=>6'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('io-assert --rel rejects a path escaping the root (exit 2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'io-rel-'))
  assert.equal(run(root, ['--rel', '../evil.mjs', '--fn', 'f', '--case', '1=>1']).status, 2)
})

test('io-assert scope mode: a checked file importing a repo sibling ACROSS dirs still loads (readRoot grant)', () => {
  const root = mkdtempSync(join(tmpdir(), 'io-xdir-'))
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'helper.mjs'), 'export const dbl = (n) => n * 2\n')
  writeFileSync(join(root, 'src', 'm.mjs'), "import { dbl } from '../lib/helper.mjs'\nexport const f = (n) => dbl(n) + 1\n")
  const r = run(root, ['--rel', 'src/m.mjs', '--fn', 'f', '--case', '3=>7'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 100)
})
