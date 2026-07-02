import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContext, runFromConfig } from '../src/driver.mjs'
import { initState, ensureLoopDir } from '../src/state.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The spend dials previously counted ONLY editor (act) spend: an llm-judge scorer pays a second
// model call every pass that was invisible to --budget/--budget-tokens (measured on a real run,
// 2026-07-02: ~20% of tokens / ~30% of USD omitted). The scorer contract now carries an OPTIONAL
// usage: { tokens, costUsd }; the driver's persist charges BOTH sources on every scored pass.

function tmpArtifact() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-acct-'))
  const artifact = join(dir, 'a.txt')
  writeFileSync(artifact, 'v0')
  return { dir, artifact }
}

test('persist charges the editor spend AND the scorer-reported usage on the same pass', () => {
  const { dir, artifact } = tmpArtifact()
  const loopDir = join(dir, '.loop')
  ensureLoopDir(loopDir)
  const { persist } = buildContext(loopDir)
  const state = initState({ goal: 'g', artifactPath: artifact, scorerCmd: 's' })
  const next = persist(state, {
    score: 50,
    critique: 'c',
    costUsd: 1.0, // editor (act) spend
    tokens: 200000,
    review: { score: 50, critique: 'c', usage: { tokens: 52696, costUsd: 0.32 } }, // the judge's own spend
  })
  assert.equal(next.spent_tokens, 252696)
  assert.ok(Math.abs(next.spent_usd - 1.32) < 1e-9)
})

test('a usage-less review (deterministic scorer) charges only the editor spend — never NaN', () => {
  const { dir, artifact } = tmpArtifact()
  const loopDir = join(dir, '.loop')
  ensureLoopDir(loopDir)
  const { persist } = buildContext(loopDir)
  const state = initState({ goal: 'g', artifactPath: artifact, scorerCmd: 's' })
  const next = persist(state, { score: 50, critique: 'c', costUsd: 0.5, tokens: 200000, review: { score: 50, critique: 'c' } })
  assert.equal(next.spent_tokens, 200000)
  assert.equal(next.spent_usd, 0.5)
})

test('scorer-reported usage alone trips --budget-tokens (e2e with a real scorer process)', async () => {
  // usage-scorer reports 600K tokens per call with a $0-editor act: the token budget (1M) must trip
  // on judge spend alone — before v1.6.0 this ran to the cap with spent_tokens frozen at 0.
  const { dir, artifact } = tmpArtifact()
  const scorer = `node ${JSON.stringify(join(here, 'fixtures', 'usage-scorer.mjs'))}`
  let n = 0
  const { state, verdict } = await runFromConfig(
    { goal: 'g', artifactPath: artifact, scorerCmd: scorer, targetScore: 90, hardCap: 10, budgetTokens: 1000000, loopDir: join(dir, '.loop'), noEscalate: true },
    { act: async () => { writeFileSync(artifact, `v${++n}`); return { changed: true, costUsd: 0, tokens: 0 } }, log: () => {} },
  )
  assert.equal(verdict.status, 'capped')
  assert.match(verdict.reason, /token budget/)
  assert.ok(state.spent_tokens > 1000000, `judge spend was charged: ${state.spent_tokens}`)
})
