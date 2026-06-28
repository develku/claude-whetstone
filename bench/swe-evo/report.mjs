#!/usr/bin/env node
// bench/swe-evo/report.mjs
// Turns the A/B JSONL ({arm,instance_id,T,veto,resolved,tokens,usd} per cell) into the H1 headline: per-arm
// mean Fix-Rate on the held-out T, the three ablation Δs with PAIRED bootstrap CIs, and the veto rate.
// The A/B is PAIRED (same instances across arms), so the statistic is the per-instance Δ and we resample
// INSTANCES (not rows) — a paired bootstrap, which is the right power story for n as small as 18.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { formatSpend } from '../../src/spend-format.mjs'

export function mean(xs) {
  if (!xs.length) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function byInstance(rows) {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.instance_id)) m.set(r.instance_id, {})
    m.get(r.instance_id)[r.arm] = r
  }
  return m
}

// Per-instance T[armB] - T[armA], over instances present in BOTH arms (the paired difference).
export function deltas(rows, armA, armB) {
  const out = []
  for (const arms of byInstance(rows).values()) {
    if (arms[armA] && arms[armB]) out.push(arms[armB].T - arms[armA].T)
  }
  return out
}

// Percentile bootstrap CI of the mean, resampling the paired differences with replacement. rng is
// injectable for deterministic tests. All-equal input -> lo==hi==mean (every resample is identical).
export function bootstrapCI(xs, { iters = 10000, alpha = 0.05, rng = Math.random } = {}) {
  if (!xs.length) return { mean: null, lo: null, hi: null, n: 0 }
  const m = mean(xs)
  const means = []
  for (let i = 0; i < iters; i++) {
    let s = 0
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rng() * xs.length)]
    means.push(s / xs.length)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor((alpha / 2) * iters)]
  const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)]
  return { mean: m, lo, hi, n: xs.length }
}

export function vetoRate(rows, armId) {
  const arm = rows.filter((r) => r.arm === armId)
  if (!arm.length) return null
  return arm.filter((r) => (r.veto ?? 0) > 0).length / arm.length
}

const rateBy = (rows, armId, pred) => {
  const arm = rows.filter((r) => r.arm === armId)
  return arm.length ? arm.filter(pred).length / arm.length : null
}

const ARMS = ['baseline', 'confirm', 'confirm-forge', 'capability']

export function summarize(rows, { iters = 10000, alpha = 0.05, rng = Math.random } = {}) {
  const meanT = {}, resolvedRate = {}, tokens = {}, usd = {}
  for (const a of ARMS) {
    const rs = rows.filter((r) => r.arm === a)
    meanT[a] = mean(rs.map((r) => r.T))
    resolvedRate[a] = rateBy(rows, a, (r) => r.resolved)
    tokens[a] = mean(rs.map((r) => r.tokens ?? 0))
    usd[a] = mean(rs.map((r) => r.usd ?? 0))
  }
  const ci = (A, B) => bootstrapCI(deltas(rows, A, B), { iters, alpha, rng })
  return {
    n: byInstance(rows).size,
    meanT,
    resolvedRate,
    vetoRate: { confirm: vetoRate(rows, 'confirm'), 'confirm-forge': vetoRate(rows, 'confirm-forge') },
    confirmDelta: ci('baseline', 'confirm'), // (2)-(1): the confirm scorer's contribution
    forgeDelta: ci('confirm', 'confirm-forge'), // (3)-(2): the forge's marginal contribution
    fullGateDelta: ci('baseline', 'confirm-forge'), // (3)-(1): the headline ΔFix-Rate
    tokens,
    usd,
  }
}

const pct = (x) => (x == null ? 'n/a' : `${(Math.round(x * 100) / 100).toFixed(2)}%`)
const ciStr = (d) => (d.mean == null ? 'n/a' : `${pct(d.mean)}  (95% CI ${pct(d.lo)} … ${pct(d.hi)}, n=${d.n})`)

export function formatReport(s) {
  const L = []
  L.push(`SWE-EVO H1 — gated-vs-baseline (n=${s.n} eligible instances)`)
  L.push('')
  L.push('mean Fix-Rate on held-out T:')
  for (const a of ARMS) L.push(`  ${a.padEnd(14)} ${pct(s.meanT[a])}   resolved ${pct((s.resolvedRate[a] ?? 0) * 100)}   spend ${formatSpend({ tokens: s.tokens[a] ?? 0, costUsd: s.usd[a] ?? 0 })}`)
  L.push('')
  L.push('Δ Fix-Rate on T (paired bootstrap):')
  L.push(`  confirm − baseline      ${ciStr(s.confirmDelta)}`)
  L.push(`  forge   − confirm       ${ciStr(s.forgeDelta)}`)
  L.push(`  full gate − baseline    ${ciStr(s.fullGateDelta)}   <- headline`)
  L.push('')
  L.push(`confirm-veto rate:  confirm ${pct((s.vetoRate.confirm ?? 0) * 100)}   confirm-forge ${pct((s.vetoRate['confirm-forge'] ?? 0) * 100)}`)
  const d = s.fullGateDelta
  const verdict = d.mean == null ? 'no paired data' : d.lo > 0 ? 'the gate RAISES held-out truth (CI excludes 0)' : d.hi < 0 ? 'the gate LOWERS held-out truth (CI excludes 0)' : 'inconclusive at this n (CI spans 0)'
  L.push('')
  L.push(`reading: ${verdict}.`)
  return L.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) { process.stderr.write('usage: report.mjs <results.jsonl>\n'); process.exit(2) }
  const rows = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
  process.stdout.write(formatReport(summarize(rows)) + '\n')
}
