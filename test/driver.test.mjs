import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig, parseCli, shq } from '../src/driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptedScorer = join(here, 'fixtures', 'scripted-scorer.mjs')
const scorerCmd = `node ${JSON.stringify(scriptedScorer)}`
const containsScorer = `node ${JSON.stringify(join(here, '..', 'scorers', 'contains.mjs'))} --needle DONE`

// Full pipeline with the REAL scorer process and REAL file I/O, but a stub act
// (no Claude spawn, no spend). Proves score/persist/gate + the state.json / snapshots
// / reviews artifacts all wire together correctly. (observe + restore have their own tests.)

test('runs the full pipeline, persists artifacts, and converges to done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
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

test('shq single-quotes a value and escapes embedded single quotes', () => {
  assert.equal(shq('a b'), "'a b'")
  assert.equal(shq("it's"), "'it'\\''s'")
  assert.equal(shq('x; rm -rf /'), "'x; rm -rf /'") // metacharacters neutralized inside the quotes
})

test('runScorer passes paths with spaces and quotes through shq end-to-end', async () => {
  // The run dir name has a space AND a single quote — exactly what shq must survive. The contains
  // scorer reads --output, so if shq broke the path it would die (exit 2) instead of scoring.
  const weird = join(mkdtempSync(join(tmpdir(), 'whetstone-')), "it's a dir")
  mkdirSync(weird, { recursive: true })
  const artifact = join(weird, 'art.txt')
  writeFileSync(artifact, 'this file already contains DONE')
  const { verdict } = await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd: containsScorer, targetScore: 100, hardCap: 3, loopDir: join(weird, '.loop'), noEscalate: true },
    { act: async () => ({ changed: true, costUsd: 0 }), log: () => {} },
  )
  assert.equal(verdict.status, 'done') // baseline already contains DONE -> 100; proves --output survived the space/quote
})

test('keep-best restores the best snapshot over the live artifact after a regression', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'art.txt')
  writeFileSync(artifact, 'v0')
  let n = 0
  const seqScorer = `node ${JSON.stringify(join(here, 'fixtures', 'seq-scorer.mjs'))} --scores 50,80,60`
  const { state, verdict } = await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd: seqScorer, targetScore: 90, hardCap: 2, loopDir: join(dir, '.loop'), noEscalate: true },
    { act: async () => { writeFileSync(artifact, `v${++n}`); return { changed: true, costUsd: 0 } }, log: () => {} },
  )
  assert.equal(verdict.status, 'capped') // 50,80,60 never hits 90; caps at pass 2
  assert.equal(state.best_pass, 1) // best was pass 1 (80)
  // the regressed pass 2 (60) triggered keep-best: the REAL copyFileSync restored iter_001 (v1)
  assert.equal(readFileSync(artifact, 'utf8'), 'v1')
  assert.equal(readFileSync(join(dir, '.loop', 'snapshots', 'iter_001.txt'), 'utf8'), 'v1')
})

test('observe_cmd output is scored instead of the artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'art.txt')
  writeFileSync(artifact, 'the artifact has NO needle') // artifact lacks it
  const observed = join(dir, 'observed.txt')
  writeFileSync(observed, 'the observed output has DONE') // the observed output has it
  const pathFile = join(dir, 'observed-path.txt')
  writeFileSync(pathFile, observed) // observe just echoes the absolute observed path
  const observeCmd = `cat ${JSON.stringify(pathFile)}`
  const { verdict } = await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd: containsScorer, observeCmd, targetScore: 100, hardCap: 3, loopDir: join(dir, '.loop'), noEscalate: true },
    { act: async () => ({ changed: true, costUsd: 0 }), log: () => {} },
  )
  assert.equal(verdict.status, 'done') // scored the observed output (has DONE), not the artifact (lacks it)
})

test('parseCli takes the goal from a true positional only, not a later flag value', () => {
  // flag-only (no positional goal): the value of --artifact must NOT be mistaken for the goal,
  // so the usage guard can fire instead of running with a garbage goal in every edit prompt.
  const cfg = parseCli(['node', 'driver.mjs', '--artifact', 'x.txt', '--scorer', 's', '--target', '90'])
  assert.equal(cfg.goal, undefined)
  assert.equal(cfg.artifactPath, 'x.txt')
})

test('parseCli reads a positional goal and an explicit --goal', () => {
  assert.equal(parseCli(['node', 'driver.mjs', 'raise the score', '--artifact', 'x']).goal, 'raise the score')
  assert.equal(parseCli(['node', 'driver.mjs', '--goal', 'explicit', '--artifact', 'x']).goal, 'explicit')
})

test('halts with error on a no-op pass (the model changed nothing)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
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
