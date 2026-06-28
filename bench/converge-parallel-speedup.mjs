#!/usr/bin/env node
// bench/converge-parallel-speedup.mjs
// Track B speedup proof (spec §11 test 20). The $0 converge-parallel tests prove the concurrent round's
// CORRECTNESS with stub children. This asks the throughput question: when two DISJOINT-editScope objectives
// are both independently raisable, does --parallel raise BOTH in ONE merged batch round (one gate re-measure),
// where the sequential backend takes TWO rounds (two gates)? The gate path is IDENTICAL across both backends
// (runConvergeParallel reuses the verbatim reMeasureAll/globalVerdict) — so the speedup is free of any gate
// weakening: the merged candidate is gated exactly as a sequential candidate would be.
//
// Honest reporting:
//   - $0 STUB: runs BOTH backends on the same scenario and asserts parallel=1 batch round (both objectives),
//     sequential=2 single-objective rounds, both converge to done. The structural speedup, proven at $0.
//   - PAID: runs ONLY the parallel backend with REAL editors. NON-NULL iff two real-model editors, running
//     concurrently in their own worktrees, both genuinely raised their disjoint objective and their edits
//     MERGED into ONE candidate that passed the gate ONCE (survivors = both, one accepted batch round, done).
//     NULL iff a real editor flaked/no-op'd so the round did not merge both (reported honestly, not asserted).
// CORRECTNESS is asserted ALWAYS: every accepted batch round's merged commit must have last-good as its parent
// and both objectives must end met on the converged tree — a false-done is never allowed.
//
//   node bench/converge-parallel-speedup.mjs --stub             # $0 harness check (stub editors raise both)
//   node bench/converge-parallel-speedup.mjs --model sonnet     # PAID real editors (report token-primary spend)
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runConverge } from '../src/converge.mjs'
import { runConvergeParallel } from '../src/converge-parallel.mjs'
import { formatSpend } from '../src/spend-format.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const STUB = process.argv.includes('--stub')
const model = arg('--model', 'sonnet')
const capTokens = Number(arg('--budget-tokens', '3000000'))
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
const tmp = (p) => mkdtempSync(join(tmpdir(), p))

// A scorer: `val f` -> one file's numeric content. Critique names the file so a real editor knows what to raise.
function writeScorer() {
  const dir = tmp('conv-spd-sc-')
  const p = join(dir, 'score.mjs')
  writeFileSync(p, `import { readFileSync } from 'node:fs'
const f = process.argv[3]
let n = 0
try { n = Number(readFileSync(f, 'utf8').trim()) } catch {}
process.stdout.write(JSON.stringify({ score: n, critique: 'score is ' + n + ' — raise ' + f + ' toward 100' }))
`)
  return p
}

function setupRepo() {
  const dir = tmp('conv-spd-')
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src', 'a'), { recursive: true })
  mkdirSync(join(dir, 'src', 'b'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a', 'feature.txt'), '0')
  writeFileSync(join(dir, 'src', 'b', 'feature.txt'), '0')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

// Each stub editor legitimately raises ONLY its own objective's file (disjoint, no gaming) — the happy path.
function stubChild() {
  return async (childCfg) => {
    const wt = childCfg.scope
    const f = childCfg.editScope === 'src/a' ? 'src/a/feature.txt' : 'src/b/feature.txt'
    writeFileSync(join(wt, f), '100')
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '--allow-empty', '-m', `stub ${childCfg.editScope}`)
    return { state: { spent_usd: 0, spent_tokens: 1000 } }
  }
}

async function realChild() {
  const { runFromConfig } = await import('../src/driver.mjs')
  const { scopeDeps } = await import('../src/scope-cli.mjs')
  return (childCfg) => runFromConfig(childCfg, scopeDeps(childCfg))
}

function manifestFor(SCORE) {
  return {
    goal: 'raise two independent objectives, each owning a disjoint file',
    floor: { cmd: 'true' },
    global_budget_tokens: capTokens,
    objective_cap: 4,
    objectives: [
      { id: 'a', goal: 'raise src/a/feature.txt to 100', scorer: `node ${SCORE} val src/a/feature.txt`, target: 90, editScope: 'src/a' },
      { id: 'b', goal: 'raise src/b/feature.txt to 100', scorer: `node ${SCORE} val src/b/feature.txt`, target: 90, editScope: 'src/b' },
    ],
  }
}

function cfgFor(scope, SCORE, convergeDir, over = {}) {
  return {
    scope, objectivesPath: join(dirname(SCORE), 'objectives.json'), convergeDir,
    globalBudgetTokens: capTokens, globalCap: 10, globalStabilityRuns: 2, minDelta: 1, objectiveRetries: 2,
    model, effort: 'medium', noEscalate: true, ...over,
  }
}

// nested `claude -p` flakes ~1/5 — retry a child up to 3x on a spawn error, resetting the worktree each retry.
// HARNESS robustness for the paid run only; the orchestrator stays change-free.
function retryingChild(inner) {
  return async (childCfg) => {
    const wt = childCfg.scope
    const before = git(wt, 'rev-parse', 'HEAD')
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await inner(childCfg) } catch (e) {
        lastErr = e
        console.error(`  [child ${childCfg.editScope}] attempt ${attempt} failed: ${e.message.slice(0, 120)} — ${attempt < 3 ? 'retrying' : 'giving up'}`)
        git(wt, 'reset', '--hard', before); git(wt, 'clean', '-fdq')
      }
    }
    throw lastErr
  }
}

async function runParallel() {
  const scope = setupRepo()
  const SCORE = writeScorer()
  const inner = STUB ? stubChild() : retryingChild(await realChild())
  const { state, verdict } = await runConvergeParallel(cfgFor(scope, SCORE, tmp('conv-spd-pd-'), { maxParallel: 2 }), manifestFor(SCORE), { runChild: inner, log: () => {} })
  const batchAccepts = state.rounds.filter((r) => r.kind === 'batch' && r.accepted)
  const mergedBoth = batchAccepts.find((r) => r.survivors.length === 2)
  // CORRECTNESS: each accepted batch's merged commit must have last-good as its parent (one squash, no chain).
  let parentOk = true
  for (const r of batchAccepts) {
    if (r.merged_sha && git(scope, 'rev-parse', `${r.merged_sha}^`) !== r.pre_sha) parentOk = false
  }
  const a = Number(readFileSync(join(scope, 'src/a/feature.txt'), 'utf8').trim())
  const b = Number(readFileSync(join(scope, 'src/b/feature.txt'), 'utf8').trim())
  return { state, verdict, batchRounds: batchAccepts.length, mergedBoth: !!mergedBoth, parentOk, a, b }
}

async function runSequential() {
  const scope = setupRepo()
  const SCORE = writeScorer()
  const { state, verdict } = await runConverge(cfgFor(scope, SCORE, tmp('conv-spd-sd-')), manifestFor(SCORE), { runChild: stubChild(), log: () => {} })
  const accepts = state.rounds.filter((r) => r.accepted)
  return { verdict, rounds: accepts.length }
}

console.log(`\n=== Track B parallel speedup (${STUB ? 'STUB $0 harness check' : `model=${model}`}) ===\n`)
const par = await runParallel()
console.log('=== parallel backend ===')
console.log(`verdict: ${par.verdict.status} — ${par.verdict.reason}`)
console.log(`final tree: src/a/feature.txt=${par.a}, src/b/feature.txt=${par.b}`)
console.log(`accepted BATCH rounds: ${par.batchRounds}; a single round merged BOTH objectives: ${par.mergedBoth ? 'yes' : 'no'}`)
console.log(`merged-commit parent === last-good (one squash, no chain): ${par.parentOk ? 'yes' : 'NO'}`)
const tokens = par.state.spent_tokens ?? 0
const usd = par.state.spent_usd ?? 0
console.log(`spend: ${formatSpend({ tokens, costUsd: usd })} (${STUB ? 'stub' : 'paid, expect >0'})`)

if (STUB) {
  const seq = await runSequential()
  console.log('\n=== sequential backend (same scenario, for comparison) ===')
  console.log(`verdict: ${seq.verdict.status}; accepted rounds: ${seq.rounds}`)
  // $0 criterion: parallel raised BOTH objectives in ONE batch round; sequential took TWO single-objective
  // rounds; both converged; the merged parent is last-good. The structural speedup, proven at $0.
  const ok = par.verdict.status === 'done' && par.batchRounds === 1 && par.mergedBoth && par.parentOk &&
    par.a >= 90 && par.b >= 90 && seq.verdict.status === 'done' && seq.rounds === 2
  console.log(ok
    ? `\nreading: (stub) harness OK — parallel merged both objectives in 1 batch round (1 gate re-measure) vs sequential's 2 rounds (2 gates), same converged result. Speedup proven structurally; ready for the paid run.`
    : `\nreading: harness ISSUE — par.done=${par.verdict.status === 'done'} batchRounds=${par.batchRounds} mergedBoth=${par.mergedBoth} parentOk=${par.parentOk} a=${par.a} b=${par.b} seqRounds=${seq.rounds}. Fix before spending.`)
  process.exit(ok ? 0 : 1)
} else {
  if (par.verdict.status !== 'done' || !par.parentOk || par.a < 90 || par.b < 90) {
    console.log(`\nreading: FAIL — the parallel run did not converge correctly (done=${par.verdict.status === 'done'} parentOk=${par.parentOk} a=${par.a} b=${par.b}). A real gate/merge breach.`)
    process.exit(1)
  }
  if (par.batchRounds === 1 && par.mergedBoth) {
    console.log(`\nreading: NON-NULL — two real ${model} editors ran CONCURRENTLY in their own worktrees, both genuinely raised their disjoint objective, and their edits MERGED into ONE candidate that passed the gate ONCE (1 batch round for 2 objectives). The concurrent fan-out worked under the identical gate.`)
  } else {
    console.log(`\nreading: NULL — the run converged correctly, but the speedup path (both objectives merged in ONE batch round) was not exercised by real models (a real editor likely flaked/no-op'd a round; batchRounds=${par.batchRounds} mergedBoth=${par.mergedBoth}). Correctness held; the one-round merge was shown only by the stub.`)
  }
  process.exit(0)
}
