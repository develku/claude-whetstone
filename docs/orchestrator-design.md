# whetstone-scope — open-ended repo-agent orchestrator design

> Status: **shipped** — MVP + v1 scope loop merged (PR #1), and the v2 planner tier (`decompose.mjs`)
> merged 2026-06-25 (implementation spec: `docs/superpowers/specs/2026-06-25-decompose-v2-design.md`).
> Build order was MVP → v1 → v2. Produced by a 6-agent design workflow (4 candidate architectures →
> judge → synthesis; run `wf_bae667c2`). This file is the durable plan; commit bodies carry per-step provenance.

## The decision (one line)

Build **whetstone-scope** (point the *unmodified* whetstone decision core at a repo via four swapped
I/O closures), then graft **Forge's clean-tree re-verify** discipline for the later planner tier. Not a
hierarchical tree; not a planner-first build.

## Why this shape — the load-bearing code fact

The whetstone loop is **already artifact-agnostic**. `gateVerdict` (`src/gate.mjs`) reads only
`history[].score`; `restoreTarget` (`src/regression.mjs`) returns an opaque snapshot *string* it never
interprets; `runLoop` (`src/loop.mjs`) takes `evaluate / act / persist / restore / confirm` as injected
closures. **Single-file binding lives entirely in four driver closures** — so widening to a repo is
mostly *wiring*, not new decision logic. The expensive, moat-eroding part of every candidate is the
**planner/decomposer** (the model choosing what to work on); we defer it to last and gate it behind a
*proven* coarse-signal plateau.

## Architecture — three layers, built in order

**Layer 0 — reused verbatim (zero edits):** `runLoop` (escalation ladder, dual-dial budget, no-op
detection, confirm-veto, error funnel), `gateVerdict`/`validScore`, `recordPass`/`setStatus`/`saveState`
(atomic temp+rename+redaction), `restoreTarget` (opaque-ref keep-best), `buildLedger`, `prepareResume`,
the scorer CLI contract + `composite`/`parseSubResult`/`combine` (already N-signal min-combine),
`extractCost`/`extractTokens`.

**Layer 1 — wider artifact (the MVP, "scope loop"):** swap exactly the four file-bound closures:
- **act** → `makeScopeAct`: same shape as `makeClaudeAct`, editor prompt allows multi-file edits *within
  `--scope <dir>`*; changed-detection via `git status --porcelain` (non-empty) instead of one sha256.
  **CRITICAL:** the scorer config + test files are **READ-ONLY / outside editable scope** — the editor
  must not be able to edit the gate it is scored by (direct moat breach if violated).
- **persist snapshot** → git commit/stash, returning the SHA as the `history[].snapshot` string (fits the
  existing field as-is).
- **restore** → git checkout/reset to that SHA. `restoreTarget` is unchanged; only its consumer swaps.
- **evaluate output** → reuse the existing `observe_cmd` seam: the scored "output" is the project
  scorer's stdout, not a per-file artifact.
- Project scorer = a **code-owned command** (`test-pass-rate --cmd "<build+test+lint>"`, or `composite`
  min over test/lint/typecheck). `runLoop` drives it unchanged; `gateVerdict` decides done/plateau/capped;
  keep-best rolls a regressing pass back via git.
- **GUARDRAIL (load-bearing for detached):** refuse to start on a dirty tree the orchestrator did not
  create, or scope to its own branch — else an unattended git restore clobbers the operator's uncommitted
  work.
- This is a complete, useful product (take a repo red → green, unattended) but is **NOT yet an
  orchestrator** and must be labeled so.

**Layer 2 — the planner tier (v1/v2, the only genuinely new logic):** activates **only** when the project
signal is provably too coarse to steer — detected by the *existing* plateau machinery (`gateVerdict`
returns `plateau` while `best_score < target` AND the scorer emitted structured `findings`
`[{area,severity,suggestion}]`). Then read `findings[].area` (a **code-owned** field, never a model vote)
and spawn one child whetstone run per finding-cluster, each scoped to a narrower glob with a narrower,
harder gate. The parent's `act` for that pass = "run the child loop to done-or-cap"; the child returns
`{changed,costUsd,tokens}` exactly like `makeClaudeAct`, so `runLoop` is untouched. **From Forge:** after
children close, the parent **re-runs the WHOLE-repo gate from a clean tree** — children closing
sub-findings is necessary but **never sufficient**. If the scorer emits only a scalar (no findings), Tier
2 cannot fire and the run honestly plateaus — the design refuses to invent sub-goals from a coarse signal.

**Project-level done stays code-owned:** at every level `done == project scorer's score >= target_score`,
computed by `gateVerdict` over numbers a code-owned command produced. `target_score` and the verify
command set are operator-frozen at launch (not in resume's overridable list) so the model cannot move
goalposts mid-run.

## Phased plan

| Step | What | Ships / measured success |
|---|---|---|
| **MVP** | wider-artifact scope loop, **no planner**: `--scope`, `makeScopeAct` (multi-file + git-status changed-detection), git keep-best, project scorer = test-pass-rate over build+test. Tests/scorer READ-ONLY. Clean-tree guard. | A known-broken fixture repo goes red → green, **fully unattended**, with gate/ledger/budget/resume/escalation untouched; keep-best provably rolls back a regressing pass (assert via the run's git log). Labeled "wider-artifact whetstone, NOT an orchestrator." |
| **v1** | project-gate hardening: `composite` min over test+lint+typecheck+coverage; held-out confirm suite the editor can't see/edit; re-run whole-repo gate from a **clean checkout** on the done-edge (Forge graft); aggregate leaf spend into the outer dual-dial budget. | A multi-dimension repo reaches done only when the **weakest** passes, verified from a clean tree; the confirm suite demonstrably vetoes a gamed primary score. Still flat (no planner → no coverage-gap risk). The strongest honest "open-ended done for a fixed bar." |
| **v2** | the planner tier (`decompose.mjs`), escalation-gated: fires only on coarse-signal plateau; spawn one child per `findings[].area`; parent re-measures the whole repo after; budget-share split, depth cap 1, plan-level anti-repeat dedupe. | A goal that demonstrably plateaus on a coarse signal (the "migrate N call sites" shape) completes via spawned children, total spend bounded by the parent budget. **This earns the word "orchestrator."** |

## Moat verdict — honestly: **partly kept**

- **Kept verbatim at the leaves:** every leaf is an unmodified `runLoop` (confirm-veto + keep-best
  intact); a leaf cannot self-declare done. v2's deliberate scope-*narrowing* makes leaf signals
  *sharper* (one test must go green) — the opposite of decomposition-rots-at-the-leaves.
- **Kept at the project gate:** project-done is `gateVerdict` over a code-owned whole-repo command,
  re-run from a clean tree, which no model wrote and the editor cannot edit.
- **Erodes in two places (state plainly):** (1) **target *definition*** — a green-but-thin suite reads
  100 while the repo is under-built; not fully solvable, mitigate with min-composite + held-out confirm.
  The gate is airtight for fixed-bar phrasings, a proxy for fuzzy ones. (2) **coverage, planner tier
  only** — a model-chosen decomposition can pick easy sub-goals; the Forge whole-repo re-measure means the
  planner *wastes budget but cannot fake done*. Code proves each leaf measurable, not the leaf *set*
  sufficient — the irreducible soft spot.
- **Downgrade case:** goals with no mechanical whole-repo gate fall back to an llm-judge composite —
  judge-owned, not build-owned. **Rule:** never ship a judge-only top gate; always keep one deterministic
  floor ("repo still builds") in the min-composite.

## vs SWE-agent / OpenHands — honestly

The editing mechanics overlap; whetstone-scope will **not out-edit** a mature harness, and the MVP alone
adds little novel *reach*. The **one** concrete thing it adds: a **code-owned, model-independent STOP** the
agent cannot vote past — now at project scale. They stop when the *model* judges done; whetstone-scope's
leaves stop only when a code-run scorer clears target, and the project stops only when a code-run
whole-repo command passes from a clean tree. The differentiator is the **trust model (who owns the stop)**,
not edit smarts — which is exactly what matters for **unattended / overnight** runs. Honest admission: if
your goal already has one global suite that fully specifies done, just point a single whetstone run at it;
if your goals lack expressible measured gates, SWE-agent/OpenHands are the better tool. **The bet is on the
gate, not the hands.**

## Net-new code (small)

- `src/scope-act.mjs` — `makeScopeAct({scopeDir,model,effort,mcpConfig})`; multi-file editor prompt;
  `git status --porcelain` changed-detection. ~50 lines.
- `src/git-snapshot.mjs` — `gitSnapshot(scopeDir, pass)` → SHA/stash ref (the `history[].snapshot`
  string); `gitRestore(scopeDir, ref)` inverse. Replaces `snapshotArtifact` + the single-copy restore.
  ~40 lines.
- `src/scope-context.mjs` — `buildContext` twin (persist → `gitSnapshot`; evaluate → project scorer via
  the `observe_cmd` seam). ~50 lines.
- `src/scope-cli.mjs` — `parseCli` twin: `--scope <dir|glob>`, `--decompose` (default OFF), leaf-budget
  aggregation, clean-tree-or-own-branch guard. ~50 lines.
- project-scorer wiring (v1) — composite min + held-out confirm suite; reuses `composite.mjs` verbatim.
- clean-tree re-verify on the done-edge (v1, Forge graft). ~30 lines.
- `src/decompose.mjs` (**v2 only**) — `coarseSignalPlateau(state)` predicate + `spawnChildRun`; budget-share
  split + depth cap + dedupe. ~100 lines. **The only genuinely new decision logic; everything before it is
  wiring.**

## Top risks (ordered) — #1 and #2 must be enforced in the MVP

1. **Editor edits the gate it is scored by — direct moat breach.** Tests + scorer config MUST be
   READ-ONLY, outside the editable scope. Highest severity.
2. **git keep-best correctness + worktree safety.** commit/stash + reset-to-ref must be airtight; an
   unattended restore can clobber the operator's uncommitted work → hard clean-tree-or-own-branch guard.
   The single riskiest net-new piece; load-bearing for detached operation.
3. Open-ended target is a proxy (green-but-thin) — mitigate, not solvable.
4. Decomposition coverage gap (v2) — defended by the whole-repo re-measure, not eliminated.
5. Planner reward-hacking the verify signal (v2) — coverage on a frozen test set, held-out suite fenced
   out of editable paths.
6. Cost fan-out (v2) — budget-share split + depth-cap-1 + surfaced projected fan-out cost.
7. Coarse-signal honesty gap — no findings → no decomposition → honest plateau (may disappoint).
8. Moat downgrade for judge-only goals — keep a deterministic floor in the min-composite.

## North star — self-hosting (the operator's intent)

Once the MVP/v1 exists, use **whetstone-scope to finish whetstone-scope** — an unattended overnight run
that edits this repo toward a green gate and **self-commits each best pass** (git keep-best *is*
self-commit). The ultimate dogfood: the loop building the loop, with the code-owned gate (not the model)
deciding when a night's work is actually done. v1's git-commit-per-best-pass + detached operation are
exactly what this needs; the held-out confirm suite is what makes an unattended self-edit trustworthy.

## Appendix — the four candidates considered

1. **grindstone** (plan→execute→verify, two nested measured loops) — rejected as the *first* step: its MVP
   ships a planner + plan.json validator on day one, front-loading the riskiest least-reused code.
2. **Grindstone-tree** (hierarchical task tree, min-combine rollup) — elegant but a larger system whose
   recursive-rollup value only pays off for genuinely multi-level goals; most repo goals are flat.
   Violates simplicity-first as a starting point.
3. **Forge** (blackboard / task-queue, worktree workers, two-altitude code gate) — not adopted wholesale,
   but its **best idea is grafted**: the project gate re-runs the real suite from a *clean tree* and never
   trusts worker-written leaf scores, so a lazy/gamed decomposition wastes budget but cannot fake done.
4. **whetstone-scope** (this design) — chosen: cheapest real MVP (wiring, not new logic), gets the
   load-bearing moat component (project gate) for free in step one, defers the moat-eroding planner behind
   a proven plateau.
