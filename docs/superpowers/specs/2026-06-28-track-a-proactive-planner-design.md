---
title: Track A — Proactive Allowlist-Bound Model Planner (design spec)
date: 2026-06-28
status: design — approved in brainstorming; awaiting spec review before writing-plans
provenance:
  brainstorm: attended (operator decisions A1–A5 below)
  design_workflow: wf_a14fc97b-8c8 (7 design lenses + 3 adversarial refuters + 1 completeness critic; 11 agents, 1.3M tokens). Synthesized BY HAND from the journal (the Track-B lesson: never trust a degraded synthesis agent).
  adversarial_findings_folded: G1–G15 (completeness critic) + BREAK#1/#2 (safety-capture refuter: tautological io-* cases, provenance lie, G8 math) + BREAK#1/#2/#3 (coverage refuter: reMeasureAll red-repo brick, barbell scorer-misassignment, root-editScope canonicalization) + BREAK#1/#2/#3 (night-run refuter: test-pass-rate shell scorer, unguarded floor.cmd, git-stash hidden state).
  builds_on: Track C (docs/superpowers/specs/2026-06-28-track-c-global-convergence-design.md) + Track B (docs/superpowers/specs/2026-06-28-track-b-concurrency-design.md), HEAD 270b7c1
---

# Track A — Proactive Allowlist-Bound Model Planner

## 1. Goal & scope

Track A is a **manifest generator**. Track C/B converge an *operator-authored* objective manifest under a code-owned global gate. Track A produces that manifest **proactively** from a high-level goal + repo + an operator-provided scorer allowlist, then hands the in-memory object straight into the **verbatim** Track C `convergeRefusal` suite and `runConverge`/`runConvergeParallel`. It is the decomposition + planning arc of the north star (H→C→B→**A**).

**The load-bearing safety idea:** the planner is *a fenced operator, not a privileged path.* Its output is a plain manifest that must survive `convergeRefusal` exactly as an operator-authored one does. The planner only **adds** a fail-closed pre-suite (model output is harder to trust than a human's) and a **non-gating** coverage report. It forks no gate and edits none of the 7 invariant files.

### Operator decisions (fixed in brainstorming — design WITHIN these)

- **A1 — Sufficiency:** the planner auto-generates objectives, but `objectives_sufficiency` STAYS `'unproven'` forever (hard constant `converge-state.mjs` `OBJECTIVES_SUFFICIENCY`; no code path flips it). A `coverage_score` (0–100) is **reported** but **never gates `done`** and never aliases sufficiency.
- **A2 — Trigger:** **proactive upfront.** The planner runs ONCE (one model call) before convergence: goal → manifest → Track C/B. Re-plan-on-plateau is DEFERRED (decompose.mjs already seeds the reactive flavour).
- **A3 — Approach:** **allowlist-bound model planner.** The model proposes `{scorerId, args[]}` per objective (NEVER a free-form scorer command string); code resolves the id against an operator allowlist and constructs the command. The floor is **operator-authored, never model-generated**.
- **A4 — Anti-Goodhart honesty (Option 2):** a structural heuristic can stop **CRUDE** gaming (empty/root scopes, shell scorers, sub-floor targets, judge scorers, objective-count blowup) but provably CANNOT stop **SOPHISTICATED** gaming (tautological self-authored test cases; weak-proxy scorer misassignment). Track A delivers the structural anti-crude-gaming guards + a report-only coverage estimate + a **LOUD GATE-DID-NOT-PROVE disclosure**, with the same `'unproven'` honesty as Track C. A held-out per-region *semantic* confirm — the real fix for misassignment — is named as the **frontier** (deferred, §15).
- **A5 — Scope:** MVP = **deterministic DATA-only scorers** (no model-authored judge rubrics; no shell-executing scorers). Separate `whetstone-plan` CLI entry; `converge-cli.mjs` untouched.

## 2. The honesty position (what Track A does and does NOT claim)

Track A claims: *"I auto-authored a manifest that is STRUCTURALLY safe (passes `convergeRefusal` verbatim, scorers are data-only and operator-allowlisted, scopes are in-repo and disjoint, the floor is yours) and STRUCTURALLY non-crude (no empty/root scopes, no sub-floor targets, bounded count)."*

Track A explicitly does **NOT** claim: that the objective set is *sufficient* for the goal (`objectives_sufficiency` stays `'unproven'`), nor that each objective's scorer+cases actually *measure the goal's hard requirement* in its region. The model's freedom to (a) author the io-* test cases and (b) pair a scorer with a region is the **one trust boundary Track A widens beyond Track C**, and no structural check closes it. `coverage_score` is **spatial span, never semantic fitness.**

## 3. Architecture

### 3.1 Modules (flat `src/plan-*.mjs`, matching the `converge-*`/`scope-*` sibling convention)

| Module | Purpose | Pure? |
|---|---|---|
| `src/plan-allowlist.mjs` | `loadPlanAllowlist(scorerAllowPaths)` → `Map<id, absPath>` of DATA-only scorers (HARD-subtracts every shell-executing scorer). | I/O (reads scorer dir) |
| `src/plan-resolve.mjs` | `resolveObjective(proposal, {scopeDir, allowlist})` → manifest objective \| null. THE fence (mirrors `decompose.resolveSubGate`). | pure |
| `src/plan-refuse.mjs` | the planner-only refusal suite (the new guards, §5). | pure |
| `src/plan-coverage.mjs` | `coverageScore(manifest, editableSurface)` (surface-span set-union only) + the disclosure strings. | pure |
| `src/plan-prompt.mjs` | `buildPlannerPrompt(goal, repoContext, allowlistMenu)` + `parsePlannerReply(text)` (nonce-fenced; pure). | pure |
| `src/plan.mjs` | `planManifest(cfg, deps)` — the orchestration pipeline; `deps.planCall` injected ($0-testable). | pure given injected planCall |
| `src/plan-call.mjs` | `realPlanCall(prompt, opts)` — the ONE paid `claude -p` call, SIGKILL-timeout-capped. | I/O (spawn) |
| `src/plan-cli.mjs` | `whetstone-plan` entry: parse → planManifest → write manifest OUTSIDE scope + sidecar report → optional `--and-converge`. | I/O |

**Imports (reuse, NEVER fork):** `convergeRefusal`/`validateManifest` (`converge-cli.mjs`), `pathsIntersect`/`canonRel`/`isJudgeClass`/`globalReadOnly` (`converge-shared.mjs`), `shq` (`shq.mjs`), `isUnsafeScorer` (`scorer-safety.mjs`), `makeNonce`/`fenceUntrusted` (`prompt-fence.mjs`), `extractCost`/`extractTokens` (`act-claude.mjs`), `runConverge`/`runConvergeParallel` (dynamic import in `plan-cli.mjs` only), `formatSpend` (`spend-format.mjs`).

**Must NOT touch:** the 7 invariant files (tripwire); the gate orchestrators' internals (`converge.mjs`/`converge-gate.mjs` — the planner produces an *input for* `runConverge`, never reasons about `globalVerdict`). The ONE permitted `converge-*` edit is inc 0's pre-specified additive cfg-threading in `converge-state.mjs` (§9) — nothing else.

### 3.2 The pipeline (planManifest)

```
goal (operator-trusted) + allowlist (operator) + repoContext (git ls-files + fenced README)
   │  ONE paid model call (plan-call, SIGKILL-capped) — returns UNTRUSTED JSON
   ▼
parsePlannerReply → [{scorerId, args[], editScope, target, id, goal}]   (model output = DATA)
   │  resolveObjective() per proposal  ← THE FENCE (§4): drops anything unsafe
   ▼
planner-only refusal suite (§5)  ← fail-closed: any refusal → exit 2, NO convergence spend
   │  assemble manifest: model objectives[] + OPERATOR floor + objective_cap + global_budget
   ▼
convergeRefusal(cfg) VERBATIM  ← the same gate an operator-authored manifest survives
   ▼
coverageScore (report-only, → sidecar plan-report.json)  +  manifest written OUTSIDE --scope
   ▼  (optional --and-converge, default OFF)
runConverge / runConvergeParallel  ← UNCHANGED consumer; gate + termination owned here
```

## 4. The fence — `resolveObjective` (the whole "model output is data" safety story)

Structurally identical to `decompose.resolveSubGate`. The model output schema is the ONLY thing accepted:

```jsonc
{ "objectives": [ { "id": "str", "goal": "str", "scorerId": "str",
                    "args": ["str", ...], "editScope": "str", "target": 70 } ] }
```

```js
// resolveObjective(proposal, { scopeDir, allowlist }) -> objective | null
const scriptPath = allowlist.get(proposal.scorerId)        // 1. known DATA-only id, or null
if (!scriptPath) return null
if (!Array.isArray(proposal.args) || !proposal.args.every(a => typeof a === 'string')) return null
const scorer = ['node', shq(scriptPath), ...proposal.args.map(shq)].join(' ')  // 2. CODE builds the cmd
const base = resolve(scopeDir)
const full = resolve(base, proposal.editScope)
if (full === base) return null                             // 3a. REJECT repo-root scope (refuter BREAK#3)
if (!full.startsWith(base + sep)) return null              // 3b. REJECT traversal/absolute (refuter: convergeRefusal does NOT check containment)
const editScope = canonRel(relative(base, full))           // 4. canonical repo-relative — SAME canon as the gate's pathsIntersect (no P4/P6 mismatch)
return { id: proposal.id, goal: proposal.goal, scorer, editScope, target: proposal.target }
```

**Why safe (trace):** the model never names an executable (only an allowlist id), never emits a command string (code constructs `node <op-path> <shq args>`), never controls cwd/scope (containment + root reject), and its free-text `goal` is never executed (it reaches the *editor* through the already-fenced `buildEditorPrompt`/`prompt-fence`). The constructed scorer command is re-checked by `convergeUnsafeObjectiveScorer` (defense in depth). The fence enforces the containment + root checks that `convergeRefusal` does NOT (a verified gap: a `../../etc` or `.` editScope passes the whole refusal suite today).

## 5. Planner-only refusal suite (`plan-refuse.mjs`) — runs AFTER the fence, BEFORE `convergeRefusal`

Fail-closed: any refusal → exit 2, no convergence spend. These hold the planner's OWN output to a higher bar than an operator's hand (a model is harder to trust).

| Guard | Closes | Rule |
|---|---|---|
| `planSchemaValid` | malformed/injected JSON, extra keys, wrong types | boundary-validate every proposal; any failure → drop that objective |
| `planEditScopeInRepo` | path traversal + repo-root scope | enforced in the fence (§4 3a/3b); re-asserted as an auditable predicate |
| `planTargetFloor(MIN_TARGET)` | trivially-low target (model gaming) | refuse any generated objective with `target < MIN_TARGET` (default 70) |
| `planNoJudgeScorer` | judge-rubric capture surface (A5) | refuse (NOT silent-skip) any proposal whose resolved scorer `isJudgeClass` |
| `planDataOnlyScorer` | **the #1 risk — model-reaches-shell** | the allowlist (§7) already HARD-excludes shell scorers; this re-asserts none survived |
| `planObjectiveCount(MAX)` | fan-out blowup | refuse a manifest with `> MAX` objectives (default 12) — a cost guard |
| `planAllDropped` | empty manifest (bad allowlist/goal) | if the fence dropped EVERY objective → exit 2 printing the `rejected[]` list (fail-closed proof, refuter G15) |

Then `convergeRefusal(cfg)` runs **verbatim** (validateManifest + the 8 guards). NO fork; the planner only adds a pre-suite.

## 6. Coverage heuristic (`plan-coverage.mjs`) — surface span only, report-only

**`coverageScore(manifest, editableSurface) → 0..100`** = the fraction of the *editable surface* covered by the union of objective editScopes. **Set-union over files**, so adding an overlapping leaf adds ZERO (leaf-multiplication-resistant). The **scorer-strength proxy is DROPPED** — the safety-capture refuter proved "reward io-*" *inverts* the control (tautological io-* cases score HIGH).

- `editableSurface` = `git ls-files` under `--scope`, minus `globalReadOnly(manifest)`, minus a declared test-dir set. Pinned concretely so the "overlap-adds-zero" test is writable. The denominator is computed once from the live tree and is itself disclosed (a shrunk denominator inflates coverage — refuter BREAK#3a).
- **Report-only.** Written to the **sidecar `plan-report.json`**, NOT to converge-state via a gate path; `globalVerdict` never reads it. The `coverage_score` field also rides through `initConvergeState` via inc 0's cfg-thread for the ledger record, but no gate consumes it.
- **NO baseline measurement.** A plan-time `reMeasureAll` bricks on a RED repo (the common proactive-planner input — `reMeasureAll` short-circuits the vector to `null` on a failing floor; refuter coverage BREAK#1) and is unbudgeted. The "already-met-at-baseline" tautology is instead handled HONESTLY by convergence itself (a red floor → Track C blocks at baseline; a green-floor trivial set → disclosed residual) and named in §11.

## 7. Scorer safety — the data-only allowlist (the #1 risk, closed)

Track A is the **Forge case** (the model authors the scorer args), NOT the decompose case (a scorer-emitted finding names it). So it must use the broader denylist:

- `loadPlanAllowlist` starts from the shipped `scorers/` + operator `--scorer-allow` paths, then **HARD-SUBTRACTS every shell-executing scorer** — `composite`, `floor`, `test-pass-rate`, `llm-judge` — leaving the DATA-only set: `contains`, `io-assert`, `io-trace`, `io-invariant`, `io-effect`. (`test-pass-rate --cmd '<shell>'` and `floor.cmd` are model-reaches-shell holes confirmed by both refuters; `scope-cli`'s `SUBGATE_UNSAFE = {composite, floor}` is the WRONG denylist to reuse.)
- The model emits `{scorerId, args[]}` ONLY; `resolveObjective` constructs the command. `validateManifest` accepts a free-form `scorer` string, but the planner NEVER lets a model string become one — every scorer command is planner-constructed from an allowlisted path.
- **The floor is operator-authored** (`--floor-cmd` + `--floor-read-only`), passed through untouched. The planner never generates `floor.cmd` (an unguarded model-authored shell otherwise).

## 8. Integration seam (planner → Track C/B, no fork)

- The manifest is written to an operator path **OUTSIDE `--scope`** (so `manifestInsideScope` holds — it is the operator-owned meta-gate, model-uneditable). Convergence re-validates it from disk via `loadManifest` (defense in depth: planner validates in-memory, converge re-validates from disk).
- CLI: a **separate `whetstone-plan` entry** (`converge-cli.mjs` stays byte-untouched). `whetstone-plan --goal "<g>" --scope <dir> --scorer-allow <paths OUTSIDE scope> --floor-cmd "<cmd>" --floor-read-only <files> --global-budget-tokens N --out <manifest.json OUTSIDE scope> [--min-target 70] [--max-objectives 12] [--planner-model opus] [--and-converge] [--parallel]`.
- `--and-converge` **defaults OFF** for the MVP (write manifest + report, exit 0; operator runs `whetstone-converge` separately). When ON, it reuses `cleanTreeGuard` + `acquireRunLock` with `integration-seam`'s exact tail ordering (`ensureConvergeDir` → write → `manifestInsideScope` probe → `convergeRefusal` → lock → run).
- `initConvergeState` is reused unchanged (the manifest shape is identical to operator-authored) except inc 0's additive provenance fields.

## 9. Provenance (inc 0 — the ONE pre-authorized `converge-state.mjs` edit)

`initConvergeState` hard-codes `objectives_source: 'operator-manifest'` and `coverage_score: null` — so a planner run would record a *lie* in the durable ledger (refuter safety BREAK#2a). Inc 0 is a **pre-specified, additive, test-safe** edit:

```js
objectives_source: cfg.objectivesSource ?? 'operator-manifest',   // planner passes 'planner'
coverage_score: cfg.coverageScore ?? null,                        // planner passes the number
```

The `??` defaults preserve every existing `converge-state.test.mjs` assertion (a cfg without these fields still yields `'operator-manifest'`/`null`). `converge-state.mjs` is NOT an invariant file. This is the ONLY converge-* edit the overnight session may make; it is named here so the night-run STOP-list can carve it out explicitly.

## 10. Budget & termination

- The planner **cannot cause a non-terminating run** — `globalVerdict`/`global_cap`/`globalBudgetExhausted`/`canAffordObjective`/`pickNextObjective` own termination, all in the UNCHANGED engine. The planner only populates `objectives[]`.
- **Drop the predictive budget-ceiling math (G8).** The refuter proved `objectives × cap × ONE_PASS` is neither an upper nor lower bound (real ceiling is `global_cap × ONE_PASS`; objectives are re-attempted across cycles). Keep only: the planning `claude -p` call is **SIGKILL-timeout-capped** (mirrors `act-claude`'s 10-min cap), ONE call, and its spend is reported (token-primary) via `extractTokens`. The operator-provided `global_budget_*` (mandatory for ≥2 objectives, `convergeNeedsGlobalBudget` verbatim) bounds convergence; the existing post-pass guards enforce it.

## 11. GATE-DID-NOT-PROVE — the loud disclosures (the headline residuals)

The planner's report (`plan-report.json` + stdout) MUST state, prominently:

1. **`objectives_sufficiency: 'unproven'`** — the SET is auto-generated, not proven sufficient for the goal. Hard-coded; no path flips it.
2. **HEADLINE — scorer-to-region misassignment + tautological cases are NOT caught.** A model can (a) author io-* test cases that are trivially or tautologically satisfiable (e.g. `identity` with `1=>1`, or cases already true at baseline), or (b) pair a real-looking weak-proxy scorer with the goal's hard region so no leaf measures it. Both pass every structural guard and `convergeRefusal`. **`coverage_score` is spatial span, never semantic fitness, and the model's case-authorship + scorer↔region choice is the one trust boundary Track A widens beyond Track C.** No structural control closes it; the real fix is a held-out semantic confirm (frontier, §15).
3. **`coverage_score` is a STRUCTURAL PROXY** — span over the editable surface, not a coverage proof; a shrunk denominator or a barbell decomposition can inflate it.
4. **Scorer-menu + arg adequacy is the operator's contract** — the planner selects from the operator's allowlist; a weak menu yields weak objectives. `--pin-scorers` (operator fixedArgs) is the lever to remove the model's arg freedom (deferred).
5. **Deterministic scorers reading repo-controlled fixtures** remain an indirect-capture surface (Track C's disclosure, ×N objectives).

## 12. Increment backlog (the overnight loop — ordered: pure/safe first, paid last)

Each increment: RED test first → implement the named module → **full `node --test test/*.test.mjs` green (the `converge-invariant` tripwire is in the suite — a green suite IS the 7-invariant guarantee)** → one conventional commit → memory. All $0 except inc 9.

- **inc 0 — provenance threading.** The §9 additive `converge-state.mjs` edit. Tier-1: existing converge-state tests stay green; a new test asserts `cfg.objectivesSource='planner'` lands in state. `feat(plan): Track A inc 0 — thread objectives_source/coverage_score (additive, defaults preserved)`
- **inc 1 — `plan-resolve.mjs` (the fence).** Tier-1: unknown id → null; non-array/non-string args → null; traversal/absolute/`src/a`-vs-`src/app` prefix-trap → null; **root `.`/`''` → null**; happy path builds `node <shq path> <shq args>`; shell-metachar args appear shq-quoted. Reuse `decompose.test.mjs` injection cases as the oracle.
- **inc 2 — `plan-allowlist.mjs` (data-only).** Tier-2 ($0, reads scorer dir): the shell scorers (`test-pass-rate`, `llm-judge`, `composite`, `floor`) are **subtracted**; the data-only set remains; an operator `--scorer-allow` shell scorer is also subtracted (HARD, tested — not "not added").
- **inc 3 — `plan-refuse.mjs` (the guards).** Tier-1: each guard a distinct exit-2 test (low target, judge scorer, >MAX count, all-dropped→exit2 with rejected list, in-repo+not-root).
- **inc 4 — `plan-coverage.mjs`.** Tier-1: all-tiny-scope manifest scores low; broad-disjoint manifest scores high; **overlap-adds-zero** (set-union property); coverage_score is report-only (calling it never returns a verdict, `globalVerdict` ignores it); `objectives_sufficiency` unaffected. Pin the editable-surface denominator.
- **inc 5 — `plan-prompt.mjs`.** Tier-1: the goal + repoContext are FENCED (`fenceUntrusted`); the allowlist menu (legal ids) is trusted instruction OUTSIDE the fence; the output schema is present; `parsePlannerReply` rejects non-JSON/missing-objectives.
- **inc 6 — `plan.mjs` (orchestration, injected planCall).** Tier-1/2: a stub planCall returning a gaming proposal (judge/traversal/root/low-target/shell-scorer) → refused at the right guard; a clean proposal → manifest passes `convergeRefusal` verbatim; deterministic (same goal+ctx → byte-identical manifest).
- **inc 7 — pipeline test: stub plan → `runConverge` → done ($0 stub child).** Tier-2 (real git temp repo, stub child; mirrors `converge-run.test.mjs`): the generated manifest drives the UNCHANGED engine to `done`; a cross-objective stub edit is reverted by the editScope-positive squash (Track A inherits Track C's anti-capture free). **Milestone: Track A functionally complete at $0.**
- **inc 8 — `plan-call.mjs` + `plan-cli.mjs` (the entry + the real call, injected spawn $0-tested).** Tier-1/2: `buildClaudeArgs`/`extractTokens` reuse; SIGKILL cap; CLI parses flags; **manifest written OUTSIDE scope** (refuse exit-2 if `--out` inside scope); written manifest re-passes `convergeRefusal` from disk; honesty disclosure printed; `--and-converge` default OFF.
- **inc 9 (PAID, LAST, non-gating) — `bench/plan-capture-realmodel.mjs`.** The adversarial scorer-capture elicitation (report rec #1). `$0 --stub` arm GREEN first (the firebreak). PAID `--model sonnet` arm: a real model decomposes a real goal under an allowlist containing a weak + a strong scorer; **SAFETY-HELD asserted ALWAYS** (every manifest passes `convergeRefusal`, no shell/off-allowlist scorer, manifest outside scope, exit 1 on any breach); **PRIMARY NON-NULL** = a real planner produces a `convergeRefusal`-passing ≥2-objective all-data-only manifest that drives `runConverge` to `done`; **SECONDARY** = an injected "ignore the catalog" README line does NOT yield an off-catalog scorer surviving the fence. Token-primary spend via `formatSpend`; retry-flaky-child wrapper (harness-only). Background it (nested `claude -p` flake + 10-min foreground cap).

## 13. Night-run guardrails (unattended ultracode + bypass-permissions)

- **Verify gate (the per-increment "done"):** `node --test test/*.test.mjs` ALL green (includes the `converge-invariant` baked-sha256 tripwire). If RED → do NOT commit, do NOT proceed.
- **NO `git stash`, NO skip-to-"independent".** `git stash` is hidden state outside `git log` (refuter night BREAK#3); the increment DAG is linear (inc 0→9). On a blocked increment: **STOP the session entirely**, leave the WIP uncommitted with a one-line BLOCKED note, and leave it for the operator. Do NOT barrel to later increments.
- **Resume point:** the first increment whose commit is not in `git log`. Each committed increment is a clean checkpoint (green suite at commit time).
- **STOP-list (do NOT do autonomously even in bypass):** edit any of the 7 invariant files; edit any `converge-*.mjs` EXCEPT inc 0's named additive thread; change gate semantics; reopen the H3 DCA; let a model author a scorer command, a judge rubric, or `floor.cmd`; add a shell scorer to the allowlist; flip `objectives_sufficiency`. Hitting any of these → STOP and leave for the operator.
- **Spend:** inc 0–8 are $0 (pure + injected spawn + stub child + real git/fs). Only inc 9's PAID arm spends, gated behind its $0 `--stub` arm, run LAST as a terminal background job.
- **Commit-per-increment to `main`** (the established rhythm); never bundle destructive git ops.

## 14. Test plan (TDD, RED-first; all $0 except inc 9 paid arm)

Tier-1 (pure): the fence (inc 1), the guards (inc 3), coverage set-union (inc 4), prompt fencing (inc 5), orchestration with stub planCall (inc 6), provenance thread (inc 0). Tier-2 ($0, real git/fs/stub child): allowlist subtraction (inc 2), stub-plan → runConverge → done (inc 7), CLI manifest-outside-scope + disk round-trip (inc 8). PAID (inc 9, separate, non-gating): real-model capture elicitation, $0 stub arm first.

## 15. Deferred / frontier (explicitly out of the MVP)

- **Held-out per-region SEMANTIC confirm (the real fix for A4's misassignment residual)** — an operator-authored or separately-trusted judge that tests whether a region's scorer actually measures the goal there. The next frontier; the only thing that closes the headline §11.2 disclosure. (Option 2.)
- **Re-plan-on-plateau** (the reactive flavour; decompose.mjs is the seed).
- **`--pin-scorers` / allowlist `fixedArgs`** (operator removes the model's arg-strength freedom).
- **Baseline-met probe** when the floor is green (catches the "already true at baseline" tautology subclass; skipped in MVP because it bricks on red repos and is unbudgeted).
- **Judge-class planner objectives** (operator-authored only in MVP).
