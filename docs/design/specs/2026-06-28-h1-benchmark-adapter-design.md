# H1 — SWE-EVO Benchmark Adapter + Gated-vs-Baseline A/B (design)

- **Date:** 2026-06-28
- **Status:** REVISED per Codex review (verdict REVISE — folded in below). Ready to build the `$0` pilot harness; the full paid run is gated behind a veto-opportunity audit (§5).
- **Part of:** the **H milestone** (gate hardening + a benchmark number) of the re-plan **H → C → B → A**. See `docs/2026-06-28-loop-engineering-competitive-positioning.md`.

## 1. Why

whetstone's lone credible lead — a code-owned *measured* gate + a self-hardening verifier lifecycle — has **no external number**. Getting one (and showing the gate *earns its keep*, not just a raw resolve rate) is the single most urgent next move per the report + codex. H1 builds the apparatus on SWE-EVO.

## 2. The constraint the research surfaced

SWE-EVO (like every SWE-bench-style benchmark) **holds its grading tests out from the agent** (gold `test_patch` applied at scoring, after the agent's patch). The "two-tier metric" is Resolved (hard) vs Fix Rate (soft) over the **same held-out suite** — *not* a visible/held-out split. But whetstone's loop **requires an in-loop scorer with a gradient**. So we must **manufacture** the visible scorer. (This concretely re-confirms the report's "needs a real scorer to exist" iron constraint.)

## 3. Design — leak-subset A/B with a THREE-way split (codex fix: Δ must be identifiable)

The original two-way split (V visible, H both confirm-and-truth) was **confounded**: the gated arm saw H via `--confirm-scorer` while baseline did not, yet truth = H — so a positive Δ could just mean "gated ran more hidden tests (oracle access)," not "the gate generalized." Fix: **three disjoint splits, T held out from EVERY arm.**

**Per task, partition the tests by BEHAVIOR CLUSTER (not random node IDs):**
- **V (visible)** — the in-loop scorer for ALL arms. One or more behavior clusters of `FAIL_TO_PASS` (applied to the tree) **+ all `PASS_TO_PASS`** (existing regression tests). The editor sees and runs V.
- **C (confirm)** — finish-line check for the gated arms only. Disjoint `FAIL_TO_PASS` clusters. **Source-isolated** from the editor (see §4) — never applied to the working tree, never readable.
- **T (truth)** — the final grade for ALL arms. Disjoint `FAIL_TO_PASS` clusters, **held out from every arm** (never the in-loop scorer, never the confirm). Source-isolated.
- Cluster by: test file → pytest node function/class → parametrization family → covered product files → PR/behavior bucket. Hold out **whole clusters**. **Exclude tasks with < 3 independent `FAIL_TO_PASS` clusters** (can't form V/C/T). `PASS_TO_PASS` regression applies in every metric (any fail → 0, per SWE-EVO Eq. 1).

**Arms (same editor model / effort / per-task budget; forge requires a confirm-scorer to fire, so the ablation chains):**
1. **baseline** — gate on V only.
2. **+confirm** — V + `--confirm-scorer` = C (forge OFF).
3. **+confirm+forge** (full gated) — V + confirm = C + forge ON.
4. **capability** — full suite as the scorer (oracle upper bound; labeled as such, NOT an external SWE-EVO number).

**Outputs, all graded on the held-out T (identifiable):**
- **(2) − (1)** = the confirm-scorer's contribution.
- **(3) − (2)** = the forge's marginal contribution.
- **(3) − (1)** = the full gate's contribution = the headline ΔFix-Rate.
- Confirm-veto activation rate; per-task + aggregate with **paired bootstrap/permutation CIs** (48 tasks is small — 1 instance ≈ 2.08pp; pre-register what Δ counts as meaningful).

## 4. Architecture

- New harness under **`bench/swe-evo/`** (a bench; **the 7 invariant files stay UNTOUCHED**). New scorers/runners are `bench/` or `scorers/` additions.
- **Dataset:** `Fsoft-AIC/SWE-EVO` (HF, 48 rows). Fields: `repo`, `instance_id`, `base_commit`, `environment_setup_commit`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_cmds`, `log_parser`, `image`.
- **Cluster + split builder:** parse `test_patch` to map each `FAIL_TO_PASS` node → its file/function/param-family → cluster → assign clusters to V/C/T. **Source isolation (codex):** read-only test dirs stop *weakening*, not *reading* — so C/T test bodies must be **physically absent** from the editor's tree (apply only V's test files; keep C/T `test_patch` hunks out entirely, or AST-redact). Verify the editor's tree contains no C/T assertions.
- **We run tests ourselves for the in-loop V scorer and the C confirm** (whetstone needs a live gradient) — BUT **the final T truth is cross-checked against SWE-EVO's official `SWE-bench/evaluate_instance.py`** on every final patch in the pilot + random samples of the full run, to catch silent divergence (codex Q2). **Pin:** HF dataset revision, SWE-EVO repo commit, SWE-bench commit, Docker image digests, platform/arch, patch-apply order, timeout, env vars, `test_cmds` source, `log_parser` source, PASS_TO_PASS-zero behavior.
- **No network during editing AND scoring** (codex Q4): SWE-EVO is built from public release transitions; without a network block the editor can fetch the end-version code/PRs/tests. Run the `claude -p` act step and tests with network disabled.
- **Per task:** clean checkout at `base_commit` inside the instance Docker `image` (prefer the image over local env reconstruction) → apply V test files → `--scorer` runs V (`PASS_TO_PASS` fail → hard 0) → `--read-only` test dirs → `node src/scope-cli.mjs` with hard `--cap`/`--budget-tokens` → (gated arms) `--confirm-scorer` runs C on a clean checkout of the committed pass → record `{arm, instance_id, V, C, T, T_official, resolved, veto_events, passes, tokens, usd, final_commit}` JSONL.

## 5. Cost, infra & the veto-opportunity GATE (codex Q3 — protect the spend)

- **Docker = hard prerequisite.** Feasibility gate first: Docker present + pull/build ONE instance image. If unavailable/too heavy → flag and pause.
- **`$0` dry-run/stub** — fake scorer + stub `act`, mock Docker/test layer; validate wiring with no spend.
- **VETO-OPPORTUNITY AUDIT (before the full paid run):** on a small set, run **baseline (V-only)** to V-pass, then score C and T offline, and measure **P(C or T fails | V passes)**. If that is ≈ 0, there are **no false-done events for the gate to catch** → the A/B is underpowered → **do NOT spend 4×48**; report it, and pivot (sparser/behavior-clustered V, or add deliberate gaming-pressure variants → ties to H2). Only proceed to the full run once the audit shows real `V-pass / (C or T)-fail` cases.
- **Pilot ~5 tasks × arms** after the audit passes; then full ~48.
- **Budget realism (codex):** SWE-EVO scaffolds run up to ~100 iterations; an 8–15 cap may measure *underbudgeting*, not scorer quality. Set the cap high enough to converge (tune on the pilot) while `--budget-tokens` bounds total spend; report token-primary spend per task + aggregate. The operator authorized full autonomous spend but wants the number watched — the audit gate + pilot are the cost firebreaks.
- Editor model held constant across arms (default **sonnet**).

## 6. SWE-EVO facts (research agent; sources in its report)

Public/usable now: HF `Fsoft-AIC/SWE-EVO` (48 rows; license flag: HF apache-2.0 vs repo MIT — reconcile before redistribution), GitHub `SWE-EVO/SWE-EVO` (MIT), arXiv 2512.18470. Metrics verbatim: Resolved = all `FAIL_TO_PASS`+`PASS_TO_PASS` pass; Fix Rate = (PASS_TO_PASS fail → 0) else #passing FAIL_TO_PASS / |FAIL_TO_PASS|; overall = mean over 48. Top: gpt-5.4 ≈ 25% Resolved / ~34% Fix Rate. `FAIL_TO_PASS` size ranges 1–2,770 and `PASS_TO_PASS` 0–6,250 — so **per-task cluster structure varies wildly; the V/C/T builder must handle both tiny and huge test lists** (exclude < 3-cluster tasks).

## 7. Risks / honesty

- **Leak caveat:** V leaks `FAIL_TO_PASS` clusters → numbers are NOT leaderboard-comparable; state everywhere. The capability arm is an **oracle upper bound** ("given full tests as scorer"), not external SWE-EVO performance.
- **Identifiability:** fixed by the V/C/T three-way split + T held out from all arms (§3).
- **NULL / underpowered risk:** handled by the veto-opportunity audit gate *before* big spend (§5).
- **Source leakage:** C/T test bodies must be physically absent from the editor's tree, not just read-only (§4).
- **Contamination:** no-network execution; note editor cutoff vs task dates.
- **Statistical power:** 48 is small; paired bootstrap/permutation CIs; pre-register meaningful Δ.
- **Official-grading divergence:** cross-check T against `evaluate_instance.py` (pilot + samples); pin all versions/digests.
- **Deferred — leaderboard-comparable number:** the standard hidden-test protocol is whetstone's weak spot (no in-loop gradient); deferred to H1b (SWE-bench-Live) or a later sub-task, decided after the A/B result.

## 8. Procedure

✅ research → ✅ design (3-way split, ablation arms) → ✅ codex review (REVISE folded) → TDD the harness (`$0` stub; mock Docker/test) → Docker feasibility gate (1 image) → cluster+split builder + source-isolation verifier → **veto-opportunity audit (cheap, baseline-only)** → if signal: pilot (~5 × 4 arms) → full (~48 × 4 arms) with official-eval cross-check → report (2)−(1), (3)−(2), (3)−(1) on T with CIs + capability + veto rate → commit + push → memory → (decide H1b / leaderboard run).
