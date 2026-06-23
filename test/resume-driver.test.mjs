import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig, resumeFromConfig } from '../src/driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scorerCmd = `node ${JSON.stringify(join(here, 'fixtures', 'scripted-scorer.mjs'))}`

// End-to-end --resume against the REAL scorer process and REAL state.json/snapshots, with a
// stub act (no spend). The scripted scorer is deterministic by pass index (50, 75, 100), so a
// hardCap=1 run gets capped at pass 1 (best 75); resuming with a higher cap must continue from
// the loaded state — pass 2 scores 100 and converges to done — WITHOUT re-running a baseline.

const bumpAct = (artifact) => {
  let n = 0
  return async () => {
    writeFileSync(artifact, `v${++n}`) // a real change each pass -> never a no-op
    return { changed: true, costUsd: 0.01 }
  }
}

const cappedRun = () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-resume-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'v0')
  const loopDir = join(dir, '.loop')
  return { dir, artifact, loopDir }
}

test('resumes a capped run from state.json and converges to done without a duplicate baseline', async () => {
  const { artifact, loopDir } = cappedRun()

  const first = await runFromConfig(
    { goal: 'demo', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 1, loopDir, noEscalate: true },
    { act: bumpAct(artifact), log: () => {} },
  )
  assert.equal(first.verdict.status, 'capped')
  assert.equal(first.state.history.length, 2) // baseline(50) + pass1(75)
  assert.equal(first.state.best_score, 75)

  const resumed = await resumeFromConfig(
    { loopDir, overrides: { hard_cap: 3 }, noEscalate: true },
    { act: bumpAct(artifact), log: () => {} },
  )
  assert.equal(resumed.verdict.status, 'done')
  assert.equal(resumed.state.history.length, 3) // 2 carried forward + 1 new — no re-baseline
  assert.deepEqual(
    resumed.state.history.map((h) => h.score),
    [50, 75, 100],
  )
  assert.equal(resumed.state.best_score, 100)
  assert.equal(resumed.state.pass, 2)

  assert.ok(existsSync(join(loopDir, 'snapshots', 'iter_002.txt')), 'resume snapshot iter_002')
  const saved = JSON.parse(readFileSync(join(loopDir, 'state.json'), 'utf8'))
  assert.equal(saved.status, 'done')
})

test('refuses to resume when the cap is not raised above the current run', async () => {
  const { artifact, loopDir } = cappedRun()
  await runFromConfig(
    { goal: 'demo', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 1, loopDir, noEscalate: true },
    { act: bumpAct(artifact), log: () => {} },
  )

  await assert.rejects(
    () => resumeFromConfig({ loopDir, overrides: {}, noEscalate: true }, { act: bumpAct(artifact), log: () => {} }),
    /cannot resume.*cap/is,
  )
})

// Resume must run the SAME config validation a fresh run does — otherwise a non-numeric
// override (--cap abc -> NaN) slips past the gate (pass >= NaN === false) and the loop runs
// with no pass ceiling. The refusal must happen BEFORE any paid act() pass.
test('refuses to resume on a non-numeric override (NaN cap) before spending', async () => {
  const { artifact, loopDir } = cappedRun()
  await runFromConfig(
    { goal: 'demo', artifactPath: artifact, scorerCmd, targetScore: 90, hardCap: 1, loopDir, noEscalate: true },
    { act: bumpAct(artifact), log: () => {} },
  )

  let acted = false
  await assert.rejects(
    () =>
      resumeFromConfig(
        { loopDir, overrides: { hard_cap: NaN }, noEscalate: true },
        { act: async () => { acted = true; return { changed: true, costUsd: 0.01 } }, log: () => {} },
      ),
    /hard_cap/,
  )
  assert.equal(acted, false) // no paid pass before the refusal
})

// Resume reads an EXISTING run. A typo'd --loop-dir must fail with an actionable message
// (not a raw ENOENT) AND must not leave an empty snapshots/+reviews/ tree behind.
test('refuses to resume a non-existent run dir with an actionable error and no orphan dir', async () => {
  const loopDir = join(mkdtempSync(join(tmpdir(), 'whetstone-resume-')), 'no-such-run')

  await assert.rejects(
    () => resumeFromConfig({ loopDir, overrides: { hard_cap: 3 }, noEscalate: true }, { act: async () => ({ changed: true }), log: () => {} }),
    /no run found/i,
  )
  assert.equal(existsSync(loopDir), false) // a failed resume must not create the run dir
})

// A corrupt state.json must fail with a clear "corrupt" message, not a raw JSON parse error.
test('refuses to resume a corrupt state.json with an actionable error', async () => {
  const loopDir = join(mkdtempSync(join(tmpdir(), 'whetstone-resume-')), '.loop')
  mkdirSync(loopDir, { recursive: true })
  writeFileSync(join(loopDir, 'state.json'), '{ this is not valid json')

  await assert.rejects(
    () => resumeFromConfig({ loopDir, overrides: { hard_cap: 3 }, noEscalate: true }, { act: async () => ({ changed: true }), log: () => {} }),
    /corrupt/i,
  )
})
