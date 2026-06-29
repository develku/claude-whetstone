// test/io-trace.test.mjs — judgeTrace (parent oracle) unit tests + CLI end-to-end (full isolation).
// The EXECUTE half (construction/replay/canonicalData forge-defense) is tested in test/iso-execute.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { judgeTrace } from '../scorers/io-trace.mjs'

test('judgeTrace: matching returns pass; a mismatch reports observed vs expected', () => {
  assert.equal(judgeTrace([null, null, 2, 1], [null, null, 2, 1]).pass, true)
  const r = judgeTrace([1, 2, 2], [1, 2, 99])
  assert.equal(r.pass, false)
  assert.deepEqual(r.failing.got, [1, 2, 2])
  assert.deepEqual(r.failing.expected, [1, 2, 99])
})

const SCORER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-trace.mjs')
const runCli = (output, args) => {
  const res = spawnSync('node', [SCORER, '--output', output, ...args], { encoding: 'utf8' })
  return { status: res.status, out: res.stdout, err: res.stderr }
}

test('io-trace CLI: score 100 on an honest stateful artifact, 0 on a gamed one (out-of-process)', () => {
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

test('io-trace CLI: a gamed artifact that monkeypatches the oracle still scores 0 (isolation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const f = join(dir, 'g.mjs')
  // patch assert in the child + return wrong values: the parent oracle is untouched.
  writeFileSync(f, "import a from 'node:assert/strict'\na.deepEqual=()=>{}\nexport const make = () => ({ inc(){ return 999 } })\n")
  const r = runCli(f, ['--factory', 'make', '--trace', JSON.stringify([['inc']]), '--expect', JSON.stringify([1])])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.out).score, 0)
})

test('io-trace CLI: a missing export is a score-0 verdict (not exit 2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const f = join(dir, 'a.mjs'); writeFileSync(f, 'export const other = 1\n')
  const r = runCli(f, ['--factory', 'ghost', '--trace', '[["x"]]', '--expect', '[1]'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.out).score, 0)
})

test('io-trace CLI: exits 2 on a malformed --trace (not a silent verdict)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const f = join(dir, 'a.mjs'); writeFileSync(f, 'export class Stack {}\n')
  const res = runCli(f, ['--new', 'Stack', '--trace', 'not json', '--expect', '[]'])
  assert.equal(res.status, 2)
})

// The CLI contract-enforcement guards (lowest branch coverage in the repo): a malformed verifier spec must
// be a scorer ERROR (exit 2), never a silent wrong verdict. Pins the four guards so a regression that
// weakened any of them would be caught (cf. the sibling io-effect.test.mjs convention).
test('io-trace CLI: exits 2 on contract-violating arg shapes (subject mode + trace/expect/init shapes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iotrace-'))
  const f = join(dir, 'a.mjs'); writeFileSync(f, 'export class Stack {}\nexport const make = () => ({ inc() { return 1 } })\n')
  // both --new and --factory -> mutual-exclusion guard
  assert.equal(runCli(f, ['--new', 'Stack', '--factory', 'make', '--trace', '[["x"]]', '--expect', '[1]']).status, 2)
  // valid JSON but not an array-of-arrays -> --trace shape guard
  assert.equal(runCli(f, ['--factory', 'make', '--trace', '[1,2]', '--expect', '[]']).status, 2)
  // scalar (non-array) --expect -> --expect shape guard
  assert.equal(runCli(f, ['--factory', 'make', '--trace', '[["inc"]]', '--expect', '5']).status, 2)
  // scalar (non-array) --init -> --init shape guard
  assert.equal(runCli(f, ['--factory', 'make', '--trace', '[["inc"]]', '--expect', '[1]', '--init', '5']).status, 2)
})
