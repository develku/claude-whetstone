// test/io-effect.test.mjs
// io-effect: the DATA-only ARGUMENT-MUTATION / IO-SIDE-EFFECT scorer. Where io-trace asserts the RETURNS of a
// method sequence on a constructed subject, io-effect asserts the POST-CALL STATE of a carried mutable first
// argument (the "sink") across a call sequence fn(sink, ...args). The EXECUTE half (run + canonicalData-snapshot
// the sink) lives in src/iso-execute and runs out-of-process under #2; the JUDGE (deep-equal) runs in-parent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { judgeEffect } from '../scorers/io-effect.mjs'
import { executeEffect } from '../src/iso-execute.mjs'
import { canonicalData } from '../src/canonical-data.mjs'

// Compose the two halves the way the scorer does, so these unit tests mirror the old evaluateEffect contract.
const evalEffect = (mod, { fnName, sink, calls, expectSink, expectReturns }) => {
  const obs = executeEffect(mod, { fn: fnName, sink, calls, wantReturns: expectReturns !== undefined })
  if (!obs.ok) return { pass: false, failing: { error: obs.error || obs.reason } }
  return judgeEffect(obs, expectSink, expectReturns)
}

const MOD = {
  logEvent: (sink, e) => { sink.push(e) },           // sink-pusher (side effect, returns undefined)
  noop: () => {},                                     // gamed: does nothing
  sortInPlace: (arr) => { arr.sort((a, b) => a - b) },// in-place mutation
  fakeSort: (arr) => [...arr].sort((a, b) => a - b),  // gamed: returns sorted but LEAVES the input untouched
  tally: (counts, k) => { counts[k] = (counts[k] ?? 0) + 1 }, // accumulator object
  push1: (s, v) => s.push(v),                          // Array.push returns the new length (return side)
  boom: () => { throw new Error('boom') },
}

test('effect: a sink-pusher mutates the carried first arg across the sequence -> pass', () => {
  assert.equal(evalEffect(MOD, { fnName: 'logEvent', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'] }).pass, true)
})

test('effect: a no-op gamed impl that does NOT mutate the sink -> fail', () => {
  assert.equal(evalEffect(MOD, { fnName: 'noop', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'] }).pass, false)
})

test('effect: in-place sort passes; a non-mutating "sort" (returns sorted, leaves input) FAILS', () => {
  assert.equal(evalEffect(MOD, { fnName: 'sortInPlace', sink: [3, 1, 2], calls: [[]], expectSink: [1, 2, 3] }).pass, true)
  assert.equal(evalEffect(MOD, { fnName: 'fakeSort', sink: [3, 1, 2], calls: [[]], expectSink: [1, 2, 3] }).pass, false)
})

test('effect: an accumulator object sink', () => {
  assert.equal(evalEffect(MOD, { fnName: 'tally', sink: {}, calls: [['x'], ['x'], ['y']], expectSink: { x: 2, y: 1 } }).pass, true)
})

test('effect: expectReturns (optional) asserts the OUTPUT side too', () => {
  assert.equal(evalEffect(MOD, { fnName: 'push1', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'], expectReturns: [1, 2] }).pass, true)
  assert.equal(evalEffect(MOD, { fnName: 'push1', sink: [], calls: [['a'], ['b']], expectSink: ['a', 'b'], expectReturns: [99, 99] }).pass, false)
})

test('effect: a call that throws fails (not a silent pass)', () => {
  const r = evalEffect(MOD, { fnName: 'boom', sink: [], calls: [[]], expectSink: [] })
  assert.equal(r.pass, false); assert.match(r.failing.error, /boom/i)
})

test('effect: a missing export fails with a clear reason', () => {
  const r = evalEffect(MOD, { fnName: 'ghost', sink: [], calls: [[]], expectSink: [] })
  assert.equal(r.pass, false); assert.match(r.failing.error, /export|ghost|function/i)
})

// FORGE DEFENSE (executeEffect snapshots via canonicalData — never invokes toJSON/getters on the sink):
test('FORGE DEFENSE: a sink.toJSON returning the expected state does NOT pass (toJSON never invoked)', () => {
  const r = evalEffect({ forge: (sink) => { sink.toJSON = () => ({ x: 1 }) } }, { fnName: 'forge', sink: {}, calls: [[]], expectSink: { x: 1 } })
  assert.equal(r.pass, false); assert.match(r.failing.error, /not plain JSON|function/i)
  // on an ARRAY sink the toJSON is simply ignored (index walk), so the REAL empty state loses anyway
  const obs = executeEffect({ forge: (s) => { s.toJSON = () => ['a'] } }, { fn: 'forge', sink: [], calls: [[]] })
  assert.deepEqual(obs.finalSink, []) // the un-forged real state
  assert.equal(judgeEffect(obs, ['a']).pass, false)
})

test('FORGE DEFENSE: a getter forging the expected value does NOT pass', () => {
  const r = evalEffect({ forge: (sink) => { Object.defineProperty(sink, 'x', { get: () => 1, enumerable: true }) } }, { fnName: 'forge', sink: {}, calls: [[]], expectSink: { x: 1 } })
  assert.equal(r.pass, false); assert.match(r.failing.error, /accessor|not plain JSON/i)
})

test('FORGE DEFENSE: a cyclic sink scores 0 (artifact failure), never a scorer crash', () => {
  const r = evalEffect({ cyc: (sink) => { sink.self = sink } }, { fnName: 'cyc', sink: {}, calls: [[]], expectSink: { self: {} } })
  assert.equal(r.pass, false); assert.match(r.failing.error, /cyclic|not plain JSON/i)
})

test('canonicalData: accepts plain JSON, rejects undefined/BigInt/function/non-finite/non-plain proto', () => {
  assert.deepEqual(canonicalData({ a: [1, 'x', true, null], b: {} }), { a: [1, 'x', true, null], b: {} })
  assert.throws(() => canonicalData([undefined]), /non-JSON/)
  assert.throws(() => canonicalData(10n), /non-JSON/)
  assert.throws(() => canonicalData(NaN), /non-finite/)
  assert.throws(() => canonicalData(new Map()), /non-plain/)
})

test('effect: an honest impl that index-assigns into a fresh array (creating holes) is NOT false-rejected', () => {
  const r = evalEffect({ fill: (sink) => { sink[2] = 'c' } }, { fnName: 'fill', sink: [null, null], calls: [[]], expectSink: [null, null, 'c'] })
  assert.equal(r.pass, true)
})

// CLI end-to-end (full out-of-process isolation).
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
  assert.equal(JSON.parse(runCli(honest, args).out).score, 100)
  assert.equal(JSON.parse(runCli(gamed, args).out).score, 0)
})

test('io-effect CLI: a gamed artifact monkeypatching the oracle still scores 0 (isolation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ioeffect-'))
  const f = join(dir, 'g.mjs')
  writeFileSync(f, "import a from 'node:assert/strict'\na.deepEqual=()=>{}\nexport const sortInPlace = (arr) => {}\n") // never mutates, but neuters assert
  const r = runCli(f, ['--fn', 'sortInPlace', '--sink', JSON.stringify([3, 1, 2]), '--calls', '[[]]', '--expect-sink', JSON.stringify([1, 2, 3])])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.out).score, 0)
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
  assert.equal(JSON.parse(ok.out).score, 100)
  const bad = runCli(join(dir, 'impl.mjs'), ['--fn', 'push1', '--sink', '[]', '--calls', JSON.stringify([['a'], ['b']]), '--expect-sink', JSON.stringify(['a', 'b']), '--expect-returns', JSON.stringify([1])])
  assert.equal(bad.status, 2)
})
