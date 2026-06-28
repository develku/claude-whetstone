// test/swe-evo-report.test.mjs
// The report/stats core: per-arm mean Fix-Rate on the held-out T, the three ablation Δs with PAIRED
// bootstrap CIs (the A/B is paired — same instances across arms, so we resample instances), veto rate,
// and the headline summary. Pure + seeded for determinism ($0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mean, deltas, bootstrapCI, vetoRate, summarize } from '../bench/swe-evo/report.mjs'

// a tiny deterministic RNG (mulberry32) so bootstrap CIs are reproducible in tests
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rows = (arr) => arr.map(([instance_id, arm, T, veto, resolved]) => ({ instance_id, arm, T, veto: veto ?? 0, resolved: resolved ?? false, tokens: 0, usd: 0 }))

test('mean of an empty list is null; otherwise the arithmetic mean', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([10, 20, 30]), 20)
})

test('deltas pairs by instance and computes T[armB] - T[armA] for instances present in BOTH', () => {
  const r = rows([
    ['i1', 'baseline', 40], ['i1', 'confirm-forge', 70],
    ['i2', 'baseline', 50], ['i2', 'confirm-forge', 50],
    ['i3', 'baseline', 10], // i3 has no confirm-forge row -> excluded from the pairing
  ])
  assert.deepEqual(deltas(r, 'baseline', 'confirm-forge').sort((a, b) => a - b), [0, 30])
})

test('bootstrapCI: degenerate (all-equal) deltas give lo==hi==mean regardless of rng', () => {
  const ci = bootstrapCI([10, 10, 10, 10], { iters: 200, alpha: 0.05, rng: rng(1) })
  assert.equal(ci.mean, 10)
  assert.equal(ci.lo, 10)
  assert.equal(ci.hi, 10)
})

test('bootstrapCI brackets the point estimate (lo <= mean <= hi) and is seed-deterministic', () => {
  const xs = [0, 10, 20, 30, 40]
  const a = bootstrapCI(xs, { iters: 500, alpha: 0.05, rng: rng(42) })
  const b = bootstrapCI(xs, { iters: 500, alpha: 0.05, rng: rng(42) })
  assert.equal(a.mean, 20)
  assert.ok(a.lo <= 20 && 20 <= a.hi, `lo<=mean<=hi (${a.lo},${a.hi})`)
  assert.deepEqual(a, b) // same seed -> identical CI
})

test('vetoRate = fraction of an arm\'s instances with veto>0', () => {
  const r = rows([
    ['i1', 'confirm-forge', 70, 1], ['i2', 'confirm-forge', 50, 0], ['i3', 'confirm-forge', 30, 2],
  ])
  assert.equal(vetoRate(r, 'confirm-forge'), 2 / 3)
})

test('summarize: per-arm mean T, the three Δs, veto + resolved rates over a paired fixture', () => {
  const r = rows([
    ['i1', 'baseline', 40, 0, false], ['i1', 'confirm', 40, 1, false], ['i1', 'confirm-forge', 70, 1, true], ['i1', 'capability', 90, 0, true],
    ['i2', 'baseline', 50, 0, false], ['i2', 'confirm', 60, 1, false], ['i2', 'confirm-forge', 60, 0, false], ['i2', 'capability', 80, 0, false],
  ])
  const s = summarize(r, { iters: 200, rng: rng(7) })
  assert.equal(s.n, 2)
  assert.equal(s.meanT.baseline, 45)
  assert.equal(s.meanT['confirm-forge'], 65)
  assert.equal(s.meanT.capability, 85)
  assert.equal(s.fullGateDelta.mean, 20) // (70-40 + 60-50)/2 = (30+10)/2
  assert.equal(s.confirmDelta.mean, 5) // (40-40 + 60-50)/2 = (0+10)/2
  assert.equal(s.forgeDelta.mean, 15) // (70-40 + 60-60)/2 = (30+0)/2
  assert.equal(s.vetoRate['confirm-forge'], 0.5)
  assert.equal(s.resolvedRate['confirm-forge'], 0.5)
})
