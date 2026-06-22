import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig } from '../src/driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptedScorer = join(here, 'fixtures', 'scripted-scorer.mjs')
const scorerCmd = `node ${JSON.stringify(scriptedScorer)}`

// Full pipeline with the REAL scorer process and REAL file I/O, but a stub act
// (no Claude spawn, no spend). Proves observe/score/persist/gate + the state.json
// / snapshots / reviews artifacts all wire together correctly.

test('runs the full pipeline, persists artifacts, and converges to done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loopcraft-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'v0')
  let n = 0
  const stubAct = async () => {
    writeFileSync(artifact, `v${++n}`) // a real change each pass -> no no-op
    return { changed: true, costUsd: 0.01 }
  }

  const { state, verdict } = await runFromConfig(
    { goal: 'demo', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 10, loopDir: join(dir, '.loop') },
    { act: stubAct, log: () => {} },
  )

  assert.equal(verdict.status, 'done') // scripted scores 50, 75, 100
  assert.equal(state.history.length, 3)
  assert.equal(state.best_score, 100)
  assert.ok(state.spent_usd > 0)

  assert.ok(existsSync(join(dir, '.loop', 'state.json')))
  for (const p of ['000', '001', '002']) {
    assert.ok(existsSync(join(dir, '.loop', 'snapshots', `iter_${p}.txt`)), `snapshot ${p}`)
    assert.ok(existsSync(join(dir, '.loop', 'reviews', `review_${p}.json`)), `review ${p}`)
  }
  const saved = JSON.parse(readFileSync(join(dir, '.loop', 'state.json'), 'utf8'))
  assert.equal(saved.status, 'done')
})

test('halts with error on a no-op pass (the model changed nothing)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loopcraft-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'v0')
  const noopAct = async () => ({ changed: false, costUsd: 0 })

  const { verdict } = await runFromConfig(
    // noEscalate so a no-op halts (error) instead of escalating to a real claude spawn
    { goal: 'demo', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 10, loopDir: join(dir, '.loop'), noEscalate: true },
    { act: noopAct, log: () => {} },
  )
  assert.equal(verdict.status, 'error')
})
