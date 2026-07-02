import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeWithRetry } from '../scorers/llm-judge.mjs'

// Retry-on-transient hardening (2026-07-02 dogfood run3): a single transient failure of the
// nested `claude -p` (exit 1 after init) killed a whole paid run, because the loop treats any
// scorer failure as fatal. judgeWithRetry wraps spawn+validate so one blip no longer ends the
// run. Injectable sleep/warn keep these tests instant and spawn-free (same fake-res pattern
// as judge.test.mjs).

const okRes = (score) => ({ status: 0, error: null, stdout: JSON.stringify({ type: 'result', result: `{"score": ${score}, "critique": "ok"}` }) })
const failRes = (status) => ({ status, error: null, stdout: '', stderr: 'transient blip' })

function harness(results) {
  const q = [...results]
  const calls = { spawn: 0, sleeps: [], warns: [] }
  return {
    calls,
    spawnFn: () => {
      calls.spawn++
      return q.shift()
    },
    opts: { sleep: (ms) => calls.sleeps.push(ms), warn: (m) => calls.warns.push(m) },
  }
}

test('fail-once-then-succeed returns the review after one retry (sleep 2000 before it)', () => {
  const h = harness([failRes(1), okRes(94)])
  const review = judgeWithRetry(h.spawnFn, h.opts)
  assert.equal(review.score, 94)
  assert.equal(h.calls.spawn, 2)
  assert.deepEqual(h.calls.sleeps, [2000])
})

test('all attempts failing throws the LAST error after 3 spawns', () => {
  const h = harness([failRes(1), failRes(2), failRes(3)])
  assert.throws(() => judgeWithRetry(h.spawnFn, h.opts), /claude exited 3/)
  assert.equal(h.calls.spawn, 3)
  assert.deepEqual(h.calls.sleeps, [2000, 5000])
})

test('first-attempt success never sleeps or warns', () => {
  const h = harness([okRes(88)])
  const review = judgeWithRetry(h.spawnFn, h.opts)
  assert.equal(review.score, 88)
  assert.equal(h.calls.spawn, 1)
  assert.deepEqual(h.calls.sleeps, [])
  assert.deepEqual(h.calls.warns, [])
})

test('each retry warns loudly with the attempt counter and the failure reason', () => {
  const h = harness([failRes(1), okRes(70)])
  judgeWithRetry(h.spawnFn, h.opts)
  assert.equal(h.calls.warns.length, 1)
  assert.match(h.calls.warns[0], /attempt 1\/3/)
  assert.match(h.calls.warns[0], /claude exited 1/)
})

test('attempts: 1 is single-shot — no retry, no sleep', () => {
  const h = harness([failRes(1), okRes(99)])
  assert.throws(() => judgeWithRetry(h.spawnFn, { ...h.opts, attempts: 1 }), /claude exited 1/)
  assert.equal(h.calls.spawn, 1)
  assert.deepEqual(h.calls.sleeps, [])
})

test('default sleep and warn work end-to-end (zero backoff keeps it instant)', () => {
  // No injected sleep/warn: exercises the real sync Atomics.wait sleep and the stderr warn.
  const h = harness([failRes(1), okRes(61)])
  const review = judgeWithRetry(h.spawnFn, { backoffMs: [0] })
  assert.equal(review.score, 61)
  assert.equal(h.calls.spawn, 2)
})
