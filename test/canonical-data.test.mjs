// test/canonical-data.test.mjs
// The shared strict own-data-property walker (forge defense for io-effect's sink + io-trace's returns). The
// artifact controls the object, so the walker must never invoke a getter/toJSON and must close the forge vectors
// codex flagged: plain-object getters/toJSON, ARRAY-INDEX getters, Proxies, __proto__ output pollution, non-plain
// prototypes, symbols, BigInt, non-finite, cycles. io-effect.test.mjs covers the sink end-to-end; this pins the
// walker directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalData } from '../src/canonical-data.mjs'

test('accepts plain JSON; DAG/diamond allowed; round-trips', () => {
  const shared = { x: 1 }
  assert.deepEqual(canonicalData({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } })
  assert.deepEqual(canonicalData([1, 'x', true, null, { k: [2] }]), [1, 'x', true, null, { k: [2] }])
})

test('rejects undefined / BigInt / function / non-finite / non-plain proto', () => {
  assert.throws(() => canonicalData(undefined), /non-JSON/)
  assert.throws(() => canonicalData([undefined]), /non-JSON/) // explicit undefined element is strict
  assert.throws(() => canonicalData(10n), /non-JSON/)
  assert.throws(() => canonicalData(NaN), /non-finite/)
  assert.throws(() => canonicalData(new Map()), /non-plain/)
  assert.deepEqual(canonicalData([, , 'c']), [null, null, 'c']) // holes -> null (JSON array semantics)
})

test('FORGE: a plain-object getter / toJSON is rejected, never invoked', () => {
  assert.throws(() => canonicalData({ toJSON: () => 42 }), /non-JSON|function/) // toJSON is a function value
  const g = {}; Object.defineProperty(g, 'v', { get: () => 1, enumerable: true })
  assert.throws(() => canonicalData(g), /accessor/)
})

test('FORGE: an ARRAY-INDEX getter is rejected, never invoked (codex #1)', () => {
  const a = []; Object.defineProperty(a, '0', { get: () => 'FORGED', enumerable: true }); a.length = 1
  assert.throws(() => canonicalData(a), /accessor array index/)
})

test('FORGE: a Proxy is rejected up front (reflection would invoke traps) (codex #3)', () => {
  const p = new Proxy({}, { get: () => 'FORGED', getOwnPropertyDescriptor: () => ({ value: 'FORGED', enumerable: true, configurable: true }) })
  assert.throws(() => canonicalData(p), /proxy/i)
  const pa = new Proxy([], { get: (_t, k) => (k === 'length' ? 1 : 'FORGED') })
  assert.throws(() => canonicalData(pa), /proxy/i)
})

test('a __proto__ own data property becomes DATA, never prototype pollution (codex #4)', () => {
  const o = {}; Object.defineProperty(o, '__proto__', { value: 7, enumerable: true, writable: true, configurable: true })
  const out = canonicalData(o)
  assert.equal(Object.getPrototypeOf(out), Object.prototype) // prototype NOT polluted
  assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__').value, 7) // kept as own data
})

test('cyclic value throws (artifact failure), never a stack-overflow crash', () => {
  const c = {}; c.self = c
  assert.throws(() => canonicalData(c), /cyclic/)
})

test('PRIMORDIAL CAPTURE: a global patched AFTER module load cannot subvert the walker (codex #2)', () => {
  const realIsArray = Array.isArray
  try {
    Array.isArray = () => false // a gamed artifact patches the global before returning
    // canonicalData captured Array.isArray at module load, so it still treats [1,2] as an array (-> [1,2]),
    // not a non-plain object (Array.prototype) it would reject. A correct result here proves the capture.
    assert.deepEqual(canonicalData([1, 2]), [1, 2])
  } finally {
    Array.isArray = realIsArray // synchronous window; restore immediately
  }
})
