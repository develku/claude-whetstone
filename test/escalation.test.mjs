import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../src/loop.mjs'
import { initState, recordPass } from '../src/state.mjs'

// Escalation policy: keep a cheap editor for every pass; only when the loop
// PLATEAUS (the cheap model is provably stuck) switch to the stronger editor —
// and only once. The gate already detects plateau; the loop acts on it.

function harness(scores) {
  const q = [...scores]
  const calls = { base: 0, esc: 0 }
  return {
    calls,
    evaluate: async () => ({ score: q.shift(), critique: 'c' }),
    act: async () => { calls.base++; return { changed: true } },
    actEscalated: async () => { calls.esc++; return { changed: true } },
    persist: (s, ev) => recordPass(s, ev),
  }
}
const cfg = (o = {}) => initState({ goal: 'g', artifactPath: 'a', scorerCmd: 's', plateauWindow: 3, minDelta: 1, hardCap: 20, ...o })

test('without an escalation model, a plateau stops the loop', async () => {
  const h = harness([50, 80, 80, 80, 80])
  const { state, verdict } = await runLoop({ state: cfg(), evaluate: h.evaluate, act: h.act, persist: h.persist, log: () => {} })
  assert.equal(verdict.status, 'plateau')
  assert.ok(!state.escalated)
  assert.equal(h.calls.esc, 0)
})

test('on plateau it escalates to the stronger editor, which breaks through to done', async () => {
  const h = harness([50, 80, 80, 80, 80, 95])
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90 }), ...h, log: () => {} })
  assert.equal(state.escalated, true)
  assert.ok(h.calls.esc > 0, 'the stronger editor was actually used')
  assert.equal(verdict.status, 'done')
})

test('if the escalated model also plateaus, the loop stops at plateau (escalated only once)', async () => {
  const h = harness([50, 80, 80, 80, 80, 80, 80, 80, 80, 80])
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 100 }), ...h, log: () => {} })
  assert.equal(state.escalated, true)
  assert.equal(verdict.status, 'plateau')
  assert.ok(h.calls.esc > 0)
})

test('a no-op from the cheap editor escalates instead of erroring', async () => {
  // the cheap editor gives up (no change) — that is exactly when to escalate.
  const scoreQ = [50, 95]
  let escUsed = 0
  const { state, verdict } = await runLoop({
    state: cfg({ targetScore: 90 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'c' }),
    act: async () => ({ changed: false }),
    actEscalated: async () => { escUsed++; return { changed: true } },
    persist: (s, ev) => recordPass(s, ev),
    log: () => {},
  })
  assert.equal(state.escalated, true)
  assert.ok(escUsed > 0, 'the stronger editor was tried after the no-op')
  assert.equal(verdict.status, 'done')
})

test('a no-op with no escalation model still errors', async () => {
  const { verdict } = await runLoop({
    state: cfg(),
    evaluate: async () => ({ score: 50, critique: 'c' }),
    act: async () => ({ changed: false }),
    persist: (s, ev) => recordPass(s, ev),
    log: () => {},
  })
  assert.equal(verdict.status, 'error')
})
