// test/iso-execute.test.mjs — the child-side EXECUTE half (run the artifact, snapshot via canonicalData).
// These run in-process with a fake `mod` (no isolation needed to test the execution/snapshot logic); the
// out-of-process security property is proven end-to-end in test/iso-runner.test.mjs + the exploit archive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeAssert, executeTrace, executeEffect, executeInvariants } from '../src/iso-execute.mjs'

// ---- executeAssert ----
test('executeAssert: runs each case, spreads array inputs, snapshots the return', () => {
  const mod = { add: (a, b) => a + b, sign: (n) => Math.sign(n) }
  const r = executeAssert(mod, { fn: 'add', cases: [[1, 2], [10, 5]] })
  assert.deepEqual(r, { ok: true, results: [{ value: 3 }, { value: 15 }] })
  const s = executeAssert(mod, { fn: 'sign', cases: [5, -3] }) // scalar => single arg
  assert.deepEqual(s.results, [{ value: 1 }, { value: -1 }])
})

test('executeAssert: a missing export is flagged distinctly (parent maps it to exit 2)', () => {
  assert.deepEqual(executeAssert({ g: 1 }, { fn: 'f', cases: [1] }), { ok: false, reason: 'missing-export', name: 'f' })
})

test('executeAssert: a throwing case is captured per-case (not a crash)', () => {
  const r = executeAssert({ f: () => { throw new Error('boom') } }, { fn: 'f', cases: [1] })
  assert.equal(r.results[0].threw, true)
  assert.match(r.results[0].error, /boom/)
})

test('executeAssert: a getter/toJSON forge return is rejected (canonicalData), scored as a failed case', () => {
  const gamed = { f: () => { const o = {}; Object.defineProperty(o, 'v', { get: () => 1, enumerable: true }); return o } }
  const r = executeAssert(gamed, { fn: 'f', cases: [1] })
  assert.equal(r.results[0].threw, true) // not a real value the parent could deep-equal to expected
})

// ---- executeTrace ----
class Stack { constructor() { this.a = [] } push(x) { this.a.push(x) } pop() { return this.a.pop() } size() { return this.a.length } }
const makeCounter = (start = 0) => { let n = start; return { inc() { return ++n }, value() { return n } } }

test('executeTrace: class subject replays a sequence; void method -> null', () => {
  const r = executeTrace({ Stack }, { newName: 'Stack', steps: [['push', 1], ['push', 2], ['pop'], ['size']] })
  assert.deepEqual(r, { ok: true, returns: [null, null, 2, 1] })
})

test('executeTrace: factory + init', () => {
  assert.deepEqual(executeTrace({ makeCounter }, { factoryName: 'makeCounter', init: [10], steps: [['inc'], ['value']] }).returns, [11, 11])
})

test('executeTrace: missing export flagged; missing method is an artifact failure', () => {
  assert.equal(executeTrace({}, { newName: 'Ghost', steps: [['x']] }).reason, 'missing-export')
  const r = executeTrace({ Stack }, { newName: 'Stack', steps: [['nope']] })
  assert.equal(r.ok, false); assert.match(r.error, /method|nope/i)
})

test('executeTrace: a toJSON forge return never passes (canonicalData rejects, never invokes)', () => {
  const mod = { make: () => ({ get: () => ({ real: 'WRONG', toJSON: () => 42 }) }) }
  const r = executeTrace(mod, { factoryName: 'make', steps: [['get']] })
  assert.equal(r.ok, false); assert.match(r.error, /plain JSON|function/i)
})

test('executeTrace: a getter forge return is rejected (accessor never read)', () => {
  const mod = { make: () => ({ get: () => { const o = {}; Object.defineProperty(o, 'v', { get: () => 1, enumerable: true }); return o } }) }
  const r = executeTrace(mod, { factoryName: 'make', steps: [['get']] })
  assert.equal(r.ok, false); assert.match(r.error, /accessor|plain JSON/i)
})

test('executeTrace: a cyclic return is an artifact failure, never a scorer crash', () => {
  const mod = { make: () => ({ get: () => { const o = {}; o.self = o; return o } }) }
  const r = executeTrace(mod, { factoryName: 'make', steps: [['get']] })
  assert.equal(r.ok, false); assert.match(r.error, /cyclic|plain JSON/i)
})

// ---- executeEffect ----
test('executeEffect: mutates the carried sink in place; reports finalSink + returns (wantReturns)', () => {
  const mod = { pushAll: (sink, ...xs) => { for (const x of xs) sink.push(x); return sink.length } }
  const r = executeEffect(mod, { fn: 'pushAll', sink: [], calls: [[1, 2], [3]], wantReturns: true })
  assert.deepEqual(r, { ok: true, returns: [2, 3], finalSink: [1, 2, 3] })
  // without wantReturns, a void fn's returns are not snapshotted (so an undefined return is never an error)
  const v = executeEffect({ log: (s, e) => { s.push(e) } }, { fn: 'log', sink: [], calls: [['a']] })
  assert.deepEqual(v, { ok: true, returns: [], finalSink: ['a'] })
})

test('executeEffect: a sink with a forging toJSON is rejected (canonicalData)', () => {
  const mod = { f: (sink) => { Object.defineProperty(sink, 'toJSON', { value: () => ({ done: true }) }); return sink } }
  const r = executeEffect(mod, { fn: 'f', sink: {}, calls: [[]] })
  assert.equal(r.ok, true) // toJSON is a non-enumerable function prop -> canonicalData skips it, sink stays {}
  assert.deepEqual(r.finalSink, {})
})

// ---- executeInvariants ----
test('executeInvariants: reports per-case out + post-call basisLive', () => {
  const mod = { sortCopy: (a) => [...a].sort((x, y) => x - y) }
  const r = executeInvariants(mod, { fn: 'sortCopy', cases: [[[3, 1, 2]]], basis: 0 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.cases[0].out, [1, 2, 3])
  assert.deepEqual(r.cases[0].basisLive, [3, 1, 2]) // not mutated
})

test('executeInvariants: a throwing case and a Promise-returning case are flagged', () => {
  const r = executeInvariants({ f: () => { throw new Error('x') } }, { fn: 'f', cases: [[1]], basis: 0 })
  assert.equal(r.cases[0].threw, true)
  const p = executeInvariants({ f: async () => 1 }, { fn: 'f', cases: [[1]], basis: 0 })
  assert.equal(p.cases[0].promise, true)
})
