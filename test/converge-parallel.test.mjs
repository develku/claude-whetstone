import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickBatch, affordBatch, batchRegressed } from '../src/converge-parallel.mjs'
import { ONE_PASS_TOKENS } from '../src/converge.mjs'

// Track B pure batch helpers: which unmet objectives run in parallel, what the batch costs to reserve, and
// the (identical-to-sequential) regression predicate on the merged candidate.

const obj = (id, o = {}) => ({ id, status: 'unmet', attempts: 0, priority: 0, cap: 4, judgeClass: false, primaryScore: null, confirmScore: null, target: 90, met: false, ...o })
const st = (objectives, over = {}) => ({ objectives, quarantined_batches: [], global_budget_tokens: null, global_budget_usd: null, spent_tokens: 0, spent_usd: 0, reserved_tokens: 0, min_delta: 1, ...over })

// --- pickBatch: top-K least-attempted unmet, same comparator as pickNextObjective, quarantine-aware ---

test('pickBatch returns the K least-attempted unmet objectives', () => {
  const s = st([obj('a', { attempts: 2 }), obj('b', { attempts: 0 }), obj('c', { attempts: 1 })])
  assert.deepEqual(pickBatch(s, 2).map((o) => o.id), ['b', 'c'])
})

test('pickBatch breaks ties by priority desc then stable manifest order', () => {
  const s = st([obj('a', { attempts: 0, priority: 0 }), obj('b', { attempts: 0, priority: 1 })])
  assert.deepEqual(pickBatch(s, 2).map((o) => o.id), ['b', 'a'])
})

test('pickBatch excludes met/skipped objectives', () => {
  const s = st([obj('a', { status: 'met' }), obj('b'), obj('c', { status: 'skipped' })])
  assert.deepEqual(pickBatch(s, 5).map((o) => o.id), ['b'])
})

test('pickBatch is empty when nothing is unmet', () => {
  assert.deepEqual(pickBatch(st([obj('a', { status: 'met' })]), 3), [])
})

test('pickBatch honors maxParallel', () => {
  const s = st([obj('a'), obj('b'), obj('c'), obj('d')])
  assert.equal(pickBatch(s, 2).length, 2)
})

test('pickBatch refuses to co-schedule a quarantined set (skips the member that would complete it)', () => {
  // [a,b] regressed together; the batch must not contain BOTH a and b
  const s = st([obj('a'), obj('b'), obj('c')], { quarantined_batches: [['a', 'b']] })
  assert.deepEqual(pickBatch(s, 3).map((o) => o.id), ['a', 'c']) // a kept, b skipped (would form a+b), c added
})

// --- affordBatch: greedy token-dial reservation of cap × ONE_PASS per child ---

test('affordBatch admits only as many children as the remaining pool funds at cap × ONE_PASS', () => {
  // 2 unmet, cap 4 -> 600K each; pool 1M funds only ONE
  const s = st([obj('a'), obj('b')], { global_budget_tokens: 1_000_000 })
  const r = affordBatch(s, 2)
  assert.equal(r.batch.length, 1)
  assert.equal(r.reservedTokens, 4 * ONE_PASS_TOKENS)
})

test('affordBatch admits the whole batch when the pool funds it', () => {
  const s = st([obj('a'), obj('b'), obj('c')], { global_budget_tokens: 2_000_000 })
  const r = affordBatch(s, 3)
  assert.equal(r.batch.length, 3)
  assert.equal(r.reservedTokens, 3 * 4 * ONE_PASS_TOKENS)
})

test('affordBatch returns an empty batch when the pool cannot fund even one child (capped signal)', () => {
  const s = st([obj('a')], { global_budget_tokens: 100 })
  assert.equal(affordBatch(s, 3).batch.length, 0)
})

test('affordBatch subtracts already-spent and already-reserved from the pool', () => {
  const s = st([obj('a')], { global_budget_tokens: 1_000_000, spent_tokens: 500_000, reserved_tokens: 0 })
  // remaining 500K < one child's 600K -> 0 admitted
  assert.equal(affordBatch(s, 3).batch.length, 0)
})

test('affordBatch with no token dial (usd-only) admits up to maxParallel with no token reservation', () => {
  const s = st([obj('a'), obj('b'), obj('c')], { global_budget_usd: 5 })
  const r = affordBatch(s, 2)
  assert.equal(r.batch.length, 2)
  assert.equal(r.reservedTokens, 0)
})

// --- batchRegressed: the IDENTICAL regressionCheck on the merged candidate (no fork, no spurious tightening) ---

test('batchRegressed is true when the re-measure blocked (floor failed)', () => {
  assert.equal(batchRegressed([obj('a')], { blocked: true, vector: null, floor: { score: 0 } }, 1), true)
})

test('batchRegressed is true when a previously-met objective falls below target on the merged candidate', () => {
  const pre = [obj('a', { met: true, primaryScore: 100, target: 90 })]
  const rm = { blocked: false, vector: [{ id: 'a', primaryScore: 85, confirmScore: null }], floor: { score: 100 } }
  assert.equal(batchRegressed(pre, rm, 1), true)
})

test('batchRegressed is true when any objective drops more than min_delta vs last-good (net regression)', () => {
  const pre = [obj('a', { primaryScore: 70, target: 90 })]
  const rm = { blocked: false, vector: [{ id: 'a', primaryScore: 50 }], floor: { score: 100 } }
  assert.equal(batchRegressed(pre, rm, 1), true)
})

test('batchRegressed is false when the merged candidate improves or holds and the floor passed', () => {
  const pre = [obj('a', { primaryScore: 70 }), obj('b', { met: true, primaryScore: 100, target: 90 })]
  const rm = { blocked: false, vector: [{ id: 'a', primaryScore: 95 }, { id: 'b', primaryScore: 100 }], floor: { score: 100 } }
  assert.equal(batchRegressed(pre, rm, 1), false)
})
