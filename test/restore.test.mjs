import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../src/loop.mjs'
import { initState, recordPass } from '../src/state.mjs'

// Wiring restoreTarget into the loop: after a pass REGRESSES (its score is below the
// best so far), runLoop must call the injected restore(snapshotPath) with the best
// pass's snapshot before the next edit — so a bad edit doesn't seed the next Act.
// `restore` is a new optional injected dep; absent/no-regression means it is never called.

const cfg = (over = {}) => initState({ goal: 'g', artifactPath: 'a', scorerCmd: 's', hardCap: 20, ...over })
// persist stores a per-pass snapshot path so restoreTarget can find the best one
const persist = (s, ev) => recordPass(s, { ...ev, snapshot: `iter_${s.history.length}.txt` })

test('restores the best snapshot once, after a regressed pass', async () => {
  const scoreQ = [50, 90, 70, 95] // up to 90 (best @pass1), regress to 70, recover to 95
  const restored = []
  const { verdict } = await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'c' }),
    act: async () => ({ changed: true }),
    persist,
    restore: (snap) => restored.push(snap),
    log: () => {},
  })
  assert.equal(verdict.status, 'done')
  assert.deepEqual(restored, ['iter_1.txt'])
})

test('never restores when every pass improves', async () => {
  const scoreQ = [50, 70, 95]
  const restored = []
  await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'c' }),
    act: async () => ({ changed: true }),
    persist,
    restore: (snap) => restored.push(snap),
    log: () => {},
  })
  assert.deepEqual(restored, [])
})
