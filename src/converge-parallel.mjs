// Track B: CONCURRENT fan-out under the IDENTICAL gate. Runs a BATCH of disjoint-editScope objectives at
// once, merges into ONE candidate, and calls the verbatim reMeasureAll/globalVerdict — sequential stays the
// default, --parallel selects it, the gate path is never forked. This first slice is the PURE batch-selection
// + pre-launch budget reservation + the (literally-reused) regression predicate; the orchestration round
// lands in later increments. Imports ONE_PASS_TOKENS + regressionCheck from converge.mjs (no fork).
import { ONE_PASS_TOKENS, regressionCheck } from './converge.mjs'

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
