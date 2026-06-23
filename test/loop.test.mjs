import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../src/loop.mjs'
import { initState, recordPass } from '../src/state.mjs'

// Drive the whole control flow with deterministic stubs — no Claude spawn, no
// scorer process, zero spend. This is the clean-machine smoke test of the gate
// wired into the loop: it proves done / capped / plateau / no-op / budget / error
// all terminate correctly in CODE.

function harness({ scores, changes, costs } = {}) {
  const scoreQ = [...scores]
  const changeQ = changes ? [...changes] : null
  const costQ = costs ? [...costs] : null
  return {
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'do better' }),
    act: async () => ({
      changed: changeQ ? changeQ.shift() : true,
      costUsd: costQ ? costQ.shift() : 0,
    }),
    // pure persist: recordPass only, no file I/O
    persist: (state, ev) => recordPass(state, ev),
  }
}

const cfg = (over = {}) => initState({ goal: 'g', artifactPath: 'a.txt', scorerCmd: 's', ...over })

test('converges to done and stops as soon as the target is met', async () => {
  const h = harness({ scores: [50, 70, 92, 99] })
  const { state, verdict } = await runLoop({ state: cfg(), ...h })
  assert.equal(verdict.status, 'done')
  assert.equal(state.pass, 2) // baseline(0) -> 1 -> 2(meets); the 4th score is never consumed
  assert.equal(state.best_score, 92)
})

test('stops at the hard cap when the target is never reached', async () => {
  const h = harness({ scores: [10, 20, 30, 40, 50] })
  const { state, verdict } = await runLoop({ state: cfg({ hardCap: 3 }), ...h })
  assert.equal(verdict.status, 'capped')
  assert.equal(state.pass, 3)
})

test('stops on plateau before burning the whole cap', async () => {
  const h = harness({ scores: [50, 80, 80, 80, 80, 80, 80] })
  const { verdict } = await runLoop({ state: cfg({ hardCap: 20, plateauWindow: 3, minDelta: 1 }), ...h })
  assert.equal(verdict.status, 'plateau')
})

test('halts on a no-op pass: the model changed nothing', async () => {
  const h = harness({ scores: [50, 60, 70], changes: [false] })
  const { verdict } = await runLoop({ state: cfg(), ...h })
  assert.equal(verdict.status, 'error')
  assert.match(verdict.reason, /no artifact change/)
})

test('halts when the per-run budget is exceeded', async () => {
  const h = harness({ scores: [50, 60, 70, 80], costs: [0.4, 0.4, 0.4] })
  const { state, verdict } = await runLoop({ state: cfg({ budgetUsd: 0.5, hardCap: 20 }), ...h })
  assert.equal(verdict.status, 'capped')
  assert.match(verdict.reason, /budget/)
  assert.ok(state.spent_usd > 0.5)
})

test('halts when the scorer returns an invalid score', async () => {
  const h = harness({ scores: [50, null] })
  const { verdict } = await runLoop({ state: cfg(), ...h })
  assert.equal(verdict.status, 'error')
})

test('the final status is written onto the returned state', async () => {
  const h = harness({ scores: [95] })
  const { state } = await runLoop({ state: cfg(), ...h })
  assert.equal(state.status, 'done')
})

test('skipBaseline resumes from the given state without re-scoring a baseline', async () => {
  // A state that already carries history (as if loaded from a capped run): pass 1, two
  // scored passes. With skipBaseline the loop must NOT re-evaluate a baseline first — the
  // first thing it does is act, then score (pass 2). No duplicate baseline pass is added.
  let s = cfg({ targetScore: 90, hardCap: 10 })
  s = recordPass(s, { score: 50 })
  s = recordPass(s, { score: 60 }) // pass 1, history length 2
  const calls = []
  const evalQ = [95]
  const { state, verdict } = await runLoop({
    state: s,
    evaluate: async () => {
      calls.push('eval')
      return { score: evalQ.shift(), critique: 'c' }
    },
    act: async () => {
      calls.push('act')
      return { changed: true }
    },
    persist: (st, ev) => recordPass(st, ev),
    skipBaseline: true,
    log: () => {},
  })
  assert.equal(verdict.status, 'done')
  assert.equal(calls[0], 'act') // acted first — no baseline re-score
  assert.equal(calls.filter((c) => c === 'eval').length, 1)
  assert.equal(state.history.length, 3) // 2 preserved + 1 new; no duplicate baseline
})
