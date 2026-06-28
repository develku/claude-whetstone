---
title: Track B — Concurrent Fan-out Under the Durable Code-Owned Gate (design spec)
date: 2026-06-28
status: design — awaiting operator review before implementation
provenance:
  design_workflow: wf_5af4e8bc-a44 (6 lenses + 3 adversarial refuters incl. empirical git stress-tests; synthesis agent degraded → hardened by the driver with full context)
  cross_model_dca: SKIPPED — codex timed out twice (killed, then 300s with zero completed events). Adversarial coverage rests on the 3 in-workflow refuters; the cross-MODEL blind-spot check is honestly absent and flagged here.
  spec_correction: the v0 "parallel-accept ⊆ sequential-accept" tightening clause was found redundant (a net-positive batch masking an isolated drop is NOT caught by drop-vs-last-good, and is an OPTIMALITY residual, not a safety hole — the merged candidate is non-regressing vs last-good, and a met objective below target IS caught by regressionCheck). batchRegressed is therefore the IDENTICAL regressionCheck on the merged candidate; the masking residual is disclosed (§10).
  builds_on: Track C (docs/superpowers/specs/2026-06-28-track-c-global-convergence-design.md), HEAD c16c5f8
---

# Track B — Concurrent Fan-out Under the Gate

## 1. Goal & scope

Track C raises N objectives **sequentially** under one code-owned global gate. Track B adds **concurrency**: run a *batch* of objectives in **parallel**, merge their edits into ONE candidate, then call the **identical** gate (`reMeasureAll` → `globalVerdict`). The sequential path stays the **default**; `--parallel` selects concurrency.

Per the competitive report §10.4: this is the **minimum portable control plane** — the differentiated asset is *fan-out UNDER a durable code-owned gate*, NOT fan-out itself (undifferentiated plumbing). A Workflow-backed `act` is an optional attended drop-in, **deferred**. The gate code path MUST be identical regardless of how the candidate was produced.

**The key simplifier:** Track C's `convergeEditScopeOverlap` refusal makes editScopes **pairwise-disjoint**, so any subset of objectives touches non-overlapping files — an N-way merge is **collision-free at the git tree level** (no merge conflicts). The residual risk is *semantic* cross-file regression (A+B together break a third objective or the floor), which the existing `reMeasureAll` on the merged candidate catches.

**Operator decisions (fixed):** batch regression → **whole-batch rollback + sequential fallback**; partial child failure → **integrate the survivors**.

**Hard constraint:** the 7 invariant files (`loop.mjs`, `forge/{run,gate,store,prune,admit}.mjs`, `composite.mjs`) stay untouched. `converge*.mjs` are extendable, but the gate path is **single-sourced** (never forked).

## 2. Architecture

### 2.1 Prep refactor (a separate, power-reviewed commit BEFORE any parallel code)
Extract `convergeLoop`'s per-objective body (the tail from materialize → … → save) into an exported **`runOneObjective(state, cfg, scopeDir, globalRO, obj, deps)`** in `converge.mjs`. `convergeLoop`'s loop body shrinks to `obj = pickNextObjective(state); await runOneObjective(...)`. This makes the gate path **single-sourced**: both the sequential loop and Track B's sequential fallback call the *same* function. Promote `ONE_PASS_TOKENS` and `chargeSpend` to exports (non-behavioral additive change). **The 691 Track C tests must stay byte-green after this refactor** — it is the gate-identity guarantee made structural. Ships and is power-reviewed on its own before Track B begins.

### 2.2 New module
| Module | Purpose | Key exports |
|---|---|---|
| `src/converge-parallel.mjs` | The parallel driver. `runConvergeParallel` (fresh) reuses `runConverge`'s setup then drives parallel rounds; `convergeRoundParallel` is one round; `pickBatch`, `squashIntegrateBatch`, `affordBatch`, `batchRegressed`, the worktree mutex, and the resume cleanup live here. Imports `reMeasureAll`/`globalVerdict`/`globalRegressed`/`runOneObjective`/`advanceLastGood`/`rollbackToLastGood`/`CANDIDATE_REF`/`editScopeAllowed`/`chargeSpend`/`ONE_PASS_TOKENS` **verbatim**. | `runConvergeParallel`, `convergeRoundParallel`, `pickBatch`, `squashIntegrateBatch`, `affordBatch`, `batchRegressed`, `withWorktreeLock` |

`converge-state.mjs` gains **additive** fields only (no field removed/repurposed; the 691 tests' on-disk format is unchanged for sequential runs).

## 3. The parallel round (`convergeRoundParallel`)

1. **Top guards (reuse):** `globalBudgetExhausted(state)` → `capped`. If `parallel_disabled` or `sequential_fallback_round === cycle` → run ONE sequential round via `runOneObjective` (the fallback / one-round pin), then return.
2. **`pickBatch(state, maxParallel)`** — the K least-attempted unmet objectives, sorted by `pickNextObjective`'s exact comparator (attempts asc → priority desc → manifest order), excluding any objective that would form a **superset of a `quarantined_batches` entry** with another batch member. Disjoint by the global invariant; assert it.
3. **`affordBatch` (budget reservation — DCA-grade, finding #2/#5):** greedily admit batch members while `Σ(child.cap × ONE_PASS_TOKENS) ≤ remaining_pool`. The reservation bounds each child's **whole-child** worst-case spend (`cap` passes × per-pass), NOT one pass. `K=0` (can't fund even one child's cap) → `{status:'capped', reason:'global budget cannot fund another objective batch'}`. `K=1` → fall through to **sequential** `runOneObjective` (no parallel apparatus for width 1; fewer paths, already gate-identical). Persist `state.reserved_tokens`/`reserved_usd`; `globalBudgetExhausted` reads `(spent + reserved)` against the cap so a second round can't double-commit headroom. Each admitted child gets a **hard** `budgetTokens = its reserved share` (`buildObjectiveCfg`).
4. **Write-intent-before-act (finding #9):** write the FULL `inflight` SET (`[{objectiveId, childTmpDir, reservedTokens, reservedUsd}]`, deterministic paths) + `reserved_*` to `converge-state.json` (atomic tmp+rename) **BEFORE spawning any child** — so a crash mid-spawn is recoverable.
5. **Concurrent execution:** `Promise.allSettled(batch.map(child → Promise.race([childLoop, timeout(CHILD_TIMEOUT_MS)])))`. Each child: its OWN `gitMaterialize` worktree off `last_good_sha` (under the **worktree mutex**, §5), its own detached process group; on timeout, **SIGKILL the pgid** (reap the wedged nested `claude -p`, else it keeps spending). Children are **pure producers** — they touch ONLY their own worktree HEAD, never a shared ref. Capture `childHead = gitHead(wt)` as a STRING before any cleanup.
6. **Partition + accounting (finding #8/#11):** survivors = fulfilled + produced an in-scope change; failures = rejected/timeout; no-op = fulfilled but zero in-scope change. **Charge spend for all** (tokens burned regardless of accept/rollback). `attempts++` ONLY for children that actually ran; a crash increments a separate **`flakes`** counter (bounded by `flake_cap` default 3 → skip with reason `persistent child crash`, distinct from `retries→skip`). A no-op child gets `bumpRetryOrSkip` (genuine non-progress). Refund `(reserved − actual)` of every child to the pool.
7. **Single-commit N-way merge (`squashIntegrateBatch`, finding #2/#10):** materialize ONE throwaway worktree off `last_good_sha`; for EACH survivor, iterate the EXISTING `squashIntegrate` per-child apply (`editScopeAllowed` filter + `reverted` accounting) into that one worktree; **ASSERT the survivors' allowed path-sets are pairwise-disjoint** (throw on intersection — defense-in-depth vs a manifest-validation regression); ONE `git commit` ⇒ `mergedSha` whose **parent === `last_good_sha`** (never chain per-child commits). Pin once: `git branch -f CANDIDATE_REF mergedSha`. All ref/index ops here are **single-threaded, post-barrier**.
8. **The gate (IDENTICAL + the tightening, finding #1):** `rm = reMeasureAll(scopeDir, mergedSha, state.objectives, state.floor)` then `regressed = batchRegressed(pre, rm, state.min_delta)` where **`batchRegressed` = `globalRegressed(...)` OR any objective whose `last_good_score − candidate_score > min_delta` (even if net-positive)**. The extra clause enforces **parallel-accept ⊆ sequential-accept**: a batch that nets positive but internally drops a met/in-progress objective is rejected (a sequential run would have rolled the offender back). The ONLY function that returns `done` is the verbatim `globalVerdict` on `mergedSha`; children's own verdicts are advisory for retry/skip only.
9. **Accept** → `advanceLastGood(scopeDir, mergedSha)` (single-threaded), `delRef(CANDIDATE_REF)`, `applyFloor`/`applyVector`, append a `{kind:'batch', objectiveIds, pre_sha, merged_sha, accepted:true, survivors, failed, …}` round, `consecutive_batch_regressions = 0`, `pushBinding`, clear `inflight`, save. **Reject** → `rollbackToLastGood(scopeDir, last_good_sha)`, `delRef(CANDIDATE_REF)`, record `quarantined_batches += [survivorIds]` + a `{…accepted:false, rolledBack:true, veto_cause:'cross-file-batch', …}` round, `sequential_fallback_round = cycle + 1`, `consecutive_batch_regressions++`; if `≥ cfg.maxBatchRegressions` (default 2) set `parallel_disabled = true`.
10. **Sequential fallback (finding #7):** the next round (pinned sequential) runs each rolled-back objective via `runOneObjective`, gate-isolated. If a fallback objective STILL regresses in isolation, the existing per-objective rollback handles it (genuine bad edit). The combination-only case (each passes alone, together regress a third objective) is bounded by: `quarantined_batches` prevents re-forming the set; `consecutive_batch_regressions → parallel_disabled` pins the run sequential after 2 strikes; and the existing plateau/`objective_retries→skip` terminate it. **Termination is guaranteed** (retries bounded, quarantine monotonic, parallel disable terminal).

## 4. Gate-identity guarantee (the load-bearing invariant)

`converge-parallel.mjs` **imports and calls** `reMeasureAll`/`globalVerdict`/`globalRegressed`/`runOneObjective` — never redefines them (grep-verifiable: "same import, no fork"). The merged candidate is just another `candidateSha`; the gate is SHA-agnostic. The ONE addition is `batchRegressed`'s extra clause, which only makes parallel **stricter** (`parallel-accept ⊆ sequential-accept`). `reMeasureAll`'s internal sequential per-objective worktree loop is **left untouched** (do not parallelize it as part of B — the floor-first short-circuit and the literal-code-reuse guarantee depend on it). A test feeds the SAME `mergedSha` through both the parallel path and a direct sequential `reMeasureAll`/`globalVerdict` and asserts a byte-identical verdict.

## 5. Concurrency safety (empirically grounded)

- **Object store: a non-issue** (refuter proved 16-way concurrent commits from separate worktrees → fsck-clean; loose objects are content-addressed + atomic-renamed). **Do NOT add a global object lock** — it would serialize the fan-out that is the point.
- **Refs: single-writer (CRITICAL, finding #3).** `git branch -f <shared> <sha>` concurrent → one writer FAILS `rc=128 cannot lock ref` (the `git()` helper THROWS → unhandled crash). So ALL shared-ref mutations (`CANDIDATE_REF`, `LAST_GOOD_REF`, the working branch) happen ONLY on the orchestrator thread, strictly AFTER `Promise.allSettled` resolves. Children write only their own detached worktree HEAD. Only ONE merged candidate per round ⇒ no `CANDIDATE_REF` race.
- **Main index: single-writer (finding #4).** Two writers on `.git/index` → `rc=128 index.lock exists`. All main-checkout index ops (`reset --hard`, `clean -fdq`, the merge commit) run single-threaded post-barrier; the merge is built in a throwaway worktree (its own index), never on `scopeDir`.
- **Worktree-admin mutex (finding #5):** wrap `gitMaterialize`/`gitCleanup` in an in-process async mutex (`withWorktreeLock`) — concurrent `git worktree add`/`remove` race on `.git/worktrees` admin. The lifecycle is ms vs minutes-of-child-run, so serializing it costs ~nothing. Run `git worktree prune` after each batch to reclaim admin entries from killed-mid-add worktrees.
- **Hung child (finding #6):** `Promise.race([childLoop, timeout])` — `allSettled` alone awaits a *hung* child forever.
- **Per-run advisory lock:** `<convergeDir>/converge.lock` via `O_EXCL` so two `whetstone-converge --parallel` invocations on the same scope refuse rather than double-write.

## 6. Budget (the §6-a overshoot, worse under parallelism)

Reserve **`Σ(child.cap × ONE_PASS_TOKENS)`** for the admitted batch BEFORE launch (a child runs up to `cap` passes with POST-pass checks, so reserving one pass per child under-reserves up to `cap×`). Greedy admission shrinks K when the pool is tight (down to 1 = sequential). `globalBudgetExhausted` reads `(spent + reserved)`. Refund unspent on settle. **Honest worst-case overshoot = K × ONE_PASS_TOKENS** (each launched child can overshoot its own ceiling by one final post-pass pass) — stated verbatim, per §6-a. USD-only dial is coarser (no fixed per-pass constant) → fall back to `min(maxParallel, unmet)` with per-child `remUsd/k` slices + the post-pass USD backstop; recommend the token dial for tight parallel budgeting (disclosed).

## 7. State & resume

- `inflight`: singleton → **SET** (additive). A `converge-state.mjs` `inflightList(state)` normalizer tolerates object | array | null (so a Track-C singleton run and a Track-B array run both resume). Sequential `converge.mjs` write sites are **unchanged** (keep writing singletons; the reader is shape-tolerant).
- `rounds`: heterogeneous (a `kind:'batch'` record carries `objectiveIds/merged_sha/survivors/failed/veto_cause`; the sequential fallback appends normal single-objective records → a readable bisect trail).
- New additive fields: `reserved_tokens/reserved_usd`, `quarantined_batches`, `sequential_fallback_round`, `consecutive_batch_regressions`, `parallel_disabled`, per-objective `flakes`.
- **Resume (the existing recipe extended):** `prepareGlobalResume` hard-resets to `last_good_sha` unconditionally and re-derives `met` by re-measuring the SHA (recorded vector is evidence, not authority) — **batch-safe as-is** because `last_good_sha` advances ONLY on a fully-gated merged accept (never per-child mid-batch). Track B adds: `git worktree prune` + clean each recorded `inflight[].childTmpDir` + **conservatively charge each crashed child's `reserved` tokens to `spent` (bias UP)** so resume never under-counts budget → re-check `globalBudgetExhausted` (refuse to resume a budget-exhausted run). Then clear `inflight` and re-queue.

## 8. CLI

`--parallel` (default off; sequential stays the untouched default) + `--max-parallel N` (default **2** when `--parallel` is set, so the flag is meaningful alone). `--max-batch-regressions` (default 2), `--flake-cap` (default 3). The gate is identical across both backends.

## 9. Deferred (explicitly out of the B MVP)

- **Attribution / bisect** of a regressing batch (consumes `quarantined_batches` + `veto_cause` + the merged-history). B's MVP is whole-batch rollback + sequential fallback.
- **Workflow-backed `act`** drop-in (the attended accelerator) — optional, later.
- **Parallelizing `reMeasureAll`'s** internal worktree loop (keep verbatim for literal gate-identity).
- **Precise USD-dial affordability** (operator-supplied `--usd-per-pass`).
- **Per-objective-pair quarantine memory** richer than the superset check.

## 10. Disclosure (honesty boundary, unchanged + extended)

The done verdict and `objectives_sufficiency:'unproven'` are **byte-identical** to sequential (same `globalVerdict`). New disclosure: the merge's residual semantic risk — an objective whose editScope **deletes/renames a symbol** a disjoint sibling imports — is caught **only if the floor exercises it** (so the floor SHOULD compile/import the whole repo, e.g. `npm run build && npm test`). Disjoint editScopes give a collision-free *tree*, not a regression-free *semantics*.

## 11. Test plan (TDD, RED-first; all $0 except the marked paid)

**TIER-1 PURE ($0):**
1. `pickBatch` returns the K least-attempted unmet (same comparator as `pickNextObjective`); excludes a superset of a quarantined set.
2. `affordBatch` reserves `Σ(cap×ONE_PASS)`, greedily shrinks K, returns the admitted set; `K=0` → capped; `K=1` → sequential signal.
3. `affordBatch` reservation never exceeds the pool (property over pool/maxParallel/unmet combos); `globalBudgetExhausted` reads `(spent+reserved)`.
4. `batchRegressed` rejects a net-positive batch that internally drops a met objective > min_delta (the **parallel-accept ⊆ sequential-accept** invariant); accepts a clean all-improve batch.
5. attempts/flakes separation: a crashed child does NOT bump `attempts`, bumps `flakes`; a no-op child bumps `retries`; a sibling is not deprioritized by a flake.
6. `inflightList` normalizer: object | array | null → array.

**TIER-2 REAL-GIT ($0, stub children):**
7. `squashIntegrateBatch` over 2 disjoint-scope children → ONE commit, `parent === last_good_sha`, tree carries both files, no conflict.
8. `squashIntegrateBatch` THROWS on overlapping survivor allowed-paths; carries only editScope-allowed paths (out-of-scope reverted per child); a no-op child is dropped + `bumpRetryOrSkip`.
9. **GATE-IDENTITY:** the same `mergedSha` → byte-identical `{floor, vector, verdict}` via the parallel path and a direct sequential `reMeasureAll`/`globalVerdict`.
10. WHOLE-BATCH ROLLBACK: a stub-regressing merged candidate → `rollbackToLastGood`, `last_good_sha` unchanged, `CANDIDATE_REF` deleted, `sequential_fallback_round` set, `consecutive_batch_regressions++`, quarantine + batch-rollback round recorded.
11. SEQUENTIAL FALLBACK reuses `runOneObjective` (spy: invoked once per batch objective, not a merge).
12. COMBINATION-ONLY regression TERMINATES: A,B pass alone but A+B regress a third objective → run reaches `capped`/`skipped` (never loops past `global_cap` doing zero net work); `parallel_disabled` flips after `maxBatchRegressions`.
13. SURVIVOR integration: a 3-child batch with one rejected child → merge over the 2 survivors; the failed objective recorded `failed`, `flakes++`, re-queued.
14. PARTITION accounting: whole-batch rollback STILL charges every child's spend; reserved-but-unspent refunded.
15. Single-writer / mutex stress: 4 concurrent `withWorktreeLock(gitMaterialize+gitCleanup)` pairs over many iterations → no worktree-index corruption; a child's in-worktree `reset --hard` leaves `LAST_GOOD_REF` unmoved.
16. Hung-child timeout: a child that never settles → `Promise.race` fires, the objective is dropped this round, the batch proceeds.
17. CRASH-RESUME: `inflight` as a SET + recorded `childTmpDir` → `prepareGlobalResume` hard-resets to `last_good_sha`, `git worktree prune`s, cleans the dirs, charges crashed children's reserved tokens (bias up), re-derives met, resumes; a partially-merged HEAD is discarded.
18. Resume budget refusal: biased-up spend > pool → resume refuses (reuses `globalBudgetExhausted`).
19. Prep-refactor regression: a static assertion that the 691 Track C tests pass byte-green after `runOneObjective` extraction (run the suite); the invariant tripwire still passes.

**PAID (separate, after the $0 suite is green):**
20. real-model 2-objective disjoint-editScope concurrent run (both genuinely succeed) → the happy-path speedup proof: the merged candidate passes the gate ONCE, both objectives reach met in one round; `$0 --stub` arm green first.

## 12. Implementation increments (for the plan / loop)

1. **PREP** — extract `runOneObjective` + export `ONE_PASS_TOKENS`/`chargeSpend`; 691 tests byte-green + power-review. (Its own commit.)
2. **`pickBatch` + `affordBatch` + `batchRegressed`** (pure) + Tier-1 tests.
3. **`squashIntegrateBatch` + `withWorktreeLock`** + Tier-2 real-git tests.
4. **`convergeRoundParallel` + `runConvergeParallel`** (the round: reserve → fan-out → merge → gate → accept/rollback/fallback/quarantine) + Tier-2 tests.
5. **Resume + state deltas** (`inflightList`, the SET, the cleanup + bias-up charge) + Tier-2 tests.
6. **CLI wiring** (`--parallel`/`--max-parallel`) + smoke.
7. **(paid)** elicitation/speedup harness — separate.

Each increment: TDD → power-review → full suite green + 7 invariant files untouched → conventional commit+push → memory. The PREP refactor is power-reviewed before any parallel code.
