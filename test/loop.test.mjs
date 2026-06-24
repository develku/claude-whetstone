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

test('the budget cap is strict (spent == budget continues, does not cap)', async () => {
  // budget check is `spent > budget`, so a run that lands exactly ON the budget keeps going.
  // Pin that boundary so a future flip to >= is a deliberate, tested change.
  const h = harness({ scores: [50, 60, 70, 95], costs: [0.3, 0.3] })
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90, budgetUsd: 0.6, hardCap: 20 }), ...h, log: () => {} })
  assert.equal(verdict.status, 'done') // continued past the exact-budget pass (spent 0.6) to score 95
  assert.equal(state.pass, 3)
  assert.ok(Math.abs(state.spent_usd - 0.6) < 1e-9)
})

test('halts when the scorer returns an invalid score', async () => {
  const h = harness({ scores: [50, null] })
  const { verdict } = await runLoop({ state: cfg(), ...h })
  assert.equal(verdict.status, 'error')
})

test('a paid no-op pass charges spent_usd and can trip the budget', async () => {
  // A no-op editor pass still spent money (it ran, returned cost, changed nothing). That
  // cost must be charged and must be able to trip --budget — not silently vanish.
  const h = harness({ scores: [50], changes: [false], costs: [0.6] })
  const { state, verdict } = await runLoop({ state: cfg({ budgetUsd: 0.5, hardCap: 20 }), ...h, log: () => {} })
  assert.equal(verdict.status, 'capped')
  assert.match(verdict.reason, /budget/)
  assert.ok(state.spent_usd >= 0.6, `no-op cost must be charged (spent_usd=${state.spent_usd})`)
})

test('reaching the target on the pass that tips over budget reports done, not capped', async () => {
  // Precedence error > done > capped: a pass that meets the target AND pushes spend over
  // budget is a win, not a budget cap.
  const h = harness({ scores: [50, 95], costs: [0.6] })
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90, budgetUsd: 0.5, hardCap: 20 }), ...h, log: () => {} })
  assert.equal(verdict.status, 'done')
  assert.equal(state.best_score, 95)
})

test('an editor failure mid-loop ends the run as error, not an uncaught throw', async () => {
  // act() throwing (spawn failure, timeout, maxBuffer overflow) must convert to status=error so
  // the run returns a consistent state (saveable for a later --resume), not reject the whole loop.
  const { state, verdict } = await runLoop({
    state: cfg(),
    evaluate: async () => ({ score: 50, critique: 'c' }),
    act: async () => {
      throw new Error('editor timed out')
    },
    persist: (st, ev) => recordPass(st, ev),
    log: () => {},
  })
  assert.equal(verdict.status, 'error')
  assert.match(verdict.reason, /editor timed out/)
  assert.equal(state.status, 'error')
})

test('a scorer crash mid-loop ends the run as error', async () => {
  let n = 0
  const { verdict } = await runLoop({
    state: cfg(),
    evaluate: async () => {
      if (++n === 1) return { score: 50, critique: 'c' }
      throw new Error('scorer exited 1')
    },
    act: async () => ({ changed: true }),
    persist: (st, ev) => recordPass(st, ev),
    log: () => {},
  })
  assert.equal(verdict.status, 'error')
  assert.match(verdict.reason, /scorer exited 1/)
})

test('the final status is written onto the returned state', async () => {
  const h = harness({ scores: [95] })
  const { state } = await runLoop({ state: cfg(), ...h })
  assert.equal(state.status, 'done')
})

test('a confirmation below target VETOES done: the loop keeps going (cap-bound) and the next edit is steered by the confirmation critique', async () => {
  // done-branch confirmation: when the primary scorer says done, an independent confirm
  // scorer re-scores. A confirm score below target means the editor gamed the primary — the
  // done is rejected, the loop continues, and the confirm critique steers the next edit.
  // Cap must still bind (the gate hides cap behind done while primary stays >= target).
  const h = harness({ scores: [95, 95, 95] }) // primary always meets target 90
  const { state, verdict } = await runLoop({
    state: cfg({ targetScore: 90, hardCap: 2 }),
    ...h,
    confirm: async () => ({ score: 50, critique: 'confirm gap' }),
    log: () => {},
  })
  assert.equal(verdict.status, 'capped') // NOT done — confirmation kept vetoing
  assert.match(verdict.reason, /confirm/i)
  assert.equal(state.last_critique, 'confirm gap') // the gap steers the next edit
})

test('an invalid confirmation score halts with error — never confirms a gamed done or silent-vetoes to the cap', async () => {
  // the confirm leg has no gate behind it, so it must validate the score like the gate does.
  // out-of-range (150) must NOT confirm a (gamed) done; missing/NaN must NOT silently veto to the cap.
  const oor = await runLoop({
    state: cfg({ targetScore: 90, hardCap: 2 }),
    ...harness({ scores: [95, 95, 95] }),
    confirm: async () => ({ score: 150, critique: '' }),
    log: () => {},
  })
  assert.equal(oor.verdict.status, 'error')
  const missing = await runLoop({
    state: cfg({ targetScore: 90, hardCap: 2 }),
    ...harness({ scores: [95, 95, 95] }),
    confirm: async () => ({ critique: 'no score field' }),
    log: () => {},
  })
  assert.equal(missing.verdict.status, 'error')
})

test('a confirm veto records confirm_vetoed_at_pass so a kill mid-rescue is not mistaken for done on resume', async () => {
  const { state } = await runLoop({
    state: cfg({ targetScore: 90, hardCap: 1 }),
    ...harness({ scores: [95, 95] }),
    confirm: async () => ({ score: 50, critique: 'gap' }),
    log: () => {},
  })
  assert.equal(state.confirm_vetoed_at_pass, state.pass) // marker stamped on the vetoed pass
})

test('a confirmation that clears target lets done stand', async () => {
  const h = harness({ scores: [95] })
  const { verdict } = await runLoop({
    state: cfg({ targetScore: 90 }),
    ...h,
    confirm: async () => ({ score: 95, critique: '' }),
    log: () => {},
  })
  assert.equal(verdict.status, 'done')
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
