# SWE-EVO benchmark adapter (H1)

Runs whetstone's scope-mode loop on real SWE-EVO repo tasks to answer one question: **does the
code-owned gate raise held-out truth?** — i.e. is the gated arm's Fix-Rate on a truth set *the editor
never sees* higher than a baseline that gates on the visible scorer alone.

Design + codex review: [`docs/superpowers/specs/2026-06-28-h1-benchmark-adapter-design.md`](../../docs/superpowers/specs/2026-06-28-h1-benchmark-adapter-design.md).
Part of the **H → C → B → A** re-plan ([`docs/2026-06-28-loop-engineering-competitive-positioning.md`](../../docs/2026-06-28-loop-engineering-competitive-positioning.md)).

## Why a manufactured scorer

SWE-EVO (like every SWE-bench-style benchmark) **holds its grading tests out from the agent**. But
whetstone's loop needs an in-loop scorer with a gradient. So we **manufacture** one by splitting each
task's `FAIL_TO_PASS` tests into three disjoint behaviour clusters:

- **V (visible)** — the in-loop scorer for ALL arms (the editor's gradient).
- **C (confirm)** — the held-out finish-line check for the gated arms (source-isolated).
- **T (truth)** — held out from EVERY arm; the final grade. T-held-out-from-all is what makes the
  gated-vs-baseline Δ **identifiable** (codex REVISE, thread `019f0bf3`): a positive Δ means the gate
  generalized, not that it had oracle access.

`PASS_TO_PASS` regression applies in every metric (any P2P fail → Fix-Rate 0, per SWE-EVO Eq. 1).

## Modules

| File | Role | $0-tested |
|---|---|---|
| `split.mjs` | V/C/T behaviour-cluster split (file-level; excludes <3-file tasks) | yes |
| `test-patch.mjs` | gold `test_patch` splitter — applies only an arm's test files (source isolation) | yes |
| `fixrate.mjs` | SWE-EVO Eq. 1 Fix-Rate + `isResolved`, pure | yes |
| `dataset.mjs` | HF `Fsoft-AIC/SWE-EVO` loader (dataset-viewer, pinned SHA, zero-dep) | core yes |
| `scorer.mjs` | the V/C/T scorer CLI — bridges a results map to whetstone's `--scorer`/`--confirm-scorer` | yes |
| `runner.mjs` | per-instance Docker test runner + faithful `parse_log_pytest` port | parser/script yes; Docker in feasibility |
| `ab.mjs` | the 4-arm A/B orchestration core (injectable seams) | yes |

## Arms (same editor model / effort / budget)

1. **baseline** — gate on V only.
2. **+confirm** — V + held-out C confirm (forge OFF).
3. **+confirm+forge** — V + C + the Verifier Forge (the full gate).
4. **capability** — V scorer = the full suite (oracle upper bound; **NOT** an external SWE-EVO number).

Headline outputs, all graded on T: `(2)−(1)` = confirm contribution, `(3)−(2)` = forge marginal,
`(3)−(1)` = full-gate ΔFix-Rate; plus confirm-veto rate and paired bootstrap CIs.

## Dataset

Pinned via [`data/PINNED.json`](data/) (records the HF dataset commit SHA). Rebuild the local cache:

```bash
node bench/swe-evo/dataset.mjs --fetch    # one-time; writes data/instances-<sha>.json (gitignored, ~7.5MB)
node bench/swe-evo/dataset.mjs --list      # print the cached instances + cluster sizes
```

The cache is rebuildable and gitignored; only the small `PINNED.json` is tracked. The scored run reads
the cache **synchronously** — no network during editing/scoring (codex Q4: no-network execution).

## Cost firebreaks (run order)

1. **$0 stub** — `node bench/swe-evo/ab.mjs --stub` proves the orchestration with no editor / no Docker.
2. **Docker feasibility** — pull one image, validate the runner end-to-end (and **measure emulated
   test-run time** — the images are `x86_64`; on Apple Silicon they run under emulation).
3. **Veto-opportunity audit** (baseline-only) — measure `P(C or T fails | V passes)`. If ≈ 0 there are
   no false-done events for the gate to catch → the A/B is underpowered → report + pivot, do **not**
   spend 4×N.
4. **Pilot** (~5 × 4 arms) → **full** (~N × 4 arms) with the official `evaluate_instance.py` cross-check.

## Running the paid A/B (from a plain terminal)

Launch from a normal shell, **not** nested inside another Claude Code session — nested `claude -p`
intermittently exits non-zero (~1 in 5), a session/env artifact. `run-ab.mjs` retries an arm up to 3×
on that transient error, but a terminal avoids it entirely and has no 10-min wrapper cap.

```bash
# 0. one-time: dataset cache + pull the images you'll touch (amd64, ~1-3GB each)
node bench/swe-evo/dataset.mjs --fetch
node bench/swe-evo/dataset.mjs --list                 # the 18 eligible instances

# 1. veto-opportunity AUDIT (the firebreak) — baseline-only on ~5 instances
node bench/swe-evo/run-ab.mjs --audit \
  --instances <id1>,<id2>,<id3>,<id4>,<id5> \
  --cap 15 --budget-tokens 2000000 --model sonnet \
  --out .loop/swe-evo-work/audit.jsonl
#   -> reports P(C or T fail | V pass). If ≈0  => UNDERPOWERED, do NOT run the full matrix.

# 2. only if the audit shows real V-pass/(C|T)-fail cases: the full 4-arm A/B
node bench/swe-evo/run-ab.mjs --run --cap 15 --budget-tokens 2000000 --model sonnet \
  --out .loop/swe-evo-work/full.jsonl

# 3. the headline
node bench/swe-evo/report.mjs .loop/swe-evo-work/full.jsonl
```

Per-instance images must be pulled first (`docker pull --platform linux/amd64 <image>`); the run uses
`--network none` for test execution and assumes the image is local. Rough cost: a scoring run ≈10s
(emulated); an arm is `cap`×(editor + ~10s); the full matrix is 18 inst × 4 arms.

## Findings

- **Eligibility:** with file-level clustering, **18 / 48** instances have ≥3 `FAIL_TO_PASS` files (the
  V/C/T split requirement); the other 30 are excluded. 1 instance ≈ 5.6pp at n=18. A function-level
  (AST-redacted) re-cluster could recover more, at more source-isolation surface — decided after the audit.
- **Source isolation — design B (chosen, feasibility-forced):** the editor's tree is **base only** (it
  never sees any gold test file → isolation is total and automatic), and the runner applies the **full**
  gold `test_patch` in its ephemeral container (so `PASS_TO_PASS` always has its gold test code). This was
  forced by a real collision the feasibility run surfaced: F2P and P2P nodes routinely share a parametrized
  test file, so a per-arm test-file slice strips the gold code a P2P node needs and forges a false
  regression. Arms differ only in *which nodes each scorer grades* + *run-scope*, never in which test files
  exist. Cost: the editor can't *read* V's tests to overfit — the **NULL risk** the veto audit measures. If
  the audit shows ≈0 gaming, the fallback is design A (readable V tests via AST-redaction).
- **Feasibility validated (dvc 2.5.0, real image):** gold patch → V/C/T all 100 (resolved); base → V=0
  (real signal); ~10s per scoring run under amd64 emulation (Rosetta). `/testbed` HEAD = base_commit;
  pytest in the `testbed` conda env.
