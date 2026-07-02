import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig, escalationLadder } from '../src/driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const seqScorer = (scores) => `node ${JSON.stringify(join(here, 'fixtures', 'seq-scorer.mjs'))} --scores ${scores}`

// escalationLadder(escalateModel, baseModel): which stronger editors rescue a stall, in climb
// order. A bare 'fable' auto-expands to opus->fable (operator decision 2026-07-02: a fable-enabled
// run still rescues via opus first — fable bills above opus and most stalls yield to opus); a comma
// list is the explicit general form; rungs equal to the base model drop (a same-model rescue is a
// no-op rung).

test('bare fable expands to the opus->fable ladder', () => {
  assert.deepEqual(escalationLadder('fable', 'sonnet'), ['opus', 'fable'])
  assert.deepEqual(escalationLadder('claude-fable-5', 'sonnet'), ['opus', 'claude-fable-5'])
})

test('null/absent escalate model -> no rungs', () => {
  assert.deepEqual(escalationLadder(null, 'sonnet'), [])
  assert.deepEqual(escalationLadder(undefined, 'sonnet'), [])
})

test('a comma list is the explicit climb order, whitespace-tolerant', () => {
  assert.deepEqual(escalationLadder('opus,fable', 'sonnet'), ['opus', 'fable'])
  assert.deepEqual(escalationLadder(' opus , fable ', 'sonnet'), ['opus', 'fable'])
})

test('a single non-fable model stays a one-rung ladder (historical behavior)', () => {
  assert.deepEqual(escalationLadder('opus', 'sonnet'), ['opus'])
  assert.deepEqual(escalationLadder('haiku', 'sonnet'), ['haiku'])
})

test('rungs equal to the base model drop — an opus-based run goes straight to fable', () => {
  assert.deepEqual(escalationLadder('fable', 'opus'), ['fable'])
  assert.deepEqual(escalationLadder('opus,fable', 'opus'), ['fable'])
  assert.deepEqual(escalationLadder('opus', 'opus'), [])
})

test('consecutive duplicate rungs collapse', () => {
  assert.deepEqual(escalationLadder('opus,opus,fable', 'sonnet'), ['opus', 'fable'])
})

test('a fable run climbs opus first, then fable — proven on the editors actually built and used', async () => {
  // Wiring test (same makeAct-spy seam as driver.test.mjs): flat scores force plateau -> rung 1
  // (opus) -> re-plateau -> rung 2 (fable) -> re-plateau stands. Both rescue editors are built at
  // the floored effort, and the opus editor RUNS before the fable editor does.
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'a.txt')
  writeFileSync(artifact, 'v0')
  const built = []
  const used = []
  let n = 0
  const make = (o) => {
    built.push(o)
    return async () => {
      used.push(o.model)
      writeFileSync(artifact, `v${++n}`)
      return { changed: true, costUsd: 0 }
    }
  }
  const { state, verdict } = await runFromConfig(
    {
      goal: 'g',
      artifactPath: artifact,
      scorerCmd: seqScorer('40,50'), // 40 baseline, then flat 50s (seq-scorer repeats its last score)
      targetScore: 90,
      hardCap: 12,
      plateauWindow: 2,
      minDelta: 1,
      model: 'sonnet',
      escalateModel: 'fable',
      loopDir: join(dir, '.loop'),
    },
    { makeAct: make, log: () => {} },
  )
  assert.equal(verdict.status, 'plateau') // the full ladder was exhausted
  assert.deepEqual(built.filter((o) => o.effort === 'high').map((o) => o.model), ['opus', 'fable'])
  assert.ok(used.includes('opus') && used.includes('fable'), `both rungs ran: ${used}`)
  assert.ok(used.indexOf('opus') < used.indexOf('fable'), 'opus rescued before fable')
  assert.equal(state.escalations.length, 2)
  assert.deepEqual(state.escalate_models, ['opus', 'fable'])
})
