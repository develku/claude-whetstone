// The Track C ORCHESTRATOR: drives N per-objective scope runs under ONE code-owned global gate
// (converge-gate.mjs globalVerdict). Each objective runs as an unmodified per-objective loop
// (runFromConfig + scopeDeps) in an ISOLATED worktree off the gc-safe last-good ref; its net tree is
// SQUASH-integrated (editScope-positive: only allowed paths carried) into exactly ONE commit on last-good;
// then a STRICT GLOBAL RE-MEASURE re-scores every objective + the floor against that candidate commit, and
// the global gate decides advance-or-rollback. Stability (≥2× re-measure) and budget wrap the gate exactly
// as loop.mjs wraps gateVerdict. Composes the 7 invariant files; edits none.
//
// reMeasureAll + squashIntegrate + globalVerdict + the last-good-ref logic are EXPORTED so a future Track-B
// converge-parallel.mjs reuses the IDENTICAL gate path (the report's highest-risk integration seam): the
// sequential candidate-producer is the only B-replaceable part.
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitMaterialize, gitCleanup, gitHead, isSha } from './git-snapshot.mjs'
import { pathsIntersect, globalReadOnly } from './converge-shared.mjs'
import { objectiveScore, objectiveMet, globalVerdict, globalRegressed } from './converge-gate.mjs'
import { initConvergeState, ensureConvergeDir, saveConvergeState, loadConvergeState, globalBudgetExhausted, inflightList, LAST_GOOD_REF, heldOutTruthHash } from './converge-state.mjs'
import { detectStructuralSignal } from './converge-diagnostics.mjs'
import { shq } from './shq.mjs'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// A throwaway ref that PINS the candidate commit against gc while it is being re-measured (before the gate
// accepts/rejects it) — a candidate lives only as a worktree HEAD during squashIntegrate, then as a loose
// object until the round resolves. Deleting it on accept/rollback keeps no permanent garbage ref.
export const CANDIDATE_REF = 'whetstone/converge-candidate'
export const delRef = (dir, ref) => { try { git(dir, ['branch', '-D', ref]) } catch { /* not present */ } }

// Hard wall-clock cap on every re-measure child (mirrors driver's CHILD_TIMEOUT_MS) so a hung scorer/floor
// can't wedge an unattended converge run.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000
const FLOOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'floor.mjs')

// A committed path is INTEGRATED only if it is inside the objective's editScope (the positive allowlist)
// AND not a gate/measurement file (the global read-only denylist beats the allowlist). This is the whole
// editScope-positive control — enforced at integration via selective squash, not by editing scope-act.
export function editScopeAllowed(path, editScope, globalRO = []) {
  if (!pathsIntersect(path, editScope)) return false
  return !globalRO.some((ro) => pathsIntersect(path, ro))
}

// name+status of every file that differs between two commits. --no-renames so a rename reads as delete+add
// (avoids R-status handling); the status is the FIRST char (A/M/D).
function diffNameStatus(scopeDir, fromSha, toSha) {
  const out = git(scopeDir, ['diff', '--no-renames', '--name-status', fromSha, toSha])
  if (!out) return []
  return out.split('\n').map((l) => {
    const tab = l.indexOf('\t')
    return { status: l[0], path: l.slice(tab + 1) }
  })
}

// A child's editScope-allowed and reverted changed paths off last-good (the selective-squash filter).
// `allowed` keeps {status,path} (applyAllowedChanges needs the status to choose rm vs checkout); `reverted`
// is the dropped paths (out-of-scope or gate files). Single-sourced so the single-child squashIntegrate and
// the Track-B N-way squashIntegrateBatch make the IDENTICAL allow/deny decision.
export function childAllowedChanges(scopeDir, lastGoodSha, childHeadSha, isAllowed) {
  const changed = diffNameStatus(scopeDir, lastGoodSha, childHeadSha)
  return {
    allowed: changed.filter((c) => isAllowed(c.path)),
    reverted: changed.filter((c) => !isAllowed(c.path)).map((c) => c.path),
  }
}

// Apply one child's allowed changed paths into an ALREADY-materialized worktree (no commit). A delete is an
// `rm`; any other status is a `checkout` of that path from the child's HEAD. Disjoint editScopes make N
// children's applies non-interfering — squashIntegrateBatch applies many into one worktree, then commits once.
export function applyAllowedChanges(wt, childHeadSha, allowed) {
  for (const c of allowed) {
    if (c.status === 'D') git(wt, ['rm', '-q', '--', c.path])
    else git(wt, ['checkout', childHeadSha, '--', c.path])
  }
}

// Reduce a child's net tree (lastGoodSha -> childHeadSha) to EXACTLY ONE squash commit on lastGoodSha,
// carrying ONLY the paths isAllowed() admits (editScope-positive; gate files excluded). The candidate's
// PARENT is lastGoodSha by construction (codex: parent-equality is stronger than merely-descendant). A
// child whose only changes are out-of-scope (or all-empty) yields zero allowed change -> NO advance
// (mirrors decompose's gitTreeChanged honesty). Built in a throwaway worktree so the live tree/branch is
// untouched until the gate accepts the candidate.
export function squashIntegrate(scopeDir, lastGoodSha, childHeadSha, isAllowed, label = 'integrate') {
  if (!isSha(lastGoodSha) || !isSha(childHeadSha)) throw new Error('squashIntegrate requires commit SHAs')
  const { allowed, reverted } = childAllowedChanges(scopeDir, lastGoodSha, childHeadSha, isAllowed)
  if (!allowed.length) return { advanced: false, sha: lastGoodSha, reverted, integrated: [] }
  const wt = gitMaterialize(scopeDir, lastGoodSha)
  try {
    applyAllowedChanges(wt, childHeadSha, allowed)
    git(wt, ['add', '-A'])
    git(wt, ['commit', '--quiet', '-m', `whetstone-converge: ${label}`])
    return { advanced: true, sha: gitHead(wt), reverted, integrated: allowed.map((c) => c.path) }
  } finally {
    gitCleanup(scopeDir, wt)
  }
}

// --- the STRICT GLOBAL RE-MEASURE: score the floor + every objective against a pristine candidate commit ---

// Run the deterministic floor via the shipped floor.mjs (cwd = a pristine worktree of the candidate). The
// floor's pass/fail is encoded in floor.mjs's JSON score (0 = the floor command failed), NOT in an exit
// code. NOT routed through floorConfirmCmd (that builds a confirm-shaped --and/--output command).
function defaultRunFloor(floorCmd, cwd) {
  const res = spawnSync('node', [FLOOR_PATH, '--cmd', floorCmd], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`floor failed to spawn (${res.error.code || res.error.message})`)
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`floor.mjs produced no JSON (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}`)
  }
}

// Run a project scorer (cwd = a pristine worktree of the candidate). Same {score,critique} + CLI contract as
// the scope path (--output/--loop-dir/--pass), scoring the committed SHA's tree.
function defaultRunScorer(scorerCmd, cwd) {
  const full = `${scorerCmd} --output ${shq(cwd)} --loop-dir ${shq(cwd)} --pass 000`
  const res = spawnSync(full, { shell: true, cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`scorer failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`)
  return JSON.parse(res.stdout)
}

// Floor with a one-shot REPLICA GATE: a fail on attempt 1 is re-run once in a FRESH worktree (transient
// build/network/port flake immunity); only a reproduced fail scores 0. Each attempt is a pristine worktree.
function measureFloor(scopeDir, candidateSha, floorCmd, materialize, cleanup, runFloor) {
  const once = () => {
    const wt = materialize(scopeDir, candidateSha)
    try {
      return runFloor(floorCmd, wt)
    } finally {
      cleanup(scopeDir, wt)
    }
  }
  const r1 = once()
  if (r1.score === 100) return { score: 100, critique: r1.critique ?? '', replicas: 1 }
  const r2 = once()
  if (r2.score === 100) return { score: 100, critique: r2.critique ?? '', replicas: 2 }
  return { score: 0, critique: r2.critique ?? r1.critique ?? 'deterministic floor failed', replicas: 2 }
}

// reMeasureAll: the strict global re-measure against a pristine candidate commit. Runs the FLOOR FIRST and
// SHORT-CIRCUITS on a (reproduced) floor failure — the expensive objective scorers are never paid for on a
// broken repo. Then scores every objective in its OWN fresh worktree (so project-test scorers writing
// __pycache__/.cache to cwd cannot cross-contaminate); a judge objective additionally runs its HELD-OUT
// confirm (the value globalVerdict reads for MET). deps inject materialize/cleanup/runFloor/runScorer so the
// control logic is testable without real worktrees or spend. Track B reuses this VERBATIM on a merged
// candidateSha — the gate path is identical regardless of how the candidate was produced.
export function reMeasureAll(scopeDir, candidateSha, objectives, floor, deps = {}) {
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const runFloor = deps.runFloor ?? defaultRunFloor
  const runScorer = deps.runScorer ?? defaultRunScorer

  const floorRes = measureFloor(scopeDir, candidateSha, floor.cmd, materialize, cleanup, runFloor)
  if (floorRes.score === 0) return { floor: floorRes, vector: null, blocked: true }

  const vector = objectives.map((o) => {
    const wt = materialize(scopeDir, candidateSha)
    try {
      const primary = runScorer(o.scorer, wt)
      let confirmScore = null
      let critique = primary.critique ?? ''
      if (o.judgeClass) {
        const c = runScorer(o.confirmScorer, wt)
        confirmScore = c.score
        critique = c.critique ?? critique
      }
      return { id: o.id, primaryScore: primary.score, confirmScore, critique }
    } finally {
      cleanup(scopeDir, wt)
    }
  })
  return { floor: floorRes, vector, blocked: false }
}

// Inc 3a: measure the operator-authored GLOBAL held-out truth checks against a pristine candidate commit — each
// in its OWN fresh worktree (same isolation as objective scorers). Kept SEPARATE from reMeasureAll (which Track B
// reuses verbatim) so reMeasureAll's shape is byte-stable; the global truth gate is a SEQUENTIAL-path addition
// (parallel refuses a manifest with global_held_out). Empty -> [] -> a total no-op.
export function measureGlobalHeldOut(scopeDir, candidateSha, globalHeldOut, deps = {}) {
  if (!globalHeldOut || !globalHeldOut.length) return []
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const runScorer = deps.runScorer ?? defaultRunScorer
  return globalHeldOut.map((c) => {
    const wt = materialize(scopeDir, candidateSha)
    try {
      return { id: c.id, score: runScorer(c.scorer, wt).score }
    } finally {
      cleanup(scopeDir, wt)
    }
  })
}

// Stamp measured global-held-out scores + met onto state.global_held_out (globalVerdict's done reads .met/.score).
export function applyGlobalHeldOut(state, results) {
  for (const c of state.global_held_out ?? []) {
    const r = results.find((x) => x.id === c.id)
    if (!r) continue
    c.score = r.score
    c.met = typeof r.score === 'number' && r.score >= c.target
  }
}

// --- the ORCHESTRATOR loop (runConverge) and its helpers ---

// The documented per-pass token floor (act-claude's ~150K context-reload tax) — the pre-launch reservation
// uses it so an objective that cannot afford one pass is not launched (it would overshoot, report §6-a).
export const ONE_PASS_TOKENS = 150_000

// The next UNMET, non-skipped objective to attempt. ROUND-ROBIN by attempt count first (the least-attempted
// objective gets the turn) so a sibling cannot be starved — critical when one objective's score is gated on
// another's file (a cannot progress until b runs; without fairness a would be picked forever). Ties: higher
// priority, then stable manifest order.
export function pickNextObjective(state) {
  const live = state.objectives.filter((o) => o.status === 'unmet')
  if (!live.length) return null
  return live.reduce((best, o) => {
    const ao = o.attempts ?? 0
    const ab = best.attempts ?? 0
    if (ao !== ab) return ao < ab ? o : best
    if ((o.priority ?? 0) !== (best.priority ?? 0)) return (o.priority ?? 0) > (best.priority ?? 0) ? o : best
    return best
  }, live[0])
}

// Each objective's fair share of the REMAINING pool, denominator = objectives still with budget (a starved
// objective's share is reclaimed by siblings). null pool dial => unbounded on that dial.
export function objectiveBudgetSlice(state) {
  const live = Math.max(1, state.objectives.filter((o) => o.status === 'unmet').length)
  const remUsd = state.global_budget_usd == null ? null : Math.max(0, state.global_budget_usd - state.spent_usd)
  const remTok = state.global_budget_tokens == null ? null : Math.max(0, state.global_budget_tokens - (state.spent_tokens ?? 0))
  return { usd: remUsd == null ? null : remUsd / live, tokens: remTok == null ? null : Math.floor(remTok / live) }
}

// Pre-launch reservation: refuse to launch when the slice cannot fund the expected passes (not merely <=0).
// `passes` is 1 for a single-candidate step and state.candidates for a tournament ROUND (K independent children,
// each funded up to the full slice) — so a K-candidate round is started only when all K passes are affordable,
// closing the otherwise-K×-overshoot that a post-pass-only check would allow.
export function canAffordObjective(state, passes = 1) {
  const s = objectiveBudgetSlice(state)
  if (s.tokens != null && s.tokens < passes * ONE_PASS_TOKENS) return false
  if (s.tokens == null && s.usd != null && s.usd <= 0) return false
  return true
}

const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100

export function applyFloor(state, floorRes) {
  state.floor = { ...state.floor, last_score: floorRes.score, last_replicas: floorRes.replicas ?? null }
}

// Stamp the re-measured vector onto the objective records and recompute met/status (met uses the held-out
// confirm for a judge, the primary for a deterministic — objectiveMet owns that choice).
export function applyVector(state, vector, atSha) {
  for (const o of state.objectives) {
    const v = vector.find((x) => x.id === o.id)
    if (!v) continue
    o.primaryScore = v.primaryScore
    o.confirmScore = v.confirmScore
    o.last_critique = v.critique
    o.met = objectiveMet(o)
    o.status = o.met ? 'met' : 'unmet'
    if (o.met) o.met_at_sha = atSha
    const sc = objectiveScore(o)
    if (valid(sc) && (o.best_confirm == null || sc > o.best_confirm)) o.best_confirm = sc
  }
}

// Did the candidate regress vs the pre-integration vector? Reuses the tested globalRegressed by feeding it
// the NEW scores + each objective's PRIOR met flag and PRIOR score as pre_integration_score. Exported so the
// parallel path (converge-parallel.mjs) judges the MERGED candidate with the IDENTICAL predicate — literal
// gate reuse, no fork.
export function regressionCheck(preObjectives, rmVector, floorScore, minDelta) {
  const objs = preObjectives.map((pre) => {
    const v = rmVector?.find((x) => x.id === pre.id) ?? {}
    return {
      id: pre.id,
      target: pre.target,
      judgeClass: pre.judgeClass,
      primaryScore: v.primaryScore ?? null,
      confirmScore: v.confirmScore ?? null,
      met: pre.met,
      pre_integration_score: objectiveScore(pre),
    }
  })
  return globalRegressed(objs, floorScore, minDelta)
}

// The binding (worst-unmet) score this cycle, for the global plateau signal; 100 when all met. The 0
// fallback (all unmet scores invalid -> Math.min of [] -> Infinity -> 0) is unreachable in practice: an
// invalid objective score makes globalVerdict return 'error' and the loop exits before the next pushBinding,
// so a plateau is never driven off a synthetic 0.
export function pushBinding(state) {
  const unmet = state.objectives.filter((o) => !objectiveMet(o))
  const binding = unmet.length ? Math.min(...unmet.map((o) => objectiveScore(o)).filter(valid)) : 100
  state.binding_history = [...state.binding_history, Number.isFinite(binding) ? binding : 0]
}

export function chargeSpend(state, obj, spentUsd, spentTokens) {
  state.spent_usd += spentUsd
  state.spent_tokens = (state.spent_tokens ?? 0) + spentTokens
  obj.spent_usd += spentUsd
  obj.spent_tokens += spentTokens
  obj.lifetime_spent_usd += spentUsd
  obj.lifetime_spent_tokens += spentTokens
}

export function bumpRetryOrSkip(state, obj) {
  obj.retries += 1
  if (obj.retries > state.objective_retries) obj.status = 'skipped'
}

// Advance the anchor: fast-forward the working branch to the candidate AND move the durable gc-safe named
// ref (whetstone/converge-last-good) so it is rev-parse-able on resume / for diagnostics (the named ref is
// the spec's "gc-safe anchor"; the working branch is the operator's checkout, kept in sync).
export const advanceLastGood = (scopeDir, candidateSha) => {
  git(scopeDir, ['reset', '--hard', candidateSha])
  git(scopeDir, ['clean', '-fdq'])
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, candidateSha])
  return candidateSha
}
export const rollbackToLastGood = (scopeDir, lastGoodSha) => {
  git(scopeDir, ['reset', '--hard', lastGoodSha])
  git(scopeDir, ['clean', '-fdq'])
}

export function buildObjectiveCfg(obj, state, cfg, wt, globalRO, slice) {
  return {
    goal: obj.goal,
    scope: wt,
    artifactPath: wt,
    scorerCmd: obj.scorer,
    confirmScorerCmd: obj.confirmScorer ?? null,
    editScope: obj.editScope,
    readOnly: globalRO,
    targetScore: obj.target,
    hardCap: obj.cap ?? 4,
    budgetUsd: slice.usd,
    budgetTokens: slice.tokens,
    model: cfg.model,
    effort: cfg.effort,
    escalateModel: cfg.escalateModel,
    noEscalate: cfg.noEscalate ?? true, // a converge child is already an objective unit; no second opus escalation inside
    mcpConfig: cfg.mcpConfig,
    loopDir: join(cfg.convergeDir, 'children', `${obj.id}-${state.cycle}`),
  }
}

// The done-edge STABILITY gate (DCA refinement #6, the concrete "stable"): re-run the FULL vector + floor at
// last-good (global_stability_runs total readings); done stands only if EVERY reading keeps all objectives
// met and the floor passing. A flaky deterministic-labelled scorer that spiked to target once does not certify.
export function stabilityHolds(scopeDir, state, reMeasure, deps = {}) {
  for (let i = 1; i < (state.global_stability_runs ?? 1); i++) {
    const rm = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
    if (rm.blocked) return false
    for (const o of state.objectives) {
      const v = rm.vector.find((x) => x.id === o.id)
      const probe = { ...o, primaryScore: v?.primaryScore ?? null, confirmScore: v?.confirmScore ?? null }
      if (!objectiveMet(probe)) return false
    }
    // Inc 3a: a stable done must also keep the global held-out truth satisfied across the re-measure.
    const gho = measureGlobalHeldOut(scopeDir, state.last_good_sha, state.global_held_out, deps)
    for (const c of state.global_held_out ?? []) {
      const r = gho.find((x) => x.id === c.id)
      if (!(r && typeof r.score === 'number' && r.score >= c.target)) return false
    }
  }
  return true
}

function finalize(state, verdict) {
  state.global_status = verdict.status
  state.global_reason = verdict.reason
  // Inc 2 (diagnostic only, no authority): on a non-done outcome, attach WHY the run stalled — a structural
  // signal the outer-loop replan seat (Inc 3, deferred) would consume. Never read by globalVerdict; pure advisory.
  state.structural_signal = verdict.status === 'done' ? null : detectStructuralSignal(state).signal
}

// runConverge: a FRESH global convergence run. CODE owns decompose-target (pickNextObjective), the measured
// stop (globalVerdict), budget (globalBudgetExhausted + pre-launch reservation), keep-best (advance/rollback
// the last-good anchor), and the honesty boundary (objectives_sufficiency stays 'unproven'). deps.runChild is
// the per-objective loop (runFromConfig + scopeDeps) — injected so the whole orchestrator is $0-testable with
// a stub child that makes git commits.
// The shared FRESH-run setup: init the ledger, create the gc-safe last-good anchor at the starting tree, and
// baseline-measure before any edit. Returns the baseline-measured state + globalRO; blockedVerdict is non-null
// iff the deterministic floor failed at baseline (the caller returns it). Single-sourced so the sequential
// runConverge AND Track B's runConvergeParallel start from the IDENTICAL baseline (the gate-identity guarantee
// extended to the run's entry, not just the per-candidate re-measure).
export function setupConvergeRun(cfg, manifest, scopeDir, deps = {}) {
  const reMeasure = deps.reMeasure ?? reMeasureAll
  const state = initConvergeState(cfg, manifest)
  ensureConvergeDir(cfg.convergeDir)
  // globalReadOnly reads the same shape from `state` as from the manifest (initConvergeState copies
  // floor.readOnly + each objective's readOnly/scorer/confirmScorer), so resume can reconstruct it identically.
  const globalRO = globalReadOnly(state, scopeDir)

  // The last-good anchor: the operator's working branch tracks it, AND a durable named ref
  // (whetstone/converge-last-good) is maintained so it is rev-parse-able on resume / diagnostics. Both are
  // safe because children run in ISOLATED worktrees — a child's reset --hard never moves either.
  state.last_good_sha = gitHead(scopeDir)
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, state.last_good_sha])
  const baseline = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
  if (baseline.blocked) {
    applyFloor(state, baseline.floor)
    const blockedVerdict = { status: 'blocked', reason: `deterministic floor failed at baseline (${state.floor.cmd}) — fix the repo before converging` }
    finalize(state, blockedVerdict)
    saveConvergeState(cfg.convergeDir, state)
    ;(deps.log ?? (() => {}))({ cycle: 0, ...blockedVerdict })
    return { state, globalRO, blockedVerdict }
  }
  applyFloor(state, baseline.floor)
  applyVector(state, baseline.vector, state.last_good_sha)
  applyGlobalHeldOut(state, measureGlobalHeldOut(scopeDir, state.last_good_sha, state.global_held_out, deps)) // Inc 3a baseline truth
  pushBinding(state)
  saveConvergeState(cfg.convergeDir, state)
  return { state, globalRO, blockedVerdict: null }
}

export async function runConverge(cfg, manifest, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  if (typeof deps.runChild !== 'function') throw new Error('runConverge requires deps.runChild (the per-objective loop)')
  const { state, globalRO, blockedVerdict } = setupConvergeRun(cfg, manifest, scopeDir, deps)
  if (blockedVerdict) return { state, verdict: blockedVerdict }
  return convergeLoop(state, cfg, scopeDir, globalRO, deps)
}

// resumeConverge: continue a crashed/paused run from converge-state.json — the durable-control-plane half.
// HARD-RESET the tree to last_good_sha UNCONDITIONALLY (a committed-but-unrecorded HEAD>last_good is
// indistinguishable from a killed-mid-revert gate-tampered tree, so unrecorded == discard+redo), then
// RE-DERIVE met by re-measuring the SHA (the recorded vector is evidence, not authority). Refuse if the
// budget is already spent.
// The shared resume recipe (single-sourced like setupConvergeRun): load the ledger, HARD-RESET to last_good
// UNCONDITIONALLY (a committed-but-unrecorded HEAD>last_good is indistinguishable from a killed-mid-revert
// gate-tampered tree, so unrecorded == discard+redo), reclaim crashed children, RE-DERIVE met by re-measuring
// the SHA (recorded vector is evidence, not authority), and refuse if the (biased-up) budget is already spent.
// Returns { state, globalRO, blockedVerdict }; throws on a budget refusal. Track B inc 5 adds the inflight-SET
// crash recovery. Used by BOTH prepareGlobalResume (sequential) and prepareGlobalResumeParallel.
export function prepareResumeState(cfg, scopeDir, deps = {}) {
  const reMeasure = deps.reMeasure ?? reMeasureAll
  const state = loadConvergeState(cfg.convergeDir)
  if (!isSha(state.last_good_sha)) throw new Error(`cannot resume: corrupt last_good_sha (${state.last_good_sha})`)
  // Inc 3a: the immutable global held-out truth cannot be weakened/dropped across a resume — its recorded hash
  // must still match (guards against tampering the durable state's truth gate between runs).
  if (state.held_out_truth_hash != null && heldOutTruthHash(state.global_held_out) !== state.held_out_truth_hash)
    throw new Error('cannot resume: the global held-out truth gate changed since this run started (hash mismatch) — the truth bar is immutable within a run')
  // Inc 3a (C1): the parallel backend does NOT measure/gate the global held-out, and --resume bypasses
  // convergeRefusal — so refuse a PARALLEL resume of a run carrying a global truth here (the shared resume path),
  // else a parallel batch could declare done on a STALE truth score. Sequential resume re-measures every accept.
  if (cfg.parallel && (state.global_held_out?.length ?? 0) > 0)
    throw new Error('cannot resume with --parallel: the global held-out truth gate is not wired for the parallel backend — resume sequentially (omit --parallel) when global_held_out is set')

  rollbackToLastGood(scopeDir, state.last_good_sha) // discard ALL of HEAD>last_good
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, state.last_good_sha]) // re-pin the durable named anchor

  // Crash recovery (Track B inc 5): a run killed MID-BATCH left an inflight SET whose children's ACTUAL spend
  // was never charged (the round crashed before its accounting tail). Reclaim leaked worktree admin entries,
  // clean each recorded child tmp dir, and conservatively charge each child's RESERVED tokens to spent
  // (bias UP) so the budget re-check below never under-counts. The inflight SET's PRESENCE is the
  // crash/complete discriminator: a completed round cleared inflight AND charged its actual spend, so there is
  // NO double-count here. inflightList tolerates a singleton (sequential, no reservation → charge 0) or a SET.
  try { git(scopeDir, ['worktree', 'prune']) } catch { /* best-effort admin reclaim */ }
  const convergeRoot = resolve(cfg.convergeDir)
  for (const entry of inflightList(state)) {
    // CONTAIN the destructive recursive rmSync to convergeDir — childTmpDir is read from the (gitignored,
    // but still on-disk) state file, so a garbage/tampered path must never delete outside the run dir. Same
    // trust-boundary discipline as isSha guarding reset/worktree on real SHAs.
    const dir = entry.childTmpDir ?? entry.child_loop_dir
    if (dir) {
      const abs = resolve(dir)
      if (abs === convergeRoot || abs.startsWith(convergeRoot + sep)) { try { rmSync(abs, { recursive: true, force: true }) } catch { /* may already be gone */ } }
    }
    // bias UP: charge the reservation to the GLOBAL pool ALWAYS (never under-count the budget), plus the
    // per-objective ledger when the objective still exists (a manifest edited between crash and resume may
    // have dropped or renamed it; the global pool charge must not be lost in that case).
    const reserved = entry.reservedTokens ?? 0
    if (reserved > 0) {
      state.spent_tokens = (state.spent_tokens ?? 0) + reserved
      const obj = state.objectives.find((o) => o.id === entry.objectiveId)
      if (obj) { obj.spent_tokens += reserved; obj.lifetime_spent_tokens += reserved }
    }
  }
  state.reserved_tokens = 0 // the in-flight reservation is now resolved into spent (bias up)

  const rm = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
  if (rm.blocked) {
    applyFloor(state, rm.floor)
    const blockedVerdict = { status: 'blocked', reason: `deterministic floor fails at last-good on resume (${state.floor.cmd})` }
    finalize(state, blockedVerdict)
    saveConvergeState(cfg.convergeDir, state)
    return { state, globalRO: globalReadOnly(state, scopeDir), blockedVerdict }
  }
  applyFloor(state, rm.floor)
  applyVector(state, rm.vector, state.last_good_sha) // re-derive met from the SHA; recorded vector untrusted
  applyGlobalHeldOut(state, measureGlobalHeldOut(scopeDir, state.last_good_sha, state.global_held_out, deps)) // Inc 3a: re-derive the truth too
  const over = globalBudgetExhausted(state)
  if (over) throw new Error(`cannot resume: ${over} — raise the global budget above what was already spent`)
  state.inflight = null
  state.global_status = 'running'
  state.global_reason = null
  return { state, globalRO: globalReadOnly(state, scopeDir), blockedVerdict: null }
}

export async function prepareGlobalResume(cfg, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  if (typeof deps.runChild !== 'function') throw new Error('prepareGlobalResume requires deps.runChild')
  const { state, globalRO, blockedVerdict } = prepareResumeState(cfg, scopeDir, deps)
  if (blockedVerdict) return { state, verdict: blockedVerdict }
  return convergeLoop(state, cfg, scopeDir, globalRO, deps)
}

// runOneObjective: the per-objective GATE STEP — materialize a worktree off last-good, run the child editor,
// selectively integrate its editScope-allowed edits, strictly re-measure the candidate, and ACCEPT (advance
// the anchor) or ROLLBACK. Mutates `state` in place and RETURNS the post-step global verdict. This is the
// SINGLE-SOURCED gate path: convergeLoop's sequential loop AND Track B's sequential fallback both call it, so
// a parallel run can never be less-gated than sequential. Extracted verbatim from the loop body (no behavior
// change — the 691 tests are the proof). The caller owns budget guards + pickNextObjective + the attempts bump.
export async function runOneObjective(state, cfg, scopeDir, globalRO, obj, deps = {}) {
  const log = deps.log ?? (() => {})
  const reMeasure = deps.reMeasure ?? reMeasureAll
  const runChild = deps.runChild

  state.global_pass += 1
  state.cycle += 1
  state.inflight = { objectiveId: obj.id, child_loop_dir: join(cfg.convergeDir, 'children', `${obj.id}-${state.cycle}`) }
  saveConvergeState(cfg.convergeDir, state)

  const slice = objectiveBudgetSlice(state)
  const wt = gitMaterialize(scopeDir, state.last_good_sha)
  let integ
  let spentUsd = 0
  let spentTokens = 0
  try {
    const cs = await runChild(buildObjectiveCfg(obj, state, cfg, wt, globalRO, slice))
    spentUsd = cs?.state?.spent_usd ?? cs?.spent_usd ?? 0
    spentTokens = cs?.state?.spent_tokens ?? cs?.spent_tokens ?? 0
    const childHead = gitHead(wt)
    integ = squashIntegrate(scopeDir, state.last_good_sha, childHead, (p) => editScopeAllowed(p, obj.editScope, globalRO), obj.id)
  } finally {
    gitCleanup(scopeDir, wt)
  }
  chargeSpend(state, obj, spentUsd, spentTokens) // tokens burned regardless of accept/rollback
  state.inflight = null

  if (!integ.advanced) {
    state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: state.last_good_sha, candidate_sha: null, accepted: false, reason: 'no in-scope change', spent_tokens: spentTokens }]
    bumpRetryOrSkip(state, obj)
    pushBinding(state)
    saveConvergeState(cfg.convergeDir, state)
    const v = globalVerdict(state)
    log({ cycle: state.cycle, objective: obj.id, status: v.status, reason: 'no in-scope change' })
    return v
  }

  const candidateSha = integ.sha
  git(scopeDir, ['branch', '-f', CANDIDATE_REF, candidateSha]) // pin against gc while re-measuring (M4)
  const preAdvanceSha = state.last_good_sha // capture BEFORE the advance, for the round's pre_sha (H1)
  const pre = state.objectives.map((o) => ({ ...o }))
  const rm = reMeasure(scopeDir, candidateSha, state.objectives, state.floor)
  const regressed = rm.blocked || regressionCheck(pre, rm.vector, rm.floor.score, state.min_delta)

  if (regressed) {
    rollbackToLastGood(scopeDir, state.last_good_sha)
    delRef(scopeDir, CANDIDATE_REF) // discard the rejected candidate's pin
    state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: preAdvanceSha, candidate_sha: candidateSha, accepted: false, rolledBack: true, floor_score: rm.floor.score, spent_tokens: spentTokens }]
    bumpRetryOrSkip(state, obj)
    log({ cycle: state.cycle, objective: obj.id, status: 'rolled-back', reason: rm.blocked ? 'floor failed' : 'cross-file regression' })
  } else {
    state.last_good_sha = advanceLastGood(scopeDir, candidateSha)
    delRef(scopeDir, CANDIDATE_REF) // the named anchor now references it; drop the temp pin
    applyFloor(state, rm.floor)
    applyVector(state, rm.vector, state.last_good_sha)
    applyGlobalHeldOut(state, measureGlobalHeldOut(scopeDir, state.last_good_sha, state.global_held_out, deps)) // Inc 3a
    state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: preAdvanceSha, candidate_sha: candidateSha, accepted: true, floor_score: rm.floor.score, spent_tokens: spentTokens }]
    log({ cycle: state.cycle, objective: obj.id, status: 'integrated', reason: `score ${objectiveScore(state.objectives.find((o) => o.id === obj.id))}` })
  }
  pushBinding(state)
  saveConvergeState(cfg.convergeDir, state)
  return globalVerdict(state)
}

// pickTournamentWinner: the PURE selection heart of the Inc 1 tournament. Given the evaluated candidates for ONE
// objective, pick the winner by the TRUTH signal — the held-out confirm for a judge objective, the visible
// primary for a deterministic one — and NEVER argmax on the gameable visible (that is the winner's curse: more
// candidates = more lottery tickets against the gate's blind spots, so naive visible-max makes the gate WORSE).
// For a judge objective, if even the best held-out makes no real progress over last-good (< minDelta) the field
// is optimizing the visible rather than the truth -> REJECT ALL and emit a structural signal (Inc 2 consumes it)
// instead of integrating a gamer. Deterministic objectives have no soft gate to overfit, so they keep the
// visible-max and never reject (matching runOneObjective, which accepts any non-regressing candidate). Ineligible
// candidates (floor-blocked / regressing) are pre-marked {eligible:false} by the caller and excluded here.
export function pickTournamentWinner(candidates, { judgeClass = false, lastGoodTruth = 0, minDelta = 1 } = {}) {
  const eligible = candidates.filter((c) => c.eligible)
  if (!eligible.length) return { winnerIndex: null, rejectAll: false, signal: null, reason: 'no eligible candidate' }
  const truth = (c) => (judgeClass ? c.heldOut : c.visible)
  const winner = eligible.reduce((b, c) => (truth(c) > truth(b) ? c : b), eligible[0]) // ties keep the first (stable)
  if (judgeClass && truth(winner) - lastGoodTruth < minDelta) {
    return { winnerIndex: null, rejectAll: true, signal: 'held_out_no_progress', reason: `winner's-curse guard: best held-out ${truth(winner)} shows no real progress over last-good ${lastGoodTruth} (Δ<${minDelta}) — gaming suspected` }
  }
  return { winnerIndex: winner.index, rejectAll: false, signal: null, reason: `tournament winner #${winner.index} by ${judgeClass ? 'held-out' : 'visible'} ${truth(winner)}` }
}

// runObjectiveTournament: the Inc 1 per-objective step for candidates>1. Produces K independent candidate child
// runs off the SAME last-good, integrates + strictly re-measures EACH through the VERBATIM gate path
// (squashIntegrate + reMeasureAll + regressionCheck), then pickTournamentWinner selects the winner by the
// held-out truth signal and ACCEPTS only that one (advancing the anchor) — or rejects the whole round on the
// winner's-curse guard. Spend for ALL K children is charged (tokens burned regardless of who wins). The round is
// atomic at last-good (the anchor moves only on accept), so a crash mid-round resumes by redoing the round.
// runOneObjective is left byte-untouched; convergeLoop routes here only when state.candidates>1, so the default
// path and the 7 invariant files are unaffected.
export async function runObjectiveTournament(state, cfg, scopeDir, globalRO, obj, deps = {}) {
  const log = deps.log ?? (() => {})
  const reMeasure = deps.reMeasure ?? reMeasureAll
  const runChild = deps.runChild
  const K = Math.max(1, state.candidates ?? 1)

  state.global_pass += 1
  state.cycle += 1
  // A tournament round costs up to K passes; reserve K*ONE_PASS_TOKENS on the inflight marker so a crash
  // mid-round biases the resumed budget UP by the round's at-risk spend (prepareResumeState reads reservedTokens,
  // tolerating this singleton shape) — never under-counting. canAffordObjective(state, K) already gates the start.
  state.inflight = { objectiveId: obj.id, child_loop_dir: join(cfg.convergeDir, 'children', `${obj.id}-${state.cycle}`), reservedTokens: K * ONE_PASS_TOKENS }
  saveConvergeState(cfg.convergeDir, state)

  const slice = objectiveBudgetSlice(state)
  const pre = state.objectives.map((o) => ({ ...o }))
  const isAllowed = (p) => editScopeAllowed(p, obj.editScope, globalRO)
  const candidates = []
  let totalUsd = 0
  let totalTokens = 0

  for (let i = 0; i < K; i++) {
    const wt = gitMaterialize(scopeDir, state.last_good_sha)
    let integ
    try {
      const oc = { ...buildObjectiveCfg(obj, state, cfg, wt, globalRO, slice), loopDir: join(cfg.convergeDir, 'children', `${obj.id}-${state.cycle}-c${i}`) }
      const cs = await runChild(oc)
      totalUsd += cs?.state?.spent_usd ?? cs?.spent_usd ?? 0
      totalTokens += cs?.state?.spent_tokens ?? cs?.spent_tokens ?? 0
      integ = squashIntegrate(scopeDir, state.last_good_sha, gitHead(wt), isAllowed, `${obj.id}#${i}`)
    } finally {
      gitCleanup(scopeDir, wt)
    }
    if (!integ.advanced) { candidates.push({ index: i, eligible: false }); continue }
    const ref = `${CANDIDATE_REF}-${i}`
    git(scopeDir, ['branch', '-f', ref, integ.sha]) // pin against gc while the whole field is re-measured
    const rm = reMeasure(scopeDir, integ.sha, state.objectives, state.floor)
    const regressed = rm.blocked || regressionCheck(pre, rm.vector, rm.floor.score, state.min_delta)
    const v = rm.vector?.find((x) => x.id === obj.id) ?? {}
    candidates.push({
      index: i, ref, candidateSha: integ.sha, eligible: !regressed,
      visible: v.primaryScore ?? 0,
      heldOut: obj.judgeClass ? (v.confirmScore ?? 0) : (v.primaryScore ?? 0),
      floor: rm.floor, vector: rm.vector,
    })
  }

  chargeSpend(state, obj, totalUsd, totalTokens) // every candidate's tokens are spent regardless of who wins
  state.inflight = null
  const cleanupRefs = () => { for (const c of candidates) if (c.ref) delRef(scopeDir, c.ref) }

  const lastGoodTruth = obj.judgeClass ? (obj.confirmScore ?? 0) : (obj.primaryScore ?? 0)
  const pick = pickTournamentWinner(candidates, { judgeClass: obj.judgeClass, lastGoodTruth, minDelta: state.min_delta })

  if (pick.winnerIndex == null) {
    rollbackToLastGood(scopeDir, state.last_good_sha) // defensive: keep the live tree at the anchor
    cleanupRefs()
    state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: state.last_good_sha, candidate_sha: null, accepted: false, candidates: K, reason: pick.reason, structural_signal: pick.signal ?? null, spent_tokens: totalTokens }]
    bumpRetryOrSkip(state, obj)
    pushBinding(state)
    saveConvergeState(cfg.convergeDir, state)
    const v = globalVerdict(state)
    log({ cycle: state.cycle, objective: obj.id, status: v.status, reason: pick.reason })
    return v
  }

  const winner = candidates.find((c) => c.index === pick.winnerIndex)
  const preAdvanceSha = state.last_good_sha
  state.last_good_sha = advanceLastGood(scopeDir, winner.candidateSha)
  cleanupRefs() // the named anchor now references the winner; drop every temp candidate pin
  applyFloor(state, winner.floor)
  applyVector(state, winner.vector, state.last_good_sha)
  applyGlobalHeldOut(state, measureGlobalHeldOut(scopeDir, state.last_good_sha, state.global_held_out, deps)) // Inc 3a
  state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: preAdvanceSha, candidate_sha: winner.candidateSha, accepted: true, candidates: K, winner_index: winner.index, floor_score: winner.floor.score, spent_tokens: totalTokens }]
  log({ cycle: state.cycle, objective: obj.id, status: 'integrated', reason: pick.reason })
  pushBinding(state)
  saveConvergeState(cfg.convergeDir, state)
  return globalVerdict(state)
}

// The shared loop body for a fresh run and a resume. Both arrive with `state` already baseline-measured and
// last_good_sha set; this owns only the convergence iteration (guards + objective selection); the per-
// objective gate step is runOneObjective (single-sourced with Track B's fallback).
async function convergeLoop(state, cfg, scopeDir, globalRO, deps = {}) {
  const log = deps.log ?? (() => {})
  const reMeasure = deps.reMeasure ?? reMeasureAll

  let v = globalVerdict(state)
  log({ cycle: state.cycle, status: v.status, reason: v.reason })

  while (v.status === 'running') {
    const over = globalBudgetExhausted(state)
    if (over) { v = { status: 'capped', reason: over }; break }
    if (!canAffordObjective(state, state.candidates ?? 1)) { v = { status: 'capped', reason: 'global budget cannot fund another objective pass' }; break }
    const obj = pickNextObjective(state)
    if (!obj) { v = { status: 'capped', reason: 'no further objective can be attempted (unmet objectives exhausted their retries)' }; break }
    obj.attempts = (obj.attempts ?? 0) + 1 // round-robin fairness signal (pickNextObjective reads it)
    // Inc 1: candidates>1 runs a per-objective TOURNAMENT (winner picked on the held-out truth); 1 = the
    // unchanged single-candidate gate step. Both share the verbatim gate path (squashIntegrate/reMeasure/gate).
    const step = (state.candidates ?? 1) > 1 ? runObjectiveTournament : runOneObjective
    v = await step(state, cfg, scopeDir, globalRO, obj, deps)
  }

  // done-edge stability: certify the win is reproducible (the concrete "stable") before declaring done.
  if (v.status === 'done' && (state.global_stability_runs ?? 1) > 1) {
    if (!stabilityHolds(scopeDir, state, reMeasure, deps)) {
      v = { status: 'capped', reason: 'global stability re-measure unstable — the win did not reproduce over the done-edge re-measure' }
    }
  }

  finalize(state, v)
  saveConvergeState(cfg.convergeDir, state)
  log({ cycle: state.cycle, status: v.status, reason: v.reason })
  return { state, verdict: v }
}
