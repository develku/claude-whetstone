// The durable, code-owned INTER-objective ledger for a converge run (converge-state.json). The model never
// writes it. It lives OUTSIDE --scope (gitignored) and carries the per-objective vector, the gc-safe
// last-good ref, the floor record, cumulative + per-objective-lifetime spend, the inflight objective, and
// the rounds ledger. Each child objective keeps its OWN state.json (state.mjs) for intra-objective resume;
// this owns only the global picture. Mirrors state.mjs's atomic tmp+rename write; imports its helpers,
// never edits it.
import { writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { isoNow } from './state.mjs'
import { redactSecrets } from './redact.mjs'
import { isJudgeClass } from './converge-shared.mjs'

// Inc 3a: a stable content hash of the operator-authored GLOBAL held-out truth package — its scorers, targets,
// AND membership (the SET). Canonicalizes each check's keys (order-insensitive) but preserves array membership, so
// weakening a target OR dropping/adding a check changes the hash. Recorded at init; the truth bar cannot move
// within a run (a replan may revise the decomposition, never this — DCA 20260629T141245).
export function heldOutTruthHash(globalHeldOut) {
  // Hash ONLY the truth-defining triple in a fixed key order (not the mutable score/met), so the SAME hash is
  // computed at init (manifest items) and on resume (state items carry extra score/met fields).
  const canon = (globalHeldOut ?? []).map((c) => ({ id: c.id, scorer: c.scorer, target: c.target }))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

// The honesty constant: Track C proves the DECLARED objective set is met, NEVER that the set is SUFFICIENT
// for the repo goal (that is Track A). Hard-coded here so NO code path can flip it (the gate cannot
// over-claim coverage). coverage_score is Track A's separate reserved field so the two never alias.
export const OBJECTIVES_SUFFICIENCY = 'unproven'

// A DURABLE git branch is the last-good anchor — gc-safe and rev-parse-able on resume. A bare SHA would
// orphan when an objective child runs `reset --hard` (which moves the shared branch).
export const LAST_GOOD_REF = 'whetstone/converge-last-good'

export function initConvergeState(cfg, manifest) {
  const ts = isoNow()
  return {
    goal: manifest.goal,
    objectives_path: cfg.objectivesPath ? resolve(cfg.objectivesPath) : null,
    scope: cfg.scope ? resolve(cfg.scope) : null,
    // Track A (the proactive planner) threads honest provenance here: a planner-driven run passes
    // objectivesSource:'planner' so the durable ledger never records the 'operator-manifest' lie. The
    // ?? defaults keep every operator-authored path (and every existing test) on the hard-coded values.
    objectives_source: cfg.objectivesSource ?? 'operator-manifest',
    objectives_sufficiency: OBJECTIVES_SUFFICIENCY,
    coverage_score: cfg.coverageScore ?? null, // Track-A report-only span; never read by C's gate
    last_good_ref: LAST_GOOD_REF,
    last_good_sha: null,
    floor: {
      cmd: manifest.floor.cmd,
      readOnly: manifest.floor.readOnly ?? [],
      andConfirm: manifest.floor.andConfirm ?? null,
      last_exit: null,
      last_score: null,
      last_replicas: null,
    },
    objectives: manifest.objectives.map((o) => ({
      id: o.id,
      goal: o.goal,
      scorer: o.scorer,
      confirmScorer: o.confirmScorer ?? null,
      editScope: o.editScope,
      readOnly: o.readOnly ?? [],
      target: o.target,
      judgeClass: isJudgeClass(o),
      priority: o.priority ?? 0,
      cap: o.cap ?? manifest.objective_cap ?? null,
      met: false,
      primaryScore: null,
      confirmScore: null,
      best_confirm: null,
      met_at_sha: null,
      // diagnostic/reserved: the live regression check (converge.mjs regressionCheck) computes the
      // pre-integration score from a fresh per-round snapshot of the vector, NOT from this field.
      pre_integration_score: null,
      child_loop_dir: null,
      status: 'unmet',
      spent_usd: 0,
      spent_tokens: 0,
      lifetime_spent_usd: 0,
      lifetime_spent_tokens: 0,
      retries: 0,
      attempts: 0, // times this objective has been picked — pickNextObjective round-robins on the minimum
    })),
    // Inc 3a: the operator-authored, run-IMMUTABLE GLOBAL held-out truth gate — a top-level acceptance
    // requirement SEPARATE from the per-objective confirms (globalVerdict's done requires every check met). Each
    // is measured against the candidate in reMeasureAll like an objective; score starts null (unmeasured = blocks
    // done). held_out_truth_hash pins the package so a resume cannot silently weaken/drop a check.
    global_held_out: (manifest.global_held_out ?? []).map((c) => ({ id: c.id, scorer: c.scorer, target: c.target, score: null, met: false })),
    held_out_truth_hash: heldOutTruthHash(manifest.global_held_out),
    global_budget_usd: cfg.globalBudgetUsd ?? null,
    global_budget_tokens: cfg.globalBudgetTokens ?? null,
    spent_usd: 0,
    spent_tokens: 0,
    global_cap: cfg.globalCap ?? 20,
    // Inc 1 tournament: K independent candidates per objective step (1 = no tournament, the default + unchanged
    // single-candidate path). >1 selects runObjectiveTournament, which picks the winner by the held-out truth
    // signal (the winner's-curse antidote). Held verbatim across resume so a tournament run resumes as one.
    candidates: cfg.candidates ?? 1,
    global_pass: 0,
    global_plateau_window: cfg.globalPlateauWindow ?? 3,
    global_min_progress: cfg.globalMinProgress ?? 1,
    global_stability_runs: cfg.globalStabilityRuns ?? 2,
    min_delta: cfg.minDelta ?? 1,
    objective_retries: cfg.objectiveRetries ?? 1,
    inflight: null,
    rounds: [],
    binding_history: [],
    global_status: 'running',
    global_reason: null,
    cycle: 0,
    started_at: ts,
    updated_at: ts,
  }
}

// Self-ignoring run dir (mirrors state.mjs ensureLoopDir): the converge dir holds state that may carry
// secrets and must never be committed wherever it lands.
export function ensureConvergeDir(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '*\n')
}

const convergeStatePath = (dir) => join(dir, 'converge-state.json')

export const loadConvergeState = (dir) => JSON.parse(readFileSync(convergeStatePath(dir), 'utf8'))

// Crash-safe write: converge-state.json is --resume's only durable input, so write to a temp file and
// rename over it (atomic on the same filesystem). Redacted, same as state.mjs.
export function saveConvergeState(dir, state) {
  const tmp = convergeStatePath(dir) + '.tmp'
  writeFileSync(tmp, redactSecrets(JSON.stringify({ ...state, updated_at: isoNow() }, null, 2)))
  renameSync(tmp, convergeStatePath(dir))
}

// inflight is a SINGLETON for a sequential run (runOneObjective) and a SET for a parallel batch round. This
// shape-tolerant reader lets BOTH resume through the same path: a Track-C singleton object, a Track-B array,
// or null all normalize to an array (Track B inc 5). The sequential write sites are unchanged (they keep
// writing singletons); only the reader is tolerant.
export function inflightList(state) {
  const f = state?.inflight
  if (f == null) return []
  return Array.isArray(f) ? f : [f]
}

// The global budget is enforced by the orchestrator (not the gate), mirroring loop.mjs's overBudgetVerdict.
// Returns a reason when cumulative spend has exceeded the pool, else null.
export function globalBudgetExhausted(state) {
  if (state.global_budget_usd != null && state.spent_usd > state.global_budget_usd)
    return `global budget $${state.global_budget_usd} exceeded (spent $${Number(state.spent_usd).toFixed(2)})`
  if (state.global_budget_tokens != null && (state.spent_tokens ?? 0) > state.global_budget_tokens)
    return `global token budget ${state.global_budget_tokens} exceeded (spent ${state.spent_tokens})`
  return null
}
