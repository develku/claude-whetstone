// test/forge-mutate.test.mjs
// The pure textual mutant generator for mutation-backed admit. Deliberately crude — robustness comes from the
// downstream oracle-filter (a non-parsing or equivalent mutant is excluded there), so these tests pin only the
// operator transforms, dedup/identity-exclusion, and the cap; NOT that every mutant parses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mutate } from '../src/forge/mutate.mjs'

const sourcesOf = (src, opts) => mutate(src, opts).map((m) => m.source)
const some = (src, needle, opts) => sourcesOf(src, opts).some((s) => s.includes(needle))

test('return-constant rewrites a return expression to a constant (0)', () => {
  assert.ok(some('export const f = (n) => { return n + 1 }\n', 'return 0'))
})

test('increment-tweak flips ++ to -- (off-by-one on a stateful counter)', () => {
  assert.ok(some('export const inc = () => { return ++n }\n', '--n'))
})

test('comparison-flip turns === into !== and < into >', () => {
  assert.ok(some('export const eq = (a, b) => a === b\n', '!=='))
  assert.ok(some('export const lt = (a, b) => a < b\n', 'a > b'))
})

test('boolean-flip turns true into false', () => {
  assert.ok(some('export const t = () => true\n', 'false'))
})

test('every comparison/boolean/arithmetic DIRECTION emits a distinct mutant (guards equivalent/no-op operators)', () => {
  // The tests above cover ===->!==, <->>, true->false, +->- (and ++->--). Pin the REMAINING directions so a
  // wrong-direction or identity callback — which produces an equivalent mutant the downstream oracle filter
  // silently drops, weakening the required-kill neighbourhood with no test failure — is caught here. Each
  // minimal source isolates one operator so the expected transformed token uniquely proves that callback ran.
  assert.ok(some('export const f = (a, b) => a !== b\n', 'a === b')) // !== -> ===
  assert.ok(some('export const f = (a, b) => a == b\n', 'a != b')) //  ==  -> !=
  assert.ok(some('export const f = (a, b) => a != b\n', 'a == b')) //  !=  -> ==
  assert.ok(some('export const f = (a, b) => a <= b\n', 'a >= b')) //  <=  -> >=
  assert.ok(some('export const f = (a, b) => a >= b\n', 'a <= b')) //  >=  -> <=
  assert.ok(some('export const f = (a, b) => a > b\n', 'a < b')) //    >   -> <
  assert.ok(some('export const f = () => false\n', 'true')) //         false -> true
  assert.ok(some('export const f = (a, b) => a - b\n', 'a + b')) //    -   -> +
  assert.ok(some('export const f = (a, b) => a * b\n', 'a / b')) //    *   -> /
  assert.ok(some('export const f = (a, b) => a / b\n', 'a * b')) //    /   -> *
})

test('arithmetic-swap swaps a space-delimited binary + to - WITHOUT corrupting ++', () => {
  const muts = sourcesOf('export const add = (a, b) => a + b\n')
  assert.ok(muts.some((s) => s.includes('a - b')))
  // a separate source whose ONLY plus is in ++ must never produce a "+-"/"-+" corruption
  const incMuts = sourcesOf('export const inc = () => { return ++n }\n')
  assert.ok(!incMuts.some((s) => s.includes('+-') || s.includes('-+')))
})

test('never emits a mutant identical to the input', () => {
  const src = 'export const f = (n) => { return ++n }\n'
  assert.ok(mutate(src).every((m) => m.source !== src))
})

test('every mutant is unique (deduped)', () => {
  const src = 'export const f = (a, b) => { return a + b === b + a }\n'
  const out = sourcesOf(src)
  assert.equal(new Set(out).size, out.length)
})

test('respects the maxMutants cap', () => {
  const src = 'export const f = (a, b, c) => a + b + c - a - b - c === a < b\n'
  assert.ok(mutate(src, { maxMutants: 3 }).length <= 3)
})

test('a source with no mutable site yields no mutants', () => {
  assert.deepEqual(mutate('export const x = "hello world"\n'), [])
})

test('each result carries its operator name', () => {
  for (const m of mutate('export const f = (n) => { return ++n }\n')) {
    assert.equal(typeof m.operator, 'string')
    assert.ok(m.operator.length > 0)
  }
})
