// test/bench-sweep.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweep } from '../bench/run-bench.mjs'

const fixtures = [{ id: 'f1' }, { id: 'f2' }]

test('runs fixture x 2 arms x trials and aggregates', async () => {
  const calls = []
  const runArm = async (fx, arm) => { calls.push([fx.id, arm]); return { bucket: 'true-done', spentUsd: 0.1 } }
  const { records, aggregate, spent, dropped } = await sweep(fixtures, { trials: 2, runArm, totalBudget: 100 })
  assert.equal(records.length, 2 * 2 * 2) // 2 fixtures x 2 arms x 2 trials
  assert.equal(calls.length, 8)
  assert.ok(Math.abs(spent - 0.8) < 1e-9)
  assert.equal(dropped, 0)
  assert.ok(aggregate.byArm['fence-on'])
  assert.equal(records[0].fixture, 'f1')
})

test('aborts the tail when totalBudget is exceeded and reports dropped count', async () => {
  let n = 0
  const runArm = async () => { n++; return { bucket: 'false-done', spentUsd: 1.0 } }
  const logs = []
  // budget 2.5 -> 2 runs (spent 2.0) then the 3rd sees spent 2.0 < 2.5 so runs (spent 3.0),
  // the 4th sees 3.0 >= 2.5 -> stop. 8 planned, 3 run, 5 dropped.
  const { records, spent, dropped } = await sweep(fixtures, { trials: 2, runArm, totalBudget: 2.5, log: (m) => logs.push(m) })
  assert.equal(records.length, 3)
  assert.ok(Math.abs(spent - 3.0) < 1e-9)
  assert.equal(dropped, 5)
  assert.ok(logs.some((m) => /dropped/i.test(m)))
})
