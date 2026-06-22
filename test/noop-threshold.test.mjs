import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../src/loop.mjs'
import { initState, recordPass } from '../src/state.mjs'

// Escalation on no-op should fire only after the cheap editor produces N CONSECUTIVE
// no-ops (default 2), not on the first hiccup — a single transient no-op must not jump
// to the expensive editor. A changed pass resets the counter.

function harness({ scores, changes }) {
  const sQ = [...scores]
  const cQ = [...changes]
  const calls = { esc: 0 }
  return {
    calls,
    evaluate: async () => ({ score: sQ.shift(), critique: 'c' }),
    act: async () => ({ changed: cQ.shift() }),
    actEscalated: async () => {
      calls.esc++
      return { changed: true }
    },
    persist: (s, ev) => recordPass(s, ev),
  }
}
const cfg = (o = {}) => initState({ goal: 'g', artifactPath: 'a', scorerCmd: 's', hardCap: 20, ...o })

test('a single no-op retries the cheap editor and does NOT escalate', async () => {
  const h = harness({ scores: [50, 95], changes: [false, true] })
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90 }), ...h, log: () => {} })
  assert.equal(verdict.status, 'done')
  assert.ok(!state.escalated)
  assert.equal(h.calls.esc, 0)
})

test('two CONSECUTIVE no-ops escalate to the stronger editor', async () => {
  const h = harness({ scores: [50, 95], changes: [false, false] })
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90 }), ...h, log: () => {} })
  assert.equal(state.escalated, true)
  assert.ok(h.calls.esc > 0)
  assert.equal(verdict.status, 'done')
})

test('non-consecutive no-ops (reset by a changed pass) never escalate', async () => {
  const h = harness({ scores: [50, 60, 95], changes: [false, true, false, true] })
  const { state, verdict } = await runLoop({ state: cfg({ targetScore: 90 }), ...h, log: () => {} })
  assert.equal(verdict.status, 'done')
  assert.ok(!state.escalated)
  assert.equal(h.calls.esc, 0)
})
