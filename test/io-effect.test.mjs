// test/io-effect.test.mjs
// io-effect: the DATA-only ARGUMENT-MUTATION / IO-SIDE-EFFECT scorer. Where io-trace asserts the RETURNS of a
// method sequence on a constructed subject, io-effect asserts the POST-CALL STATE of a carried mutable first
// argument (the "sink") across a call sequence fn(sink, ...args) — the surface where the contract is a side
// effect (in-place mutation, an accumulator/logger) and the return is often undefined. Args are DATA (JSON).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluateEffect, canonicalData } from '../scorers/io-effect.mjs'

const MOD = {
  logEvent: (sink, e) => { sink.push(e) },           // sink-pusher (side effect, returns undefined)
  noop: () => {},                                     // gamed: does nothing
  sortInPlace: (arr) => { arr.sort((a, b) => a - b) },// in-place mutation
  fakeSort: (arr) => [...arr].sort((a, b) => a - b),  // gamed: returns sorted but LEAVES the input untouched
  tally: (counts, k) => { counts[k] = (counts[k] ?? 0) + 1 }, // accumulator object
  push1: (s, v) => s.push(v),                          // Array.push returns the new length (return side)
  boom: () => { throw new Error('boom') },
}

test('evaluateEffect: a sink-pusher mutates the carried first arg across the sequence -> pass', () => {
  const r = evaluateEffect(MOD, { fnName: 'logEvent', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'] })
  assert.equal(r.pass, true)
})

test('evaluateEffect: a no-op gamed impl that does NOT mutate the sink -> fail', () => {
  const r = evaluateEffect(MOD, { fnName: 'noop', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'] })
  assert.equal(r.pass, false)
})

test('evaluateEffect: an in-place sort passes; a non-mutating "sort" (returns sorted, leaves input) FAILS', () => {
  assert.equal(evaluateEffect(MOD, { fnName: 'sortInPlace', sink: [3, 1, 2], calls: [[]], expectSink: [1, 2, 3] }).pass, true)
  // fakeSort is exactly the surface io-trace/io-assert would MISS — it returns the right value but never mutates
  assert.equal(evaluateEffect(MOD, { fnName: 'fakeSort', sink: [3, 1, 2], calls: [[]], expectSink: [1, 2, 3] }).pass, false)
})

test('evaluateEffect: an accumulator object sink', () => {
  const r = evaluateEffect(MOD, { fnName: 'tally', sink: {}, calls: [['x'], ['x'], ['y']], expectSink: { x: 2, y: 1 } })
  assert.equal(r.pass, true)
})

test('evaluateEffect: expectReturns (optional) asserts the OUTPUT side too', () => {
  assert.equal(evaluateEffect(MOD, { fnName: 'push1', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'], expectReturns: [1, 2] }).pass, true)
  assert.equal(evaluateEffect(MOD, { fnName: 'push1', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'], expectReturns: [99, 99] }).pass, false)
})

test('evaluateEffect: a call that throws fails (not a silent pass)', () => {
  const r = evaluateEffect(MOD, { fnName: 'boom', sink: [], calls: [[]], expectSink: [] })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /boom/i)
})

test('evaluateEffect: a missing export is a fail with a clear reason', () => {
  const r = evaluateEffect(MOD, { fnName: 'ghost', sink: [], calls: [[]], expectSink: [] })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /export|ghost|function/i)
})

// SECURITY (codex review): the artifact controls the sink object, so the post-call read must NOT be foolable.
test('FORGE DEFENSE: a sink with a toJSON that returns the expected state does NOT pass (toJSON is never invoked)', () => {
  // a gamed mutator that installs sink.toJSON = () => expected on an OBJECT sink, leaving the real state empty:
  // canonicalData walks the own data props, hits toJSON (a function) and rejects it — it is never CALLED.
  const mod = { forge: (sink) => { sink.toJSON = () => ({ x: 1 }) } }
  const r = evaluateEffect(mod, { fnName: 'forge', sink: {}, calls: [[]], expectSink: { x: 1 } })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /not plain JSON|function/i)
  // and on an ARRAY sink the toJSON is simply ignored (map walks indices), so the REAL empty state loses anyway
  const r2 = evaluateEffect({ forge: (s) => { s.toJSON = () => ['a'] } }, { fnName: 'forge', sink: [], calls: [[]], expectSink: ['a'] })
  assert.equal(r2.pass, false)
  assert.deepEqual(r2.failing.gotSink, []) // the un-forged real state, not the toJSON output
})

test('FORGE DEFENSE: a getter that forges the expected value does NOT pass', () => {
  const mod = { forge: (sink) => { Object.defineProperty(sink, 'x', { get: () => 1, enumerable: true }) } }
  const r = evaluateEffect(mod, { fnName: 'forge', sink: {}, calls: [[]], expectSink: { x: 1 } })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /accessor|not plain JSON/i)
})

test('FORGE DEFENSE: a cyclic sink scores 0 (artifact failure), never a scorer crash', () => {
  const mod = { cyc: (sink) => { sink.self = sink } }
  const r = evaluateEffect(mod, { fnName: 'cyc', sink: {}, calls: [[]], expectSink: { self: {} } })
  assert.equal(r.pass, false)
  assert.match(r.failing.error, /cyclic|not plain JSON/i)
})

test('canonicalData: accepts plain JSON, rejects undefined/BigInt/function/non-finite/non-plain proto', () => {
  assert.deepEqual(canonicalData({ a: [1, 'x', true, null], b: {} }), { a: [1, 'x', true, null], b: {} })
  assert.throws(() => canonicalData([undefined]), /non-JSON/) // an EXPLICIT undefined element still throws
  assert.throws(() => canonicalData(10n), /non-JSON/)
  assert.throws(() => canonicalData(NaN), /non-finite/)
  assert.throws(() => canonicalData(new Map()), /non-plain/)
})

test('canonicalData: a sparse array hole normalizes to null (JSON array semantics) — no false negative', () => {
  const sparse = []; sparse[2] = 'c' // holes at 0,1
  assert.deepEqual(canonicalData(sparse), [null, null, 'c'])
  // a shared sub-object (DAG/diamond) is allowed; only a true cycle throws
  const shared = { x: 1 }
  assert.deepEqual(canonicalData({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } })
})

test('evaluateEffect: an honest impl that index-assigns into a fresh array (creating holes) is NOT false-rejected', () => {
  const mod = { fill: (sink) => { sink[2] = 'c' } } // sink starts [null,null] -> sink[2]='c' -> [null,null,'c']
  const r = evaluateEffect(mod, { fnName: 'fill', sink: [null, null], calls: [[]], expectSink: [null, null, 'c'] })
  assert.equal(r.pass, true)
})

// CLI end-to-end (mirrors io-trace's contract).
const SCORER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-effect.mjs')
const runCli = (output, args) => {
  const res = spawnSync('node', [SCORER, '--output', output, ...args], { encoding: 'utf8' })
  return { status: res.status, out: res.stdout, err: res.stderr }
}

test('io-effect CLI: score 100 on an honest in-place sort, 0 on a non-mutating gamed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ioeffect-'))
  const honest = join(dir, 'honest.mjs')
  writeFileSync(honest, 'export const sortInPlace = (arr) => { arr.sort((a, b) => a - b) }\n')
  const gamed = join(dir, 'gamed.mjs')
  writeFileSync(gamed, 'export const sortInPlace = (arr) => [...arr].sort((a, b) => a - b)\n') // returns sorted, leaves input
  const args = ['--fn', 'sortInPlace', '--sink', JSON.stringify([3, 1, 2]), '--calls', JSON.stringify([[]]), '--expect-sink', JSON.stringify([1, 2, 3])]
  const ok = runCli(honest, args)
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.out).score, 100)
  const bad = runCli(gamed, args)
  assert.equal(bad.status, 0)
  assert.equal(JSON.parse(bad.out).score, 0)
})

test('io-effect CLI: --rel joins --output root + relative file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ioeffect-rel-'))
  writeFileSync(join(dir, 'impl.mjs'), 'export const logEvent = (sink, e) => { sink.push(e) }\n')
  const res = runCli(dir, ['--rel', 'impl.mjs', '--fn', 'logEvent', '--sink', '[]', '--calls', JSON.stringify([['a']]), '--expect-sink', JSON.stringify(['a'])])
  assert.equal(res.status, 0)
  assert.equal(JSON.parse(res.out).score, 100)
})

test('io-effect CLI: exits 2 on scorer errors (missing --sink, bad --calls JSON, calls not array-of-arrays)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ioeffect-'))
  const f = join(dir, 'a.mjs'); writeFileSync(f, 'export const f = (s) => {}\n')
  assert.equal(runCli(f, ['--fn', 'f', '--calls', '[[]]', '--expect-sink', '[]']).status, 2) // missing --sink
  assert.equal(runCli(f, ['--fn', 'f', '--sink', '[]', '--calls', 'not json', '--expect-sink', '[]']).status, 2) // bad --calls
  assert.equal(runCli(f, ['--fn', 'f', '--sink', '[]', '--calls', '[1,2]', '--expect-sink', '[]']).status, 2) // calls not array-of-arrays
  assert.equal(runCli(f, ['--fn', 'f', '--sink', '[]', '--calls', '[[]]']).status, 2) // missing --expect-sink
})

test('io-effect CLI: --expect-returns asserts returns end-to-end; a length != calls length is a scorer error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ioeffect-ret-'))
  writeFileSync(join(dir, 'impl.mjs'), 'export const push1 = (s, v) => s.push(v)\n') // returns the new length
  const ok = runCli(join(dir, 'impl.mjs'), ['--fn', 'push1', '--sink', '[]', '--calls', JSON.stringify([['a'], ['b']]), '--expect-sink', JSON.stringify(['a', 'b']), '--expect-returns', JSON.stringify([1, 2])])
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.out).score, 100)
  // length mismatch (2 calls, 1 expected return) -> scorer error exit 2
  const bad = runCli(join(dir, 'impl.mjs'), ['--fn', 'push1', '--sink', '[]', '--calls', JSON.stringify([['a'], ['b']]), '--expect-sink', JSON.stringify(['a', 'b']), '--expect-returns', JSON.stringify([1])])
  assert.equal(bad.status, 2)
})
