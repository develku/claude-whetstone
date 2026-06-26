// test/io-trace.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { evaluateTrace } from '../scorers/io-trace.mjs'

// A fake module exercising both construction idioms.
class Stack {
  constructor() { this.a = [] }
  push(x) { this.a.push(x) }
  pop() { return this.a.pop() }
  size() { return this.a.length }
}
const makeCounter = (start = 0) => { let n = start; return { inc() { return ++n }, value() { return n } } }
const MOD = { Stack, makeCounter }

test('evaluateTrace: a class subject replays a method sequence and asserts returns (mutator -> null)', () => {
  const r = evaluateTrace(MOD, { newName: 'Stack', steps: [['push', 1], ['push', 2], ['pop'], ['size']], expect: [null, null, 2, 1] })
  assert.equal(r.pass, true)
})

test('evaluateTrace: a factory subject (closure state) over a call sequence', () => {
  const r = evaluateTrace(MOD, { factoryName: 'makeCounter', steps: [['inc'], ['inc'], ['value']], expect: [1, 2, 2] })
  assert.equal(r.pass, true)
})

test('evaluateTrace: --init args reach the constructor/factory', () => {
  const r = evaluateTrace(MOD, { factoryName: 'makeCounter', init: [10], steps: [['inc'], ['value']], expect: [11, 11] })
  assert.equal(r.pass, true)
})

test('evaluateTrace: a behaviour mismatch fails with the observed vs expected', () => {
  const r = evaluateTrace(MOD, { factoryName: 'makeCounter', steps: [['inc'], ['inc'], ['value']], expect: [1, 2, 99] })
  assert.equal(r.pass, false)
  assert.deepEqual(r.failing.got, [1, 2, 2])
})

test('evaluateTrace: a missing method is a scorer error (caught, not a silent pass)', () => {
  const r = evaluateTrace(MOD, { newName: 'Stack', steps: [['nope']], expect: [null] })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /method|nope/i)
})

test('evaluateTrace: a missing export is a scorer error', () => {
  const r = evaluateTrace(MOD, { newName: 'Ghost', steps: [['x']], expect: [null] })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /export|constructor|Ghost/i)
})

// CLI end-to-end against a real stateful artifact (mirrors io-assert's contract).
const SCORER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-trace.mjs')
const runCli = (output, args) => {
  const res = spawnSync('node', [SCORER, '--output', output, ...args], { encoding: 'utf8' })
  return { status: res.status, out: res.stdout, err: res.stderr }
}

test('io-trace CLI: score 100 on an honest stateful artifact, 0 on a gamed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const honest = join(dir, 'honest.mjs')
  writeFileSync(honest, 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n')
  const gamed = join(dir, 'gamed.mjs')
  writeFileSync(gamed, 'export const makeCounter = () => ({ inc() { return 1 }, value() { return 1 } })\n') // hardcodes the visible single-inc case
  const args = ['--factory', 'makeCounter', '--trace', JSON.stringify([['inc'], ['inc'], ['value']]), '--expect', JSON.stringify([1, 2, 2])]
  const ok = runCli(honest, args)
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.out).score, 100)
  const bad = runCli(gamed, args)
  assert.equal(bad.status, 0)
  assert.equal(JSON.parse(bad.out).score, 0)
})

test('io-trace CLI: exits 2 on a malformed --trace (not a silent verdict)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const f = join(dir, 'a.mjs'); writeFileSync(f, 'export class Stack {}\n')
  const res = runCli(f, ['--new', 'Stack', '--trace', 'not json', '--expect', '[]'])
  assert.equal(res.status, 2)
})
