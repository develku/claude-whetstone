---
title: Track C — Repo-wide Global Convergence Gate (design spec)
date: 2026-06-28
status: design — awaiting operator review before implementation
provenance:
  design_workflow: wf_84554cdc-30b (6 lenses → synthesis → 3 adversarial refuters → harden)
  cross_model_dca: ~/.claude/dca/20260628T170039_whetstone-track-c-global-convergence-gate.md (codex gpt-5.5, thread 019f0d0b-…, REFINED-AND-PROCEED)
---

# Track C — Repo-wide Global Convergence Gate

## 1. Goal & scope

Whetstone today raises **one** artifact (or one `--scope` repo) under **one** scorer vs **one** numeric target; code (not the model) owns the stop. Track C generalizes the gate to a **whole repo with N objectives** under **one code-owned global gate**. The four deliverables (from the competitive report §5/§6.3/§10.3):

1. A repo-wide **multi-objective measured target** — N objectives, each `{goal, scorer, target}`, declared in an operator-authored JSON manifest.
2. A **global composite that mandates a deterministic floor** — the floor ("repo still builds/tests") is a hard veto with precedence above every objective; never a judge-only top gate.
3. A **global convergence stop** — "**all** declared objectives at target **AND** no cross-file regression **AND** stable".
4. The global gate must not be **fooled by per-objective gaming**. (Proving the objective *set* is *sufficient*/covers the repo goal is **Track A**, explicitly NOT C. C only guarantees the gate cannot be gamed, and it discloses — never hides — that it proves the manifest, not repo-goal sufficiency.)

**Out of scope (by track):** concurrency/fan-out → Track B; coverage/sufficiency heuristics + proactive planner → Track A. C is **sequential** and **reactive to an operator-declared manifest**.

**Hard constraint:** the 7 invariant files — `src/loop.mjs`, `src/forge/{run,gate,store,prune,admit}.mjs`, `scorers/composite.mjs` — must NOT be edited. C builds **around** them by composition, exactly as `--floor` wired the deterministic floor as a confirm without touching `loop.mjs`/`gate.mjs`.

## 2. Operator decisions (fixed this session)

- **Input:** a JSON **manifest** (`--objectives objectives.json`), git-trackable, resume-friendly, scales to N. (AskUserQuestion)
- **Regression guard:** **strict global re-measure** — after each objective's edits integrate as a commit, re-score ALL objectives + the floor against the pristine commit; roll back on any regression. Cost is wall-clock (deterministic scorers), not model spend. (AskUserQuestion)
- **MVP scope:** **Option B** — ship the structural core; defer the subtle anti-capture layers to a marked hardening pass — **as tightened by the cross-model DCA's 6 refinements** (§8 below). (DCA `20260628T170039`, codex REFINED-AND-PROCEED.)

## 3. Architecture — 4 new modules composing the substrate

| Module | Purpose | Key exports |
|---|---|---|
| `src/converge-gate.mjs` | PURE `globalVerdict(globalState)` — the repo-level gate. Imports `validScore` from `gate.mjs`; mirrors its precedence at the global level; **never edits** `gate.mjs`. $0-testable over stubbed vectors. | `globalVerdict`, `globalDone`, `globalRegressed`, `objectiveMet`, `globalPlateau` |
| `src/converge.mjs` | The orchestrator. Priority/round-robin over UNMET objectives → run each as a per-objective `runFromConfig(childCfg, scopeDeps(childCfg))` (the **unmodified** scope executor) in an **isolated worktree off last-good** → `squashIntegrate` → `reMeasureAll(candidateSha)` → `globalVerdict` → advance the durable last-good ref OR `gitRestore` rollback. | `runConverge`, `reMeasureAll`, `squashIntegrate`, `globalReadOnly`, `pickNextObjective`, `reserveObjectiveBudget` |
| `src/converge-state.mjs` | Durable global ledger `converge-state.json` (gitignored, OUTSIDE `--scope`). Atomic tmp+rename (mirrors `state.mjs saveState`; may import, never edit it). Resume reconstructs PURELY. | `loadConvergeState`, `saveConvergeState`, `prepareGlobalResume`, `initConvergeState` |
| `src/converge-cli.mjs` | Entry. Parses flags, loads + shape-validates the manifest, runs the refusal suite, calls `runConverge`, exits 0 iff `globalVerdict.status==='done'`. Mirrors `scope-cli`'s guard-suite-then-run shape. | `parseConvergeCli`, `loadManifest`, `validateManifest`, `CONVERGE_REFUSALS` |

The export boundary (`reMeasureAll` / `squashIntegrate` / `globalVerdict` / last-good-ref logic) is the seam **Track B reuses**: B replaces only the sequential candidate-producer (one squash → an N-way tree-merge), then calls the **identical** gate path. This is the report's "highest-risk integration seam" (§6-b) made B-ready now.

## 4. Manifest schema — `objectives.json`

Operator-authored, lives OUTSIDE `--scope` (so it is never in the editor's blast radius), loaded ONCE in memory.

```jsonc
{
  "goal": "raise the auth service to production quality",
  "floor": {
    "cmd": "npm run build && npm test",      // operator-provided; SUBGATE_UNSAFE denylist still applies
    "readOnly": ["package.json", "jest.config.js", "tsconfig.json"]  // the floor's measurement footprint — see §7
  },
  "global_budget_tokens": 4000000,            // OR global_budget_usd — required for N>=2 (refusal)
  "objective_cap": 6,                          // default per-objective hard_cap
  "objectives": [
    {
      "id": "auth-coverage",                  // unique
      "goal": "bring src/auth to 90% line coverage",
      "scorer": "node scorers/test-pass-rate.mjs --cmd 'npm run cov:auth'",  // operator-authored
      "target": 90,
      "editScope": "src/auth",                // MANDATORY (refusal). Pairwise-disjoint (refusal). Canonical repo-relative.
      "readOnly": ["test/auth"],              // this objective's own gate files
      "confirmScorer": "node scorers/llm-judge.mjs ...",  // MANDATORY iff judgeClass
      "judgeClass": false,                     // operator flag; ALSO auto-set if scorer/confirm resolves to llm-judge.mjs
      "cap": 4,                                // per-unit hard_cap override
      "priority": 1                            // optional ordering hint
    }
  ]
}
```

- Every `scorer`/`confirmScorer`/`floor.cmd` is an **operator literal**, never model-derived. `convergeUnsafeObjectiveScorer` reuses `isUnsafeScorer` + `SUBGATE_UNSAFE = {composite, floor}`.
- `objectives_sufficiency` is NOT a manifest field — it is a hard-coded `'unproven'` constant; `coverage_score` is reserved for Track A so the two never alias.

## 5. Global state — `converge-state.json`

OUTSIDE `--scope`, gitignored, atomic tmp+rename. Carries:

- `goal`, `objectives_path`, `scope` (abs), `objectives_source: 'operator-manifest'`, `objectives_sufficiency: 'unproven'` (hard constant, every exit), `coverage_score: null` (Track-A reserved).
- `last_good_ref: 'whetstone/converge-last-good'` (a DURABLE git branch — gc-safe, rev-parse-able on resume; a bare SHA would orphan when a child's `reset --hard` moves the shared branch) and `last_good_sha` (= `rev-parse(last_good_ref)`, `isSha`-guarded).
- `floor: { cmd, readOnly[], last_exit, last_score, last_replicas }` — scored ONCE per cycle, NOT an objective.
- `objectives: [{ id, goal, scorer, confirmScorer, editScope, readOnly[], target, judgeClass, met:<bool>, primaryScore, confirmScore, best_confirm, met_at_sha, pre_integration_score, child_loop_dir, status:'unmet'|'met'|'skipped', spent_usd, spent_tokens, lifetime_spent_usd, lifetime_spent_tokens, retries }]`.
- `global_budget_*`, `spent_*` (cumulative, summed UNCONDITIONALLY incl. rolled-back rounds — tokens burned regardless), `global_cap`, `global_pass`, `inflight:{objectiveId, child_loop_dir, worktree_path}|null`, `rounds:[…]` ledger, `global_status`, `global_reason`, `cycle`, timestamps.

Each child keeps its OWN `state.json` for intra-objective resume; converge-state owns only the INTER-objective ledger.

## 6. The global gate — `globalVerdict(globalState)`

Pure function; composes the shared invariant `validScore` (imported from `gate.mjs`), **never** edits `gate.mjs`. Precedence mirrors `loop.mjs` (`error > done > capped > plateau > running`) with the **floor folded ABOVE all**:

1. **FLOOR VETO** — `floor.last_score === 0` (after replica-gating, §7) → `{status:'blocked', reason:'deterministic floor failed (<cmd>); no objective verdict can stand'}` **before reading any objective** (mirrors `gradeFloor` short-circuit). This is the §6.3 mandate as precedence.
2. **ERROR** — any objective whose decision score fails `validScore` → `{status:'error'}`.
3. **MET(o)** `:=` `validScore(score) && score >= o.target`, where **score = `confirmScore` for a judge-class objective (held-out, never the gameable primary), else `primaryScore`** (a deterministic scorer is ground truth). This is the same `>=` comparison `gate.mjs` makes — NOT a wrapped `gateVerdict` call (wrapping would import plateau/capped/error tiers meaningless per-objective-within-a-global-cycle and would drop an at-target objective to ERROR on a transient read).
4. **DONE** iff **every** objective MET **AND** floor passed **AND** `stabilityHeld` (§ below) → `{status:'done', reason:'all N DECLARED objectives met (held-out confirms passed, floor held, no cross-file regression, stable over k) — proves the manifest, NOT repo-goal sufficiency'}`. **Never** `MIN(scores) >= someGlobalTarget` (per-objective targets differ; RED test: `[{confirm:80,target:80},{confirm:95,target:100}]` ⇒ running).
5. **CAPPED** if `global_pass >= global_cap` OR cumulative spend > pool OR (optional) wall-clock exceeded, and not all-done; the reason NAMES the offending lifetime-exhausted objective.
6. **PLATEAU** — MIN-binding (the worst unmet objective's score, runningMax over `global_plateau_window`, improvement < `global_min_progress`) — consistent with the weakest-dimension doctrine.
7. **RUNNING** otherwise.

Exit-code parity: keep `status:'done'` so `exit(status==='done'?0:1)` matches `driver`/`scope-cli`; the honesty lives in the *reason*, not a new status (avoids a tooling-contract fork). `composite.mjs` is reused for DISPLAY/next-pick only (write a manifest, spawn `node composite.mjs --scorers-file` like `composeConfirm`) — its MIN is NEVER consulted by `globalVerdict`.

**Stability ("stable", DCA refinement #6):** before declaring done, `runConverge` re-runs the FULL objective vector + floor at the same `candidateSha` **≥2×** (`--global-stability-runs`, default 2); if the vector is not reproducible (any reading flips a MET or the floor), done is withheld. This is the concrete definition of requirement (3)'s "stable" — a cheap (deterministic, no model spend) replacement for the deferred K-replay determinism classifier.

## 7. Strict global re-measure, regression guard, rollback

`reMeasureAll(scopeDir, candidateSha, objectives, floor)`:

- **Integration boundary (DCA refinement #5):** an objective's child runs in an ISOLATED `gitMaterialize` worktree off `last_good_ref`; `squashIntegrate` reduces the child's net tree diff to **exactly one commit** on last-good, so `candidateSha`'s **parent === `last_good_sha`** (assert it — stronger than `merge-base --is-ancestor`, which is true by construction anyway). A zero-tree-change child does NOT advance (mirrors `decompose`'s `gitTreeChanged` honesty). A child's internal `reset --hard` moves its detached-HEAD worktree, never the orchestrator branch.
- **Floor first (DCA #/(e)):** spawn `node scorers/floor.mjs --cmd <floor.cmd>` directly with `cwd = worktree-root`, grade via the exported `gradeFloor`. On a floor FAIL, **re-run once** (transient build/network/port flake immunity); roll back only on a REPRODUCED failure, but STILL compute the objective vector first so the round record names what regressed. The floor is NOT routed through `floorConfirmCmd` (that builds a confirm-shaped `--and`/`--output` command — the per-objective `--floor` path stays separate and unchanged).
- **Objectives:** each objective's scorer runs with `cwd = worktree-root` (committed-SHA discipline). For MET-entry, re-measure each judge-class objective's **held-out confirmScorer** at the SHA (the primary is the cheaper running/plateau signal only). Use a FRESH per-objective worktree (not one shared — project-test scorers write `__pycache__`/`.pytest_cache`/`node_modules/.cache` and collide on `.git/index.lock`).
- **Regression predicate (DCA refinement #1, tightened `(f)`):** `globalRegressed` is true iff — the floor failed (reproduced) **OR** **any** objective (MET or UNMET) whose score drops **more than `min_delta`** below its `pre_integration_score` **OR** any MET objective falling below its target. (The original "below target only" missed a met objective 100→91 at target 90 — a real regression.)
- **Rollback:** on regression, `gitRestore(scopeDir, last_good_sha)` rolls the WHOLE round back; the offending objective is bounded-retried (`--objective-retries`, default 1, regression critique fed as steering) then SKIPPED (skip-and-continue, never abort). `last_good_ref` advances ONLY on a full re-measure + floor pass.

## 8. Anti-capture (the DCA-tightened core)

The report's #1 risk (scorer capture) scaled N-fold. The MVP closes the dominant channels structurally and DISCLOSES the residual:

1. **editScope-positive commit enforcement (DCA refinement #4):** `editScope` is MANDATORY; an objective's child may only COMMIT changes WITHIN its `editScope` (a positive allowlist enforced at commit time — stronger than the existing read-only DENYLIST). The enforcer **canonical-normalizes** to repo-relative paths and judges the **actual committed diff** (renames, deletes, symlinks), using the `startsWith(base + sep)` boundary (NOT `startsWith(base)`) to kill the `src/a` vs `src/app` prefix trap (reuse `src/safe-rel.mjs`). Anything committed outside `editScope` is reverted before integration.
2. **editScope pairwise disjointness (DCA refinement #3 — NEW refusal):** `convergeEditScopeOverlap` refuses any two objectives whose canonical editScopes intersect (until a later `sharedSource` track). Without this, (1)'s "A cannot edit B's source" overclaims — two overlapping scopes let A edit a file B's scorer reads.
3. **Measurement-footprint completeness (DCA refinement #2 — the BIGGEST catch):** the floor and scorers measure whatever their config/fixtures/data say. If `floor.cmd` is `npm test` and `package.json` is editable inside an objective's `editScope`, the editor rewrites `npm test → echo ok`, the floor passes trivially, all scores hit target, and the gate declares **done while the real floor was evaded** — surviving every other control. Closure:
   - `convergeFloorFootprintReadOnly` — refuse to start if the floor's declared `floor.readOnly` footprint files are not in `globalReadOnly` (the operator MUST list the config files the floor cmd reads). No new `configFootprint` field — expressed via the floor's `readOnly`.
   - `globalReadOnly` = UNION of every objective's `readOnly[]` ∪ auto-unioned **scorer/confirm SCRIPT paths** that resolve inside `--scope` ∪ `floor.readOnly` ∪ {converge loop dir}. The editScope-positive enforcer + this denylist together hard-revert any commit that touches a measurement-footprint file outside the editing objective's scope.
   - DISCLOSE in GATE-DID-NOT-PROVE: scorer **fixtures/data files** the gate cannot statically enumerate remain a residual capture surface; footprint completeness is the operator's contract.
4. **The manifest is the meta-gate:** `manifestInsideScope` refuses a manifest under `--scope` (loaded once, never re-read; immutability = it is outside the editor's cwd).
5. **Pristine-checkout scoring** (fresh per-objective worktrees) blocks uncommitted-tree steering; committed capture is blocked by (1)+(2)+(3).

## 9. Budget & resume

- **Budget pooling (report §6-a):** `convergeNeedsGlobalBudget` refuses N≥2 with no `--global-budget`/`--global-budget-tokens`. `convergeObjectivesNeedCap` refuses unless every objective resolves a `hard_cap`. **Per-objective-lifetime** tracking + a **pre-launch reservation check**: before launching an objective compute `slice = splitBudget(remaining-pool, objectives-WITH-budget-remaining)` (a starved objective's share is reclaimed by siblings); REFUSE the next launch if `remaining-slice < one-expected-pass-cost` (not merely `<= 0`). Worst-case overshoot is bounded by `objectives-still-to-launch × max-pass-cost` (stated honestly, not understated).
- **Resume (DCA `(i)`):** `prepareGlobalResume` loads `converge-state.json` (NOT the tree), **hard-resets to `last_good_sha` unconditionally** (a committed-but-unrecorded child is indistinguishable from a killed-mid-revert gate-tampered tree, so unrecorded ⇒ discard+redo), RE-RUNS `reMeasureAll` at `last_good_sha` to **re-derive met from the SHA** (recorded vector is evidence, not authority — the "verify against source" lesson), restarts the inflight objective from scratch, refuses (actionable) if cumulative spend already exceeds the budget. Inflight child spend reconstructed as last-recorded + a one-pass penalty (a SIGKILL'd child never wrote its final `spent_*`; bias UP).

## 10. Honesty boundary

The done verdict CLAIMS only: "all N **DECLARED** objectives reached their operator-chosen targets on their held-out confirms (judge-class) / deterministic primaries, the floor held, no declared objective regressed beyond `min_delta`, stable over k." It does NOT claim objective-SET sufficiency (`objectives_sufficiency: 'unproven'` on EVERY exit path, no code flips it; `coverage_score` is Track-A's separate reserved field), nor that an UNDECLARED-dimension regression didn't ship, nor that a judge objective wasn't gamed by a committed artifact it reads. The report renders TWO sections: **GATE PROVED** (per-objective decision-score vs target, floor verdict + replica count, regression-free, stability count, the O(N×M) cost spent) and **GATE DID NOT PROVE** (sufficiency disclaimer + judge-objective list + measurement-footprint residual surface). The mandated config-pinned floor, re-measured against the pristine commit every integration, is the minimal held-out whole-repo hedge — it catches the cheapest gaming (individually-green-but-repo-broken) without C reasoning about coverage. It is a HEDGE, not a coverage solver.

## 11. Refusal suite (refuse-to-start, exit 2)

`convergeNeedsFloor` · `convergeFloorFootprintReadOnly` (NEW, DCA #2) · `convergeObjectivesNeedEditScope` · `convergeEditScopeOverlap` (NEW, DCA #3) · `convergeJudgeObjectiveNeedsConfirm` · `convergeNeedsGlobalBudget` · `convergeObjectivesNeedCap` · `manifestInsideScope` · `convergeUnsafeObjectiveScorer` · `manifestEditScopeReadOnlyCollision` · `cleanTreeGuard` (reused verbatim from scope-cli) · `isSha` + parent-equality guard on every `last_good_sha`/`candidateSha` before any `gitVerifyAt`/`gitRestore`/worktree-add · `prepareGlobalResume` budget-exhausted refusal.

## 12. Deferred (explicitly OUT of the C MVP)

- **Attribution-gated met-entry** (Track A/hardening) — causal-ownership, livelock-prone, not a strong anti-gaming primitive (DCA agreed to defer). The residual it would close (a judge reading a file in a sibling's editScope) is blocked here by editScope **disjointness** + held-out confirm, and otherwise DISCLOSED.
- **Rich `sharedSource` trust model** (hardening) — needs its own DCA; until then, overlap is simply REFUSED.
- **K-replay determinism classifier** (hardening) — replaced in the MVP by the concrete global stability re-measure (§6).
- **Worktree-isolated parallel fan-out** (Track B) — `converge.mjs` exports the gate path so `converge-parallel.mjs` tree-merges N worktrees into one `candidateSha` and calls the IDENTICAL gate.
- **Leaf-SET sufficiency / coverage heuristic** (Track A) — `objectives_sufficiency` stays `'unproven'`.
- **Diff-scoped re-measure optimization** (perf, post-measurement) — C's MVP re-measures full O(N) every integration; optimize after a measured wall-clock number (floor + undeclared-footprint objectives always re-measured).
- **Per-file salvage on regression** (Track A/B) — C's MVP is whole-round rollback.

## 13. Test plan (TDD, RED-first; all $0 except the marked paid elicitation)

**TIER-1 PURE ($0, stubbed vectors):**
1. `globalVerdict` floor veto: `floor.last_score===0` ⇒ `blocked` even when every `confirmScore >= target` (the §6.3 mandate precedence).
2. `globalVerdict` differing-targets: `[{confirm:80,target:80},{confirm:95,target:100}]` floor-passing ⇒ `running` NOT `done` (boolean-AND of MET, never `MIN>=min-target`).
3. `globalVerdict` done reason: all-met + floor + stable ⇒ `done` whose reason CONTAINS 'DECLARED' and 'NOT repo-goal sufficiency'.
4. `objectiveMet` uses confirm not primary: judge objective primary 95≥90 but confirm 70<90 ⇒ NOT met (DCA `(a)`).
5. `globalVerdict` does NOT wrap `gateVerdict`: an at-target objective with `global_pass>=global_cap` is still MET (capping is global-only); a NaN confirm ⇒ global `error` via `validScore`.
6. `globalRegressed` FULL-VECTOR (DCA #1): a MET objective 100→91 at target 90 regresses; an UNMET objective dropping >min_delta below `pre_integration_score` regresses; a drop within min_delta does not.
7. tiers: all-below-target + `global_pass>=global_cap` ⇒ `capped` naming the lifetime-exhausted objective; MIN-binding flat over window ⇒ `plateau`; recent improvement ⇒ `running`.
8. per-objective-LIFETIME budget: an objective regressing every integration is bounded to its lifetime share; slice denominator counts only objectives-with-budget; next launch refused when `remaining-slice < one-pass-cost`; verdict NAMES it.
9. refusal suite (each a distinct exit-2 test): all 13 guards in §11, incl. `convergeFloorFootprintReadOnly`, `convergeEditScopeOverlap`, `convergeUnsafeObjectiveScorer` (composite/floor renamed/symlinked), `manifestInsideScope`, `isSha`(HEAD~1/path).
10. honesty: `objectives_sufficiency==='unproven'` AND `coverage_score===null` on EVERY exit path; report renders GATE PROVED + GATE DID NOT PROVE; exit 0 with the 'declared' reason (exit-contract parity).

**TIER-2 REAL-GIT ($0, throwaway repo fixture, stub editor — built like `git-snapshot.test.mjs`):**
11. `squashIntegrate` transaction boundary: a child with K pass-commits yields `candidateSha` whose PARENT === `last_good_sha` (one net commit); an all-empty-baseline child ⇒ no advance.
12. last-good-ref reachability: simulate an objective child running `reset --hard` mid-run; the orchestrator's `last_good_ref` still rev-parses to its pre-launch value (gc-safe branch).
13. `reMeasureAll` isolation: objective[0]'s scorer writes `cache.json` into cwd; objective[1]'s scorer does NOT see it (fresh per-objective worktree); each scorer cwd === its worktree root.
14. floor invocation: spawned as `node scorers/floor.mjs --cmd <cmd>`, graded via exported `gradeFloor` (NOT `floorConfirmCmd` shape); `floorExit!=0` short-circuits — expensive judge scorers NEVER invoked (spy not-called).
15. floor replica-gate: fail-attempt-1/pass-attempt-2 ⇒ NO rollback; fail-both ⇒ rollback AND the objective vector is still computed (round names what regressed).
16. cross-objective capture BLOCKED (stub editor commits the gaming diff directly): objective-A child commits a change to objective-B's source OUTSIDE A's editScope ⇒ the editScope-positive enforcer reverts it before integration (canonical paths, prefix-trap `src/a` vs `src/app`, symlink).
17. scorer-script auto-union: objective scorer `node test/x.mjs` with `test/x.mjs` under `--scope` ⇒ auto-added to `globalReadOnly`; a stub-editor edit to it is reverted.
18. floor config-hijack pinned (DCA #2 — THE headline path): `floor.cmd` is `npm test`; a stub editor commits a `package.json` rewriting `test` to `echo ok`; with `package.json` in `floor.readOnly` the edit is reverted and the floor still FAILS on a genuinely-broken tree.
19. `globalRegressed` + rollback: objective B's integration drops previously-met A below A's target ⇒ `gitRestore` to `last_good_sha`, HEAD===`last_good_sha` after, `last_good_ref` UNCHANGED, A re-enters the unmet queue.
20. global stability re-measure (DCA #6): a deterministic-labelled scorer that flips across the ≥2× full-vector re-measure at the same SHA ⇒ done WITHHELD (not a lucky false done).
21. B-readiness shared-gate path: `reMeasureAll` with a `candidateSha` whose diff touches files OUTSIDE every objective's editScope (a simulated merge artifact) still runs floor + full vector and catches a cross-file regression invisible to either edit's isolated score.
22. resume idempotency: HEAD carries a committed gate-tampering edit (revert never ran — kill mid-enforce) ⇒ resume HARD-RESETS to `last_good_sha`, does NOT accept HEAD, re-derives met by re-measuring; a recorded all-done vector whose SHA re-measures below target ⇒ resume refuses done.
23. resume spend reconstruction: kill a child mid-act (no final `state.json`) ⇒ reconstructed cumulative spend ≥ pre-crash recorded child spend + one-pass penalty.
24. invariant guard: a static test asserts `loop.mjs` / `forge/{run,gate,store,prune,admit}.mjs` / `composite.mjs` are byte-identical before/after Track C (sha256), and that `converge-*.mjs` import-but-never-shadow their exports.

**PAID (separate, NOT a gate of the $0 suite):**
25. real-model elicitation harness (mirrors `forge-scope-multifile-realmodel`): a 2-objective manifest where a real editor under priority pressure is GIVEN the opportunity to game objective B via objective A's commit — assert the editScope-positive enforcer + held-out confirm + footprint-readonly hold against a real model's gaming attempt (NON-NULL = the capture path is exercised by a real editor, not just a stub). The `$0 --stub` arm must be GREEN first.

## 14. Implementation increments (for the plan / loop)

1. **`converge-gate.mjs` + Tier-1 tests** — pure `globalVerdict` (floor veto, MET-via-confirm, full-vector regression, tiers, honesty). $0, foundational. (Tests 1-7, 10.)
2. **`converge-state.mjs` + manifest + refusal suite + `converge-cli` parsing + Tier-1 tests** — shape validation, all 13 guards, resume-prepare. $0. (Tests 8, 9.)
3. **`converge.mjs` orchestrator + Tier-2 real-git tests** — isolated worktree run, `squashIntegrate`, `reMeasureAll` (floor-first, fresh worktrees, full vector), regression rollback, editScope-positive enforce + auto-union + footprint-readonly, last-good ref, budget reservation, resume, global stability re-measure, invariant-guard. $0. (Tests 11-24.)
4. **(paid) elicitation harness** — separate, after the $0 suite is green. (Test 25.)

Each increment: TDD (RED→GREEN→REFACTOR) → power-review → full suite green + 7 invariant files byte-identical → conventional commit+push → memory.
