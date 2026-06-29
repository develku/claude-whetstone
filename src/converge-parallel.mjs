// Track B: BATCHED fan-out under the IDENTICAL gate. Runs a BATCH of disjoint-editScope objectives in one
// round, merges into ONE candidate, and calls the verbatim reMeasureAll/globalVerdict — sequential stays the
// default, --parallel selects it, the gate path is never forked.
//
// HONESTY (finding #9/#10): the value here is STRUCTURAL, not wall-clock. The win is fewer GATE RE-MEASURES —
// N disjoint objectives clear in ONE merged gated round instead of N sequential rounds. Editor EXECUTION is
// currently SERIAL: the injected runChild ultimately calls the blocking `spawnSync` editor (act-claude), which
// holds the event loop, so the Promise.allSettled fan-out below does NOT yield wall-clock concurrency — the
// children's edits happen one after another. True concurrency would need an async editor (child_process.spawn);
// that is a DEFERRED enhancement. Relatedly, raceChild's timeout + the killChild hook are the harness for that
// future async editor and are DORMANT today (the setTimeout can't fire while a sibling's spawnSync blocks, and
// converge-cli does not wire killChild); the real per-child cap today is spawnSync's own timeout+SIGKILL.
// This slice is the PURE batch-selection +
// pre-launch budget reservation + the (literally-reused) regression predicate, plus the single-commit N-way
// merge (squashIntegrateBatch) and the worktree-admin mutex (withWorktreeLock); the orchestration round lands
// in inc 4. Imports the squash apply primitives + ONE_PASS_TOKENS + regressionCheck from converge.mjs (no fork).
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import {
  ONE_PASS_TOKENS, regressionCheck, childAllowedChanges, applyAllowedChanges, editScopeAllowed,
  reMeasureAll, runOneObjective, setupConvergeRun, prepareResumeState, buildObjectiveCfg, objectiveBudgetSlice,
  canAffordObjective, pickNextObjective, chargeSpend, bumpRetryOrSkip, pushBinding, applyFloor, applyVector,
  advanceLastGood, rollbackToLastGood, stabilityHolds, CANDIDATE_REF, delRef,
} from './converge.mjs'
import { globalVerdict } from './converge-gate.mjs'
import { globalBudgetExhausted, saveConvergeState } from './converge-state.mjs'
import { gitMaterialize, gitCleanup, gitHead, isSha } from './git-snapshot.mjs'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// Hard wall-clock cap on a fan-out child (mirrors converge.mjs's re-measure timeout) so a hung nested
// claude -p can't wedge the barrier (Promise.allSettled alone awaits a hung child forever, §3.5/§5 finding #6).
const CHILD_TIMEOUT_MS = 5 * 60 * 1000

// The next batch: the K least-attempted unmet objectives, sorted by pickNextObjective's EXACT comparator
// (attempts asc → priority desc → stable manifest order), capped at maxParallel. Disjoint by the global
// editScope invariant, so any subset is conflict-free. A member that would COMPLETE a quarantined set with
// the batch-so-far is skipped (the combination-regression guard from §3) — but its siblings still run, so no
// objective is starved; only the bad combination is avoided.
export function pickBatch(state, maxParallel) {
  const live = state.objectives.filter((o) => o.status === 'unmet')
  if (!live.length) return []
  const sorted = [...live].sort((a, b) => {
    const aa = a.attempts ?? 0
    const ba = b.attempts ?? 0
    if (aa !== ba) return aa - ba
    return (b.priority ?? 0) - (a.priority ?? 0)
  })
  const cap = Math.max(1, maxParallel)
  const quarantined = state.quarantined_batches ?? []
  const batch = []
  for (const o of sorted) {
    if (batch.length >= cap) break
    const ids = new Set([...batch.map((x) => x.id), o.id])
    if (quarantined.some((q) => q.length && q.every((id) => ids.has(id)))) continue // would re-form a bad combo
    batch.push(o)
  }
  return batch
}

// Greedy PRE-LAUNCH budget reservation (report §6-a — worse under batching: all N children of the round commit
// their spend BEFORE the gate, yet budgets are normally checked POST-pass). Admit batch members (in pickBatch
// order) while the running sum of each
// child's WHOLE-CHILD worst case (cap × ONE_PASS_TOKENS) fits the remaining pool (pool − spent − already-
// reserved). Reserving one pass per child would under-reserve up to cap× — a child runs up to `cap` passes.
// Token dial is precise; usd-only is coarse (admit up to maxParallel, no token reservation, rely on the
// post-pass usd backstop — recommend the token dial for tight parallel budgeting). Returns the admitted batch
// + the tokens to reserve; batch.length 0 ⇒ the caller caps; 1 ⇒ the caller runs it sequentially.
export function affordBatch(state, maxParallel) {
  const candidates = pickBatch(state, maxParallel)
  const hasTokenDial = state.global_budget_tokens != null
  const remTokens = hasTokenDial
    ? Math.max(0, state.global_budget_tokens - (state.spent_tokens ?? 0) - (state.reserved_tokens ?? 0))
    : Infinity
  const batch = []
  let reservedTokens = 0
  for (const o of candidates) {
    const childTokens = (o.cap ?? 4) * ONE_PASS_TOKENS
    if (hasTokenDial && reservedTokens + childTokens > remTokens) break
    batch.push(o)
    if (hasTokenDial) reservedTokens += childTokens
  }
  return { batch, reservedTokens }
}

// Did the MERGED candidate regress? The IDENTICAL predicate the sequential runOneObjective uses
// (rm.blocked || regressionCheck) — literal gate reuse, NO fork. regressionCheck (vs the pre-BATCH vector)
// catches the floor failing, a previously-met objective falling below target, and any objective's NET drop
// > min_delta. The one thing it does NOT catch is a net-positive batch that MASKS a sibling's isolated
// (non-net) drop — that is an OPTIMALITY residual (the merged candidate is still non-regressing vs last-good),
// disclosed in the spec, NOT a safety hole; closing it would require re-measuring each objective alone (the
// deferred attribution pass).
export function batchRegressed(pre, rm, minDelta) {
  return rm.blocked || regressionCheck(pre, rm.vector, rm.floor.score, minDelta)
}

// Defense-in-depth: the survivors' editScope-allowed path-sets MUST be pairwise-disjoint. Track C's
// convergeEditScopeOverlap refusal already guarantees disjoint editScopes (so any subset is collision-free),
// but a manifest-validation regression that let two scopes overlap would make the N-way apply ORDER-DEPENDENT
// (whichever child's checkout ran last wins) — a silent, unauditable merge. Throw loudly instead. O(total
// paths) via a single owner map.
function assertPairwiseDisjoint(perChild) {
  const owner = new Map() // path -> objectiveId that claimed it
  for (const c of perChild) {
    for (const ch of c.allowed) {
      const prev = owner.get(ch.path)
      if (prev !== undefined && prev !== c.objectiveId) {
        throw new Error(`squashIntegrateBatch: allowed path ${ch.path} claimed by both ${prev} and ${c.objectiveId} — editScope disjointness invariant violated`)
      }
      owner.set(ch.path, c.objectiveId)
    }
  }
}

// The single-commit N-way merge (spec §3.7). Materialize ONE throwaway worktree off lastGoodSha, apply EVERY
// survivor's editScope-allowed paths into it (selective-squash, IDENTICAL filter+apply as squashIntegrate),
// and make EXACTLY ONE commit whose parent === lastGoodSha — never a per-child commit chain. Because Track C
// makes editScopes pairwise-disjoint, the applies are collision-free at the tree level; we ASSERT that
// invariant first (throw on any shared allowed path). A survivor whose changes are all out-of-scope
// contributes nothing (perChild reports integrated:[]); if NO survivor contributes, no commit is made
// (advanced:false, sha=lastGoodSha). Single-threaded, post-barrier — the orchestrator pins CANDIDATE_REF and
// gates the returned sha exactly as the sequential path gates squashIntegrate's sha.
//   survivors: [{ obj: { id, editScope }, childHead }]   (childHead = the child worktree's HEAD sha)
//   returns:   { advanced, sha, perChild: [{ objectiveId, childHead, reverted, integrated }] }
export function squashIntegrateBatch(scopeDir, lastGoodSha, survivors, globalRO = [], label = 'batch') {
  if (!isSha(lastGoodSha)) throw new Error('squashIntegrateBatch requires a commit SHA for lastGoodSha')
  const perChild = survivors.map((s) => {
    if (!isSha(s.childHead)) throw new Error('squashIntegrateBatch requires a commit SHA for every survivor childHead')
    const { allowed, reverted } = childAllowedChanges(scopeDir, lastGoodSha, s.childHead, (p) => editScopeAllowed(p, s.obj.editScope, globalRO))
    return { objectiveId: s.obj.id, childHead: s.childHead, allowed, reverted, integrated: allowed.map((c) => c.path) }
  })
  assertPairwiseDisjoint(perChild)

  const contributing = perChild.filter((c) => c.allowed.length)
  if (!contributing.length) return { advanced: false, sha: lastGoodSha, perChild }

  const wt = gitMaterialize(scopeDir, lastGoodSha)
  try {
    for (const c of contributing) applyAllowedChanges(wt, c.childHead, c.allowed)
    git(wt, ['add', '-A'])
    git(wt, ['commit', '--quiet', '-m', `whetstone-converge: ${label} (${contributing.map((c) => c.objectiveId).join('+')})`])
    const sha = gitHead(wt)
    // Parent-equality (codex: stronger than merely-descendant): exactly ONE commit on last-good. By
    // construction (fresh worktree off last-good, one commit) this holds; assert it so a future change that
    // accidentally chained commits is caught before the candidate reaches the gate.
    const parent = git(wt, ['rev-parse', 'HEAD^'])
    const resolvedLastGood = git(scopeDir, ['rev-parse', lastGoodSha])
    if (parent !== resolvedLastGood) throw new Error(`squashIntegrateBatch: merged parent ${parent} !== last-good ${resolvedLastGood}`)
    return { advanced: true, sha, perChild }
  } finally {
    gitCleanup(scopeDir, wt)
  }
}

// An in-process async mutex serializing git worktree admin (add/remove). Concurrent `git worktree add`/
// `remove` race on `.git/worktrees` bookkeeping (finding #5); the orchestrator wraps each child's
// gitMaterialize/gitCleanup in this so the fan-out's worktree churn can't corrupt the admin dir. The
// lifecycle is ms vs minutes-of-child-run, so serializing it costs ~nothing. The chain advances on SETTLE
// (success OR failure) so one failing critical section never wedges the queue. Returns fn's result.
let worktreeLockChain = Promise.resolve()
export function withWorktreeLock(fn) {
  const result = worktreeLockChain.then(() => fn())
  worktreeLockChain = result.then(() => {}, () => {})
  return result
}

// === the parallel round (convergeRoundParallel) ===

// Race a child producer against a hard timeout. NOTE (finding #10): this layer is DORMANT under today's
// blocking-spawnSync editor — the setTimeout can't fire while a sibling child's spawnSync holds the event loop,
// and converge-cli does not wire `killChild` (so onTimeout no-ops). It is the harness for a FUTURE async
// (non-blocking) editor; today the real per-child cap is spawnSync's own timeout+SIGKILL (see makeClaudeAct).
// When the editor becomes async: allSettled alone awaits a HUNG child forever and a hung claude -p keeps
// spending, so on timeout we fire onTimeout (the detached-pgid SIGKILL hook) and drop the child this round.
// The producer NEVER rejects (it catches internally), so the rejection arm is defensive only.
// Returns { timedOut:true } | { timedOut:false, value }.
function raceChild(producer, timeoutMs, onTimeout) {
  let timer
  const timeout = new Promise((res) => {
    timer = setTimeout(() => { try { onTimeout?.() } catch { /* kill is best-effort */ } res({ timedOut: true }) }, timeoutMs)
  })
  const settled = producer.then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, value: { childHead: null, err: error } }),
  )
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

// One PURE-producer child: materialize a private worktree off last-good (under the worktree mutex), run the
// injected editor, and capture childHead as a STRING before cleanup (the merge reads it from the object store,
// so the worktree is freed immediately). Touches ONLY its own worktree HEAD — never a shared ref (the
// single-writer invariant). NEVER rejects: any failure is returned as { err } so the partition can classify it.
async function childProducer(obj, state, cfg, scopeDir, globalRO, lastGood, perChildSlice, deps) {
  const runChild = deps.runChild
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  let wt = null
  let spentUsd = 0
  let spentTokens = 0
  let childHead = null
  let err = null
  try {
    wt = await withWorktreeLock(() => materialize(scopeDir, lastGood))
    const childCfg = buildObjectiveCfg(obj, state, cfg, wt, globalRO, perChildSlice)
    const cs = await runChild(childCfg)
    spentUsd = cs?.state?.spent_usd ?? cs?.spent_usd ?? 0
    spentTokens = cs?.state?.spent_tokens ?? cs?.spent_tokens ?? 0
    childHead = gitHead(wt) // STRING, before cleanup
  } catch (e) {
    err = e
  } finally {
    if (wt) await withWorktreeLock(() => cleanup(scopeDir, wt)).catch(() => {})
  }
  return { childHead, spentUsd, spentTokens, err }
}

// The sequential gate path (single-sourced): a parallel-disabled run, a one-round fallback pin, or a width-1
// reservation all run ONE objective via the verbatim runOneObjective. Mirrors convergeLoop's body exactly
// (budget guard + pickNextObjective + attempts bump) so a parallel run can never be LESS-gated than sequential.
async function runOneFallback(state, cfg, scopeDir, globalRO, deps) {
  if (!canAffordObjective(state)) return { status: 'capped', reason: 'global budget cannot fund another objective pass' }
  const obj = pickNextObjective(state)
  if (!obj) return { status: 'capped', reason: 'no further objective can be attempted (unmet objectives exhausted their retries)' }
  obj.attempts = (obj.attempts ?? 0) + 1
  return runOneObjective(state, cfg, scopeDir, globalRO, obj, deps)
}

// runBatchRound: the batch round. Reserve → write the inflight SET BEFORE spawning → fan out PURE
// producers (each timeout-raced) → partition → single-commit N-way merge of the survivors → the IDENTICAL
// single-writer gate (reMeasureAll + batchRegressed) → accept (advance) OR whole-batch rollback + quarantine +
// sequential-fallback pin + consecutive→parallel_disabled. All ref/index ops run single-threaded post-barrier.
async function runBatchRound(state, cfg, scopeDir, globalRO, batch, reservedTokens, deps) {
  const log = deps.log ?? (() => {})
  const reMeasure = deps.reMeasure ?? reMeasureAll
  const timeoutMs = cfg.childTimeoutMs ?? CHILD_TIMEOUT_MS

  state.cycle += 1
  state.global_pass += batch.length // each launched child is one objective-pass (bounds the global cap)
  const round = state.cycle
  const lastGood = state.last_good_sha

  // WRITE-INTENT-BEFORE-ACT (finding #9): persist the inflight SET + the reservation BEFORE spawning any child,
  // so a crash mid-spawn is recoverable (resume cleans the recorded tmp dirs + charges the reserved tokens).
  state.reserved_tokens = (state.reserved_tokens ?? 0) + reservedTokens
  state.inflight = batch.map((o) => ({
    objectiveId: o.id,
    childTmpDir: join(cfg.convergeDir, 'children', `${o.id}-${round}`),
    reservedTokens: (o.cap ?? 4) * ONE_PASS_TOKENS,
  }))
  saveConvergeState(cfg.convergeDir, state)

  // FAN-OUT: children are pure producers; each races a hard timeout. Worktree materialize/cleanup is serialized
  // by withWorktreeLock (inside childProducer). NOTE: the runChild edits run SERIALLY today, not concurrently —
  // the editor is a blocking spawnSync, so each child's edit holds the event loop until it returns (finding #9).
  // The value of this round is the single batched gate re-measure for N objectives, not wall-clock speedup.
  const usdSlice = objectiveBudgetSlice(state).usd
  const settled = await Promise.allSettled(batch.map((obj) => {
    const perChildSlice = { tokens: (obj.cap ?? 4) * ONE_PASS_TOKENS, usd: usdSlice }
    return raceChild(childProducer(obj, state, cfg, scopeDir, globalRO, lastGood, perChildSlice, deps), timeoutMs, () => deps.killChild?.(obj.id))
  }))
  try { git(scopeDir, ['worktree', 'prune']) } catch { /* reclaim any killed-mid-add admin entry */ }

  // PARTITION + ACCOUNTING (findings #8/#11): charge spend for ALL (tokens burn regardless of accept/rollback).
  // A child that RAN bumps attempts; a crash/timeout bumps the separate `flakes` counter (NOT attempts) and is
  // charged its reserved share (bias up — a hung claude -p burned tokens we cannot read). flake_cap → skip.
  const survivors = []
  const failedIds = []
  batch.forEach((obj, i) => {
    const r = settled[i].status === 'fulfilled' ? settled[i].value : { timedOut: false, value: { childHead: null, err: settled[i].reason } }
    const p = r.value
    if (r.timedOut === false && p && p.childHead && !p.err) {
      obj.attempts = (obj.attempts ?? 0) + 1
      chargeSpend(state, obj, p.spentUsd, p.spentTokens)
      survivors.push({ obj, childHead: p.childHead })
    } else {
      obj.flakes = (obj.flakes ?? 0) + 1
      chargeSpend(state, obj, 0, (obj.cap ?? 4) * ONE_PASS_TOKENS) // bias up the unreadable burn
      // skip after flakeCap flakes are TOLERATED (the flakeCap+1-th trips it) — same `>` ceiling convention as
      // bumpRetryOrSkip's retries>objective_retries, so flake and retry exhaustion read consistently.
      if (obj.flakes > (cfg.flakeCap ?? 3)) { obj.status = 'skipped'; obj.skip_reason = 'persistent child crash' }
      failedIds.push(obj.id)
    }
  })

  // SINGLE-COMMIT N-WAY MERGE of the survivors (post-barrier, single-threaded — all ref/index ops here).
  const merged = squashIntegrateBatch(scopeDir, lastGood, survivors, globalRO, `batch-r${round}`)
  for (const c of merged.perChild) {
    if (!c.integrated.length) bumpRetryOrSkip(state, state.objectives.find((o) => o.id === c.objectiveId)) // a no-op survivor: genuine non-progress
  }

  const objectiveIds = batch.map((o) => o.id)
  const survivorIds = survivors.map((s) => s.obj.id)
  const tail = (verdict, record) => {
    state.rounds = [...state.rounds, record]
    state.reserved_tokens = Math.max(0, (state.reserved_tokens ?? 0) - reservedTokens) // release the reservation
    state.inflight = null
    pushBinding(state)
    saveConvergeState(cfg.convergeDir, state)
    return verdict
  }

  if (!merged.advanced) {
    // every survivor was a no-op (or none ran) — nothing to gate, no advance, no rollback.
    log({ cycle: round, batch: survivorIds, status: 'no-op', reason: 'no in-scope change' })
    return tail(globalVerdict(state), { kind: 'batch', round, objectiveIds, pre_sha: lastGood, merged_sha: null, accepted: false, reason: 'no in-scope change', survivors: survivorIds, failed: failedIds })
  }

  const mergedSha = merged.sha
  git(scopeDir, ['branch', '-f', CANDIDATE_REF, mergedSha]) // pin against gc while re-measuring (single-writer)
  const pre = state.objectives.map((o) => ({ ...o }))
  const rm = reMeasure(scopeDir, mergedSha, state.objectives, state.floor)
  const regressed = batchRegressed(pre, rm, state.min_delta)

  if (regressed) {
    rollbackToLastGood(scopeDir, lastGood)
    delRef(scopeDir, CANDIDATE_REF)
    // Only a genuine COMBINATION (>=2 survivors) regressing is evidence that BATCHING is the problem. A lone
    // survivor (its batch-mate crashed/timed out) that regresses is a per-objective failure — its solo edit was
    // bad, exactly as it would be in sequential mode — so it gets the sequential fallback's retry/skip, and must
    // NOT (a) quarantine a singleton (pickBatch would then bar that healthy objective from every future batch),
    // NOR (b) count toward parallel_disabled (a solo-edit fault should not disable batching). So the quarantine,
    // the consecutive-regression counter, and the parallel-disable trip all gate on the combination case.
    if (survivorIds.length >= 2) {
      state.quarantined_batches = [...(state.quarantined_batches ?? []), survivorIds]
      state.consecutive_batch_regressions = (state.consecutive_batch_regressions ?? 0) + 1
      if (state.consecutive_batch_regressions >= (cfg.maxBatchRegressions ?? 2)) state.parallel_disabled = true
    }
    state.sequential_fallback_round = state.cycle // pin the NEXT round sequential (the fallback) either way
    log({ cycle: round, batch: survivorIds, status: 'rolled-back', reason: rm.blocked ? 'floor failed' : 'cross-file batch regression' })
    return tail(globalVerdict(state), { kind: 'batch', round, objectiveIds, pre_sha: lastGood, merged_sha: mergedSha, accepted: false, rolledBack: true, veto_cause: rm.blocked ? 'floor' : 'cross-file-batch', survivors: survivorIds, failed: failedIds, floor_score: rm.floor.score })
  }

  state.last_good_sha = advanceLastGood(scopeDir, mergedSha)
  delRef(scopeDir, CANDIDATE_REF)
  applyFloor(state, rm.floor)
  applyVector(state, rm.vector, state.last_good_sha)
  state.consecutive_batch_regressions = 0
  log({ cycle: round, batch: survivorIds, status: 'integrated', reason: 'merged candidate gated clean' })
  return tail(globalVerdict(state), { kind: 'batch', round, objectiveIds, pre_sha: lastGood, merged_sha: mergedSha, accepted: true, survivors: survivorIds, failed: failedIds, floor_score: rm.floor.score })
}

// convergeRoundParallel: one round of the parallel driver. A parallel-disabled run or a pinned fallback round
// runs ONE objective sequentially; otherwise reserve the budget-bounded batch (affordBatch) — K=0 caps, K=1
// degenerates to the sequential gate (no batch apparatus for width 1), K>=2 runs the batched fan-out round.
export async function convergeRoundParallel(state, cfg, scopeDir, globalRO, deps = {}) {
  const maxParallel = Math.max(1, cfg.maxParallel ?? 2)

  const pinned = state.sequential_fallback_round != null && state.sequential_fallback_round === state.cycle
  if (state.parallel_disabled || pinned) {
    if (pinned) state.sequential_fallback_round = null
    return runOneFallback(state, cfg, scopeDir, globalRO, deps)
  }

  if (pickBatch(state, maxParallel).length === 0) {
    return { status: 'capped', reason: 'no further objective can be attempted (unmet objectives exhausted their retries)' }
  }
  const { batch, reservedTokens } = affordBatch(state, maxParallel)
  if (batch.length === 0) return { status: 'capped', reason: 'global budget cannot fund another objective batch' }
  if (batch.length === 1) return runOneFallback(state, cfg, scopeDir, globalRO, deps)

  return runBatchRound(state, cfg, scopeDir, globalRO, batch, reservedTokens, deps)
}

// The parallel driver loop — mirrors convergeLoop EXACTLY (the same budget guard, the same done-edge stability,
// the same finalize) but drives convergeRoundParallel instead of a single runOneObjective. The done verdict is
// byte-identical to sequential (same globalVerdict + same stabilityHolds), so --parallel changes throughput,
// never the gate.
async function convergeLoopParallel(state, cfg, scopeDir, globalRO, deps = {}) {
  const log = deps.log ?? (() => {})
  const reMeasure = deps.reMeasure ?? reMeasureAll

  let v = globalVerdict(state)
  log({ cycle: state.cycle, status: v.status, reason: v.reason })

  while (v.status === 'running') {
    const over = globalBudgetExhausted(state)
    if (over) { v = { status: 'capped', reason: over }; break }
    v = await convergeRoundParallel(state, cfg, scopeDir, globalRO, deps)
  }

  if (v.status === 'done' && (state.global_stability_runs ?? 1) > 1) {
    if (!stabilityHolds(scopeDir, state, reMeasure)) {
      v = { status: 'capped', reason: 'global stability re-measure unstable — the win did not reproduce over the done-edge re-measure' }
    }
  }

  state.global_status = v.status
  state.global_reason = v.reason
  saveConvergeState(cfg.convergeDir, state)
  log({ cycle: state.cycle, status: v.status, reason: v.reason })
  return { state, verdict: v }
}

// runConvergeParallel: a FRESH parallel convergence run. Reuses runConverge's IDENTICAL baseline setup
// (setupConvergeRun) then drives parallel rounds. Same code-owned gate, same honesty boundary; only the
// candidate-producer is fanned out.
export async function runConvergeParallel(cfg, manifest, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  if (typeof deps.runChild !== 'function') throw new Error('runConvergeParallel requires deps.runChild (the per-objective loop)')
  const { state, globalRO, blockedVerdict } = setupConvergeRun(cfg, manifest, scopeDir, deps)
  if (blockedVerdict) return { state, verdict: blockedVerdict }
  return convergeLoopParallel(state, cfg, scopeDir, globalRO, deps)
}

// Resume a crashed/paused PARALLEL run. Reuses the IDENTICAL crash-recovery recipe (prepareResumeState:
// hard-reset to last-good, reclaim the inflight SET's worktrees + tmp dirs, bias-up charge crashed children's
// reserved tokens, re-derive met, re-check budget) then continues in PARALLEL. last_good_sha advances ONLY on
// a fully-gated merged accept, so the hard-reset can never lose a gated win.
export async function prepareGlobalResumeParallel(cfg, deps = {}) {
  const scopeDir = resolve(cfg.scope)
  if (typeof deps.runChild !== 'function') throw new Error('prepareGlobalResumeParallel requires deps.runChild')
  const { state, globalRO, blockedVerdict } = prepareResumeState(cfg, scopeDir, deps)
  if (blockedVerdict) return { state, verdict: blockedVerdict }
  return convergeLoopParallel(state, cfg, scopeDir, globalRO, deps)
}
