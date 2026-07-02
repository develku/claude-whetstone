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

// --- escalation LADDER (v1.6.0): actEscalated may be an ORDERED ARRAY of rescue editors. ---
// Each proven stall climbs ONE rung (with a fresh grace window); a stall after the last rung
// stands. A single fn is a one-rung ladder, so every test above keeps its historical behavior.

function ladderHarness(scores) {
  const q = [...scores]
  const calls = { base: 0, rung1: 0, rung2: 0 }
  return {
    calls,
    evaluate: async () => ({ score: q.shift(), critique: 'c' }),
    act: async () => { calls.base++; return { changed: true } },
    rungs: [
      async () => { calls.rung1++; return { changed: true } },
      async () => { calls.rung2++; return { changed: true } },
    ],
    persist: (s, ev) => recordPass(s, ev),
  }
}

test('a two-rung ladder climbs one rung per plateau and exhausts to a standing plateau', async () => {
  const h = ladderHarness([50, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80])
  const { state, verdict } = await runLoop({
    state: cfg({ targetScore: 100 }),
    evaluate: h.evaluate,
    act: h.act,
    actEscalated: h.rungs,
    persist: h.persist,
    log: () => {},
  })
  assert.equal(verdict.status, 'plateau')
  assert.equal(state.escalated, true)
  assert.ok(h.calls.rung1 > 0, 'rung 1 (e.g. opus) was used')
  assert.ok(h.calls.rung2 > 0, 'rung 2 (e.g. fable) was used after rung 1 also plateaued')
  assert.deepEqual(state.escalations.map((e) => e.rung), [1, 2])
  assert.ok(state.escalations[1].pass > state.escalations[0].pass, 'the rungs climbed at distinct passes')
})

test('rung 1 breaking through finishes the run without ever paying rung 2', async () => {
  const h = ladderHarness([50, 80, 80, 80, 80, 95])
  const { state, verdict } = await runLoop({
    state: cfg({ targetScore: 90 }),
    evaluate: h.evaluate,
    act: h.act,
    actEscalated: h.rungs,
    persist: h.persist,
    log: () => {},
  })
  assert.equal(verdict.status, 'done')
  assert.ok(h.calls.rung1 > 0)
  assert.equal(h.calls.rung2, 0, 'the pricier final rung was never used')
  assert.equal(state.escalations.length, 1)
})

test('the no-op path climbs the ladder rung by rung, then errors after the last rung', async () => {
  const calls = { base: 0, rung1: 0, rung2: 0 }
  const { state, verdict } = await runLoop({
    state: cfg(),
    evaluate: async () => ({ score: 50, critique: 'c' }),
    act: async () => { calls.base++; return { changed: false } },
    actEscalated: [
      async () => { calls.rung1++; return { changed: false } },
      async () => { calls.rung2++; return { changed: false } },
    ],
    persist: (s, ev) => recordPass(s, ev),
    log: () => {},
  })
  assert.equal(verdict.status, 'error')
  assert.equal(state.escalations.length, 2)
  assert.equal(calls.base, 2) // noopThreshold no-ops from the base editor -> climb
  assert.equal(calls.rung1, 2) // rung 1 also no-ops out -> climb again
  assert.equal(calls.rung2, 2) // last rung no-ops out -> error (no rung left)
})
