import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coarseSignalPlateau, readLatestFindings, resolveSubGate, decomposable } from '../src/decompose.mjs'

// A state the gate reads as `plateau` (best-score flat over plateau_window+1 passes), below target.
function plateauState(over = {}) {
  return {
    goal: 'g', target_score: 90, min_delta: 1, plateau_window: 3, hard_cap: 10, pass: 3,
    best_score: 50, budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0,
    history: [50, 50, 50, 50].map((score, i) => ({ pass: i, score, critique_ref: null })),
    ...over,
  }
}

test('coarseSignalPlateau: true at a real plateau below target', () => {
  assert.equal(coarseSignalPlateau(plateauState()), true)
})

test('coarseSignalPlateau: false when still improving (running)', () => {
  const climbing = plateauState({ history: [50, 60, 70, 80].map((score, i) => ({ pass: i, score, critique_ref: null })), best_score: 80 })
  assert.equal(coarseSignalPlateau(climbing), false)
})

test('readLatestFindings: reads findings from the last review file; [] when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-rf-'))
  try {
    mkdirSync(join(dir, 'reviews'), { recursive: true })
    writeFileSync(join(dir, 'reviews', 'review_003.json'), JSON.stringify({ score: 50, critique: 'x', findings: [{ area: 'test A', severity: 'high', suggestion: 'fix A' }] }))
    const state = plateauState({ history: [{ pass: 3, score: 50, critique_ref: 'reviews/review_003.json' }] })
    assert.deepEqual(readLatestFindings(dir, state).map((f) => f.area), ['test A'])
    assert.deepEqual(readLatestFindings(dir, plateauState({ history: [{ pass: 0, score: 50, critique_ref: null }] })), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const allow = new Map([['test-pass-rate', '/abs/scorers/test-pass-rate.mjs']])
const ctx = { repoDir: '/repo', allowlist: allow }

test('resolveSubGate: builds a shq-quoted command from an allowlisted id', () => {
  const sg = resolveSubGate({ area: 'a', scorer: { id: 'test-pass-rate', args: ['--cmd', 'node --test', '--only', "weird ' name"] } }, ctx)
  assert.equal(sg.scorerCmd, "node '/abs/scorers/test-pass-rate.mjs' '--cmd' 'node --test' '--only' 'weird '\\'' name'")
  assert.equal(sg.editScope, null)
})

test('resolveSubGate: rejects an unknown scorer id (injection/allowlist) [CR#4]', () => {
  assert.equal(resolveSubGate({ area: 'a', scorer: { id: 'rm -rf /', args: [] } }, ctx), null)
  assert.equal(resolveSubGate({ area: 'a' }, ctx), null) // no scorer field -> not decomposable
  assert.equal(resolveSubGate({ area: 'a', scorer: { id: 'test-pass-rate', args: 'not-an-array' } }, ctx), null)
})

test('resolveSubGate: rejects a scope that escapes the repo [CR#5]', () => {
  const f = { area: 'a', scope: '../etc', scorer: { id: 'test-pass-rate', args: [] } }
  assert.equal(resolveSubGate(f, ctx), null)
  const ok = resolveSubGate({ area: 'a', scope: 'src/auth', scorer: { id: 'test-pass-rate', args: [] } }, ctx)
  assert.equal(ok.editScope, 'src/auth')
})

test('decomposable: keeps resolvable, unseen findings only', () => {
  const findings = [
    { area: 'A', scorer: { id: 'test-pass-rate', args: [] } },
    { area: 'B' },                                            // no scorer -> dropped
    { area: 'C', scorer: { id: 'unknown', args: [] } },       // bad id -> dropped
  ]
  const seen = new Set(['A'])                                  // already decomposed -> dropped
  assert.deepEqual(decomposable(findings, seen, ctx).map((f) => f.area), [])
  assert.deepEqual(decomposable(findings, new Set(), ctx).map((f) => f.area), ['A'])
})
