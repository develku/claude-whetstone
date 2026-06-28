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
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitMaterialize, gitCleanup, gitHead, isSha } from './git-snapshot.mjs'
import { pathsIntersect, globalReadOnly } from './converge-shared.mjs'
import { objectiveScore, objectiveMet, globalVerdict, globalRegressed } from './converge-gate.mjs'
import { initConvergeState, ensureConvergeDir, saveConvergeState, loadConvergeState, globalBudgetExhausted, LAST_GOOD_REF } from './converge-state.mjs'
import { shq } from './shq.mjs'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// A throwaway ref that PINS the candidate commit against gc while it is being re-measured (before the gate
// accepts/rejects it) — a candidate lives only as a worktree HEAD during squashIntegrate, then as a loose
// object until the round resolves. Deleting it on accept/rollback keeps no permanent garbage ref.
const CANDIDATE_REF = 'whetstone/converge-candidate'
const delRef = (dir, ref) => { try { git(dir, ['branch', '-D', ref]) } catch { /* not present */ } }

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

// Reduce a child's net tree (lastGoodSha -> childHeadSha) to EXACTLY ONE squash commit on lastGoodSha,
// carrying ONLY the paths isAllowed() admits (editScope-positive; gate files excluded). The candidate's
// PARENT is lastGoodSha by construction (codex: parent-equality is stronger than merely-descendant). A
// child whose only changes are out-of-scope (or all-empty) yields zero allowed change -> NO advance
// (mirrors decompose's gitTreeChanged honesty). Built in a throwaway worktree so the live tree/branch is
// untouched until the gate accepts the candidate.
export function squashIntegrate(scopeDir, lastGoodSha, childHeadSha, isAllowed, label = 'integrate') {
  if (!isSha(lastGoodSha) || !isSha(childHeadSha)) throw new Error('squashIntegrate requires commit SHAs')
  const changed = diffNameStatus(scopeDir, lastGoodSha, childHeadSha)
  const allowed = changed.filter((c) => isAllowed(c.path))
  const reverted = changed.filter((c) => !isAllowed(c.path)).map((c) => c.path)
  if (!allowed.length) return { advanced: false, sha: lastGoodSha, reverted, integrated: [] }
  const wt = gitMaterialize(scopeDir, lastGoodSha)
  try {
    for (const c of allowed) {
      if (c.status === 'D') git(wt, ['rm', '-q', '--', c.path])
      else git(wt, ['checkout', childHeadSha, '--', c.path])
    }
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

// Pre-launch reservation: refuse to launch when the slice cannot fund one expected pass (not merely <=0).
export function canAffordObjective(state) {
  const s = objectiveBudgetSlice(state)
  if (s.tokens != null && s.tokens < ONE_PASS_TOKENS) return false
  if (s.tokens == null && s.usd != null && s.usd <= 0) return false
  return true
}

const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100

function applyFloor(state, floorRes) {
  state.floor = { ...state.floor, last_score: floorRes.score, last_replicas: floorRes.replicas ?? null }
}

// Stamp the re-measured vector onto the objective records and recompute met/status (met uses the held-out
// confirm for a judge, the primary for a deterministic — objectiveMet owns that choice).
function applyVector(state, vector, atSha) {
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
function pushBinding(state) {
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

function bumpRetryOrSkip(state, obj) {
  obj.retries += 1
  if (obj.retries > state.objective_retries) obj.status = 'skipped'
}

// Advance the anchor: fast-forward the working branch to the candidate AND move the durable gc-safe named
// ref (whetstone/converge-last-good) so it is rev-parse-able on resume / for diagnostics (the named ref is
// the spec's "gc-safe anchor"; the working branch is the operator's checkout, kept in sync).
const advanceLastGood = (scopeDir, candidateSha) => {
  git(scopeDir, ['reset', '--hard', candidateSha])
  git(scopeDir, ['clean', '-fdq'])
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, candidateSha])
  return candidateSha
}
const rollbackToLastGood = (scopeDir, lastGoodSha) => {
  git(scopeDir, ['reset', '--hard', lastGoodSha])
  git(scopeDir, ['clean', '-fdq'])
}

function buildObjectiveCfg(obj, state, cfg, wt, globalRO, slice) {
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
function stabilityHolds(scopeDir, state, reMeasure) {
  for (let i = 1; i < (state.global_stability_runs ?? 1); i++) {
    const rm = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
    if (rm.blocked) return false
    for (const o of state.objectives) {
      const v = rm.vector.find((x) => x.id === o.id)
      const probe = { ...o, primaryScore: v?.primaryScore ?? null, confirmScore: v?.confirmScore ?? null }
      if (!objectiveMet(probe)) return false
    }
  }
  return true
}

function finalize(state, verdict) {
  state.global_status = verdict.status
  state.global_reason = verdict.reason
}

// runConverge: a FRESH global convergence run. CODE owns decompose-target (pickNextObjective), the measured
// stop (globalVerdict), budget (globalBudgetExhausted + pre-launch reservation), keep-best (advance/rollback
// the last-good anchor), and the honesty boundary (objectives_sufficiency stays 'unproven'). deps.runChild is
// the per-objective loop (runFromConfig + scopeDeps) — injected so the whole orchestrator is $0-testable with
// a stub child that makes git commits.
export async function runConverge(cfg, manifest, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  const reMeasure = deps.reMeasure ?? reMeasureAll
  if (typeof deps.runChild !== 'function') throw new Error('runConverge requires deps.runChild (the per-objective loop)')

  const state = initConvergeState(cfg, manifest)
  ensureConvergeDir(cfg.convergeDir)
  // globalReadOnly reads the same shape from `state` as from the manifest (initConvergeState copies
  // floor.readOnly + each objective's readOnly/scorer/confirmScorer), so resume can reconstruct it identically.
  const globalRO = globalReadOnly(state, scopeDir)

  // The last-good anchor: the operator's working branch tracks it, AND a durable named ref
  // (whetstone/converge-last-good) is maintained so it is rev-parse-able on resume / diagnostics. Both are
  // safe because children run in ISOLATED worktrees — a child's reset --hard never moves either. Create the
  // named ref at the starting tree, then baseline-measure before any edit.
  state.last_good_sha = gitHead(scopeDir)
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, state.last_good_sha])
  const baseline = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
  if (baseline.blocked) {
    applyFloor(state, baseline.floor)
    const v = { status: 'blocked', reason: `deterministic floor failed at baseline (${state.floor.cmd}) — fix the repo before converging` }
    finalize(state, v)
    saveConvergeState(cfg.convergeDir, state)
    ;(deps.log ?? (() => {}))({ cycle: 0, ...v })
    return { state, verdict: v }
  }
  applyFloor(state, baseline.floor)
  applyVector(state, baseline.vector, state.last_good_sha)
  pushBinding(state)
  saveConvergeState(cfg.convergeDir, state)
  return convergeLoop(state, cfg, scopeDir, globalRO, deps)
}

// resumeConverge: continue a crashed/paused run from converge-state.json — the durable-control-plane half.
// HARD-RESET the tree to last_good_sha UNCONDITIONALLY (a committed-but-unrecorded HEAD>last_good is
// indistinguishable from a killed-mid-revert gate-tampered tree, so unrecorded == discard+redo), then
// RE-DERIVE met by re-measuring the SHA (the recorded vector is evidence, not authority). Refuse if the
// budget is already spent.
export async function prepareGlobalResume(cfg, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  const reMeasure = deps.reMeasure ?? reMeasureAll
  if (typeof deps.runChild !== 'function') throw new Error('prepareGlobalResume requires deps.runChild')
  const state = loadConvergeState(cfg.convergeDir)
  if (!isSha(state.last_good_sha)) throw new Error(`cannot resume: corrupt last_good_sha (${state.last_good_sha})`)

  rollbackToLastGood(scopeDir, state.last_good_sha) // discard ALL of HEAD>last_good
  git(scopeDir, ['branch', '-f', LAST_GOOD_REF, state.last_good_sha]) // re-pin the durable named anchor
  const rm = reMeasure(scopeDir, state.last_good_sha, state.objectives, state.floor)
  if (rm.blocked) {
    applyFloor(state, rm.floor)
    const v = { status: 'blocked', reason: `deterministic floor fails at last-good on resume (${state.floor.cmd})` }
    finalize(state, v)
    saveConvergeState(cfg.convergeDir, state)
    return { state, verdict: v }
  }
  applyFloor(state, rm.floor)
  applyVector(state, rm.vector, state.last_good_sha) // re-derive met from the SHA; recorded vector untrusted
  const over = globalBudgetExhausted(state)
  if (over) throw new Error(`cannot resume: ${over} — raise the global budget above what was already spent`)
  state.inflight = null
  state.global_status = 'running'
  state.global_reason = null
  const globalRO = globalReadOnly(state, scopeDir)
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
    state.rounds = [...state.rounds, { objectiveId: obj.id, pre_sha: preAdvanceSha, candidate_sha: candidateSha, accepted: true, floor_score: rm.floor.score, spent_tokens: spentTokens }]
    log({ cycle: state.cycle, objective: obj.id, status: 'integrated', reason: `score ${objectiveScore(state.objectives.find((o) => o.id === obj.id))}` })
  }
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
    if (!canAffordObjective(state)) { v = { status: 'capped', reason: 'global budget cannot fund another objective pass' }; break }
    const obj = pickNextObjective(state)
    if (!obj) { v = { status: 'capped', reason: 'no further objective can be attempted (unmet objectives exhausted their retries)' }; break }
    obj.attempts = (obj.attempts ?? 0) + 1 // round-robin fairness signal (pickNextObjective reads it)
    v = await runOneObjective(state, cfg, scopeDir, globalRO, obj, deps)
  }

  // done-edge stability: certify the win is reproducible (the concrete "stable") before declaring done.
  if (v.status === 'done' && (state.global_stability_runs ?? 1) > 1) {
    if (!stabilityHolds(scopeDir, state, reMeasure)) {
      v = { status: 'capped', reason: 'global stability re-measure unstable — the win did not reproduce over the done-edge re-measure' }
    }
  }

  finalize(state, v)
  saveConvergeState(cfg.convergeDir, state)
  log({ cycle: state.cycle, status: v.status, reason: v.reason })
  return { state, verdict: v }
}
