// Track B: CONCURRENT fan-out under the IDENTICAL gate. Runs a BATCH of disjoint-editScope objectives at
// once, merges into ONE candidate, and calls the verbatim reMeasureAll/globalVerdict — sequential stays the
// default, --parallel selects it, the gate path is never forked. This slice is the PURE batch-selection +
// pre-launch budget reservation + the (literally-reused) regression predicate, plus the single-commit N-way
// merge (squashIntegrateBatch) and the worktree-admin mutex (withWorktreeLock); the orchestration round lands
// in inc 4. Imports the squash apply primitives + ONE_PASS_TOKENS + regressionCheck from converge.mjs (no fork).
import { execFileSync } from 'node:child_process'
import { ONE_PASS_TOKENS, regressionCheck, childAllowedChanges, applyAllowedChanges, editScopeAllowed } from './converge.mjs'
import { gitMaterialize, gitCleanup, gitHead, isSha } from './git-snapshot.mjs'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

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

// Greedy PRE-LAUNCH budget reservation (report §6-a — worse under parallelism: N children spend CONCURRENTLY,
// budgets are checked POST-pass). Admit batch members (in pickBatch order) while the running sum of each
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
