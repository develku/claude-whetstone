import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig, parseCli, shq, editorEffort, loadConfig } from '../src/driver.mjs'

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

test('a RELATIVE observe output is resolved against loopDir before the scorer reads it', async () => {
  // observe runs in cwd=loopDir; the scorer runs in the driver cwd. If observe emits a RELATIVE path,
  // the scorer's readFileSync(output) resolves it against the WRONG dir -> ENOENT -> error. The fix
  // resolves the observe output against loopDir, so the scorer reads the file observe actually wrote.
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'art.txt')
  writeFileSync(artifact, 'the artifact lacks the needle')
  const loopDir = join(dir, '.loop')
  const observeCmd = `printf DONE > observed.txt; echo observed.txt` // writes into loopDir, echoes a RELATIVE path
  const { verdict } = await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd: containsScorer, observeCmd, targetScore: 100, hardCap: 3, loopDir, noEscalate: true },
    { act: async () => ({ changed: true, costUsd: 0 }), log: () => {} },
  )
  assert.equal(verdict.status, 'done') // resolved correctly -> scorer read loopDir/observed.txt (has DONE)
})

// Config-file defaults: a persistent settings file supplies the cost/model knobs the operator
// would otherwise retype every run (esp. --budget-tokens, which is awkward to size by hand because
// each pass burns ~100-150K tokens). Precedence: CLI flag > config file > built-in default.
test('parseCli uses config-file defaults, and a CLI flag still overrides them', () => {
  const base = ['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's']
  const withCfg = parseCli(base, { model: 'haiku', budgetTokens: 2000000, hardCap: 20 })
  assert.equal(withCfg.model, 'haiku')
  assert.equal(withCfg.budgetTokens, 2000000)
  assert.equal(withCfg.hardCap, 20)
  const override = parseCli([...base, '--model', 'opus', '--budget-tokens', '500'], { model: 'haiku', budgetTokens: 2000000 })
  assert.equal(override.model, 'opus') // CLI wins
  assert.equal(override.budgetTokens, 500)
  assert.equal(parseCli(base).model, 'sonnet') // no config, no CLI -> builtin
  assert.equal(parseCli(base).budgetTokens, undefined)
})

test('loadConfig merges home + cwd configs (cwd wins), ENOENT -> {}', () => {
  const home = mkdtempSync(join(tmpdir(), 'whet-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'whet-cwd-'))
  assert.deepEqual(loadConfig(cwd, home), {}) // neither exists
  mkdirSync(join(home, '.config', 'whetstone'), { recursive: true })
  writeFileSync(join(home, '.config', 'whetstone', 'config.json'), JSON.stringify({ model: 'haiku', budgetTokens: 1000 }))
  assert.deepEqual(loadConfig(cwd, home), { model: 'haiku', budgetTokens: 1000 })
  writeFileSync(join(cwd, 'whetstone.config.json'), JSON.stringify({ model: 'opus', hardCap: 5 }))
  assert.deepEqual(loadConfig(cwd, home), { model: 'opus', budgetTokens: 1000, hardCap: 5 }) // cwd overrides model, keeps home's budgetTokens
})

test('loadConfig throws a clear error on a malformed config (never silently ignored)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'whet-cwd-'))
  writeFileSync(join(cwd, 'whetstone.config.json'), '{ not valid json')
  assert.throws(() => loadConfig(cwd, join(cwd, 'no-home')), /whetstone config/i)
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

test('the forward editor is built at the operator effort and the rescue editor at the floored effort (wiring, not just the helper)', async () => {
  // closes the gap where editorEffort is unit-tested but its wiring to the two editors is not:
  // a makeAct spy observes the effort each editor is actually constructed with.
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'a.txt')
  writeFileSync(artifact, 'v0')
  const opts = []
  let n = 0
  const make = (o) => {
    opts.push(o)
    return async () => {
      writeFileSync(artifact, `v${++n}`)
      return { changed: true, costUsd: 0 }
    }
  }
  await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 5, effort: 'medium', loopDir: join(dir, '.loop') },
    { makeAct: make, log: () => {} },
  )
  const efforts = opts.map((o) => o.effort)
  assert.ok(efforts.includes('medium'), `forward editor (operator effort) missing: ${efforts}`)
  assert.ok(efforts.includes('high'), `rescue editor (floored effort) missing: ${efforts}`)
})

test('editorEffort: forward uses the operator effort; rescue is a FLOOR that never downgrades it', () => {
  // the rescue editor must raise (or hold) effort, never lower it — escalation goes UP on both dials.
  assert.equal(editorEffort({ effort: 'medium' }, false), 'medium') // forward pass: as configured
  assert.equal(editorEffort({ effort: 'medium' }, true), 'high') // rescue: bumped to the floor
  assert.equal(editorEffort({ effort: 'low' }, true), 'high') // raised to the floor
  assert.equal(editorEffort({ effort: 'max' }, true), 'max') // already above the floor -> NOT downgraded to 'high'
  assert.equal(editorEffort({ effort: 'xhigh' }, true), 'xhigh') // ditto
})

test('parseCli defaults --effort to medium (cheap on both dials) and reads an explicit level', () => {
  assert.equal(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's']).effort, 'medium')
  assert.equal(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's', '--effort', 'low']).effort, 'low')
})

test('parseCli reads --budget-tokens as a number (the subscription-plan cost dial) and is undefined when absent', () => {
  assert.equal(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's', '--budget-tokens', '500000']).budgetTokens, 500000)
  assert.equal(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's']).budgetTokens, undefined)
})

test('parseCli reads --confirm-scorer (null when absent)', () => {
  assert.equal(parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's']).confirmScorerCmd, null)
  assert.equal(
    parseCli(['node', 'driver.mjs', 'g', '--artifact', 'x', '--scorer', 's', '--confirm-scorer', 'node c.mjs']).confirmScorerCmd,
    'node c.mjs',
  )
})

test('a confirm scorer vetoes a gamed done: the loop continues instead of finishing', async () => {
  // primary (contains DONE) hits target 100, but the independent confirm scorer (contains a needle
  // the artifact lacks) returns 0 every pass -> the done is vetoed and the run caps, never "done".
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-'))
  const artifact = join(dir, 'art.txt')
  writeFileSync(artifact, 'DONE v0')
  let n = 0
  const confirmScorer = `node ${JSON.stringify(join(here, '..', 'scorers', 'contains.mjs'))} --needle NEVERPRESENT`
  const { verdict, state } = await runFromConfig(
    {
      goal: 'g',
      artifactPath: artifact,
      scorerCmd: containsScorer,
      confirmScorerCmd: confirmScorer,
      targetScore: 100,
      hardCap: 2,
      loopDir: join(dir, '.loop'),
      noEscalate: true,
    },
    { act: async () => { writeFileSync(artifact, `DONE v${++n}`); return { changed: true, costUsd: 0 } }, log: () => {} },
  )
  assert.equal(verdict.status, 'capped') // primary reached 100 but confirmation vetoed every time
  assert.match(verdict.reason, /confirm/i)
  assert.match(state.last_critique, /NEVERPRESENT/) // the confirm critique steered the (futile) edits
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
