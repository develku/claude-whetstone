# Whetstone Dogfood — External Target: tracegram

A **meta-dogfood loop**: use whetstone on a *real external project* (tracegram), capture
the friction during the upgrade, and feed it back to improve whetstone itself.

```
A) whetstone upgrades tracegram        (real external target — not whetstone's own gate)
B) collect friction artifacts          (where whet helped / where it fought the operator)
C) feed friction -> whetstone backlog   (the tool learns from real use)
```

Why this matters: the loop benchmark was NULL (real editors rarely game trivial bugs) and
the bootstrap was only proven on whetstone's *own* `$0` npm-test gate. tracegram is the **first
real external dogfood** — the missing evidence class. Confirmed whetstone changes graduate into
`findings-register.md`; this file is the raw friction-capture layer that feeds it.

Related: [`RUNBOOK.md`](./RUNBOOK.md) · [`findings-register.md`](./findings-register.md)

---

## Run log

| # | Date | Target | Gate | Model | Verdict | Tokens / $ |
|---|------|--------|------|-------|---------|------------|
| 1 | 2026-06-30 | tracegram recall: group index by type | `uv run pytest` (RED authored) | sonnet | **DONE @ pass 1, verified** | 122,067 tok / $0.29 |

---

## Run 1 — recall index grouped by type

**Target:** `tracegram` @ branch `feat/recall-grouped-index`
**Artifact (single file whet edits):** `plugin/hooks/scripts/recall.sh`
**Goal:** group the SessionStart canon index under `### <type>` section headers in fixed order
(user → feedback → project → reference), header only for types present, preserving the
total-count header and the `- name [type] — desc` line format.
**Gate (human-authored RED, the load-bearing artifact):** `tests/test_recall_hook.py`
- `test_index_grouped_by_type_section_headers` — grouping + fixed order + membership
- `test_grouping_omits_absent_type_sections` — anti-gaming: no empty headers for absent types
- RED confirmed: `2 failed, 10 passed` before the run.

### Friction log (Phase B — filled during/after the run)

Setup phase (before the paid loop):
- **F1 — gate authoring is 100% manual and demands adversarial thinking.** whetstone's whole
  value is bounded by gate quality, yet it gives the operator *no help* authoring or
  stress-testing the gate. I had to hand-write a separate anti-gaming negative test to block the
  "emit four empty headers" dodge. → candidate: a pre-run "gate stress-test" that mutates the
  artifact to probe whether a proposed gate is gameable (relates to the Forge / mutation-admit work).
- **F2 — cross-repo invocation is manual and unguarded.** Pointing whet at a repo other than the
  cwd means absolute paths everywhere, a scorer that must `cd` into the target, and a *manual*
  check that the target's permission surface isn't broad (whet.md SAFETY). → candidate:
  `--target-repo` convenience + an automatic permission-surface preflight warning.
- **F3 — `/whet` is unavailable until a CC restart after (re)install.** First-time/just-updated
  users can't immediately use the slash command. → candidate: surface a "restart to load /whet"
  hint on install; document it.

Run phase:
- **F4 — HIGH — the bundled `test-pass-rate` scorer is node:test-only, not "the most portable scorer."**
  First paid run ERRORED at the scorer (0 tokens, editor never spawned): `could not parse
  pass/fail counts from the test output`. Root cause: `scorers/test-pass-rate.mjs` is hardwired
  to `node --test` END-TO-END — count parse `/(?:ℹ|#)\s*pass\s+(\d+)/`, failure-detail marker
  `✖ failing tests:`, and `--only` → `--test-name-pattern` (node's flag; pytest uses `-k`).
  pytest emits `2 failed, 98 passed in 1.27s` → no match. The file's own header calls it "the most
  portable scorer"; the README positions whetstone as domain-agnostic. **Reality: any
  pytest/jest/go-test project can't use the bundled deterministic scorer.** → graduate to
  `findings-register.md`. Fix options: (a) `--pass-pattern`/`--fail-pattern`/`--only-flag` config,
  (b) auto-detect pytest/jest/go-test/node:test, (c) ship per-runner reference scorers.
  Unblocked this run with a 40-line prototype `pytest-pass-rate.mjs` (scratchpad) honoring the
  scorer contract — verified $0 on the RED state (score 98, 2 findings, assertion-detail critique).
  The prototype is the seed for the whetstone fix.

### Result (verified)

- Trajectory `#0=98 #1=100 | done` — whet drove `recall.sh` to GREEN in **1 editor pass**,
  122,067 tok / $0.29, within cap 8.
- **Independently verified** (not trusting the loop's "done"): full suite `100 passed`; read the
  `recall.sh` diff — a genuine fixed-order grouping loop that emits `### <type>` only when the
  type is present (`if [[ -n "$section" ]]`). No fixture-hardcoding, no gaming. The anti-gaming
  negative test held.
- **Positive signal** for the NULL-benchmark question: on a real external target with a real
  (non-trivial, anti-gaming-guarded) gate, whet produced a genuine solution. (Caveat: the task was
  well-specified and non-adversarial, so this does not retire the gaming-pressure NULL.)
- **F5 — LOW — driver mode does no built-in adversarial gaming-check or diff surfacing.** The
  operator must independently re-run the suite and read the diff to trust "done"; the driver prints
  only score + trajectory. The Forge/confirm machinery exists but isn't engaged in a plain driver
  run. Acceptable by design, but a trust-UX gap for first-time external use.

### Whetstone feedback candidates (Phase C)

- **F4 → FIXED + graduated (`findings-register.md` DF-01).** Made the bundled `test-pass-rate.mjs`
  multi-runner via TDD (5 RED tests → GREEN): `parseCounts()` tries node:test patterns first
  (byte-identical behavior) then pytest (`N passed/failed`, collection `N error` = failure);
  `failureDetail()` + `failingNames()` gained pytest branches. Full suite **999/999**, coverage
  ≥ ratchet (branch 83.48→83.52), invariant tripwire intact (scorer is not an invariant file).
  **End-to-end proof:** the *bundled* (not prototype) scorer on the real tracegram suite →
  `score 100, "all 100 tests pass"`. The scratchpad prototype was the seed and is now superseded.
  Branch `feat/portable-test-scorer`.
- F1 (gate-authoring help / mutation-based gate stress-test) — open, relates to the Forge.
- F2 (`--target-repo` + permission-surface preflight) — open.
- F3 (`/whet` restart hint on install) — open, low.
- F5 (driver-mode built-in gaming-check / diff surfacing) — open, low.
