# Whetstone Quality Loop — Runbook

A continuous, orchestrated loop that raises whetstone's **own** quality by applying
the project's core thesis to itself: **code owns the gate.** Each cycle discovers
issues, verifies they are real, fixes the confirmed ones under TDD, and accepts
only what keeps the test suite green and the invariant tripwire intact.

This runbook makes the loop repeatable across fresh sessions. A new session reads
this file + `findings-register.md` and can run the next cycle cold.

---

## The Gate — code-owned acceptance (non-negotiable)

A fix is **accepted** only if ALL hold:

1. `npm test` exits 0 — every test green, **including** `test/converge-invariant.test.mjs`
   (the SHA256 byte-identity tripwire over the 8 core files).
2. The **8 invariant files are byte-unchanged**:
   - `src/gate.mjs`, `src/loop.mjs`
   - `src/forge/run.mjs`, `src/forge/gate.mjs`, `src/forge/store.mjs`,
     `src/forge/prune.mjs`, `src/forge/admit.mjs`
   - `scorers/composite.mjs`
   A fix that genuinely needs one of these → **STOP**. Route to the operator + the
   `debate-critique-agreement` (DCA) gate; the expected hash in the tripwire test is
   bumped deliberately, never autonomously.
3. **No existing assertion weakened or deleted.** New tests may be added. A refactor
   must be behavior-preserving ⇒ the existing suite passes **unchanged** (you do not
   edit a test to make a refactor pass). Reviewer-verified each cycle.
4. **Coverage ≥ baseline** (soft ratchet). Run `npm run coverage`; the `all files`
   aggregate (line / branch / function) must not drop below the register's recorded
   baseline.

Discovery is LLM-driven and fuzzy; **acceptance is code and deterministic.** The loop
cannot game itself: it cannot edit the gate (tripwire blocks the 8 core files), and
it must not weaken test assertions (reviewer-guarded).

---

## Per-cycle procedure

Each cycle = one discovery/verify Workflow + gated fixes + commits.

1. **DISCOVER** — one Workflow, parallel per-axis finders, loop-until-dry:
   - *correctness* — `power-code-reviewer` on the highest-risk non-invariant modules.
   - *security* — `security-auditor` on the trust boundary (`iso-*`, `scorer-safety`,
     `prompt-fence`, `safe-rel`, `act-claude` stdout parsing).
   - *simplification* — duplication / long-function / deep-nesting scan.
   - *coverage* — weak branch/function coverage from `npm run coverage` (NOT
     "missing test file" — most modules are covered via integration tests).
2. **TRIAGE / VERIFY** — adversarial: each finding gets an independent skeptic
   (refute-by-default). Drop plausible-but-wrong. Dedup against the register. Rank by
   severity. A "simplification" that would change behavior is rejected.
3. **FIX** — confirmed CRITICAL/HIGH first, TDD (failing test → fix → green),
   surgical, **non-invariant files only**.
4. **VERIFY** — `npm test` green + tripwire intact + `power-code-reviewer` confirms no
   weakened assertions + `npm run coverage` ≥ baseline. Ratchet the baseline up when
   coverage improves.
5. **COMMIT** — one conventional commit per verified fix, decision-provenance body
   (options considered + chosen rationale per the operator's plan-mode conventions).
6. **RECORD** — update `findings-register.md` (status transitions), append a cycle log
   entry below.
7. **RECUR** — `ScheduleWakeup` → next cycle (self-paced `/loop`).

---

## Safety rails

- All loop work on the `quality-loop` branch; PR per cycle (or small batch) for the
  operator to review/merge. `main` stays clean.
- Never edit the 8 invariant files or `test/converge-invariant.test.mjs` autonomously.
- Never weaken an existing assertion to make a change pass.
- Zero new runtime dependencies (the repo ships with none; coverage uses Node's
  built-in `--experimental-test-coverage`).
- Verify firsthand (run tests / read source) — do not trust agent claims unreviewed.

---

## Commands

```bash
npm test        # the gate: node --test test/*.test.mjs
npm run coverage # baseline ratchet: line/branch/function aggregate over src + scorers
```

---

## Cycle log

| Cycle | Date | Axes worked | Findings confirmed | Fixed | Coverage (L/B/F) | Notes |
|-------|------|-------------|--------------------|-------|------------------|-------|
| 0 (setup) | 2026-06-30 | — | — | — | 96.03 / 82.15 / 91.83 | Harness + symlink fix landed; baseline captured. |
| 1 | 2026-06-30 | all four | 12 (of 13 candidates) | 11 | 96.10 / 82.54 / 92.12 | 4-axis adversarial Workflow. HIGH budget-non-enforcement (C1-01), MEDIUM escalation-inversion (C1-02) + symlink-escape (C1-03), 2 dead exports, 6 trust-boundary coverage guards. 2 rejected by adversarial verify (path-containment unify, git-helper dup). Gate stayed green throughout; 8 invariant files byte-unchanged. |
| 2 | 2026-06-30 | all four | 12 (of 14 candidates) | 9 | 96.27 / 82.89 / 92.28 | Deeper audit of the cycle-1-untouched surface (planner/outer/iso-*/batch internals), dedup vs the register (0 re-reported). MEDIUM lone-survivor singleton-quarantine starvation (C2-01), LOW outer-cli crash-on-replan-refusal (C2-02) + diagnostics comment (C2-03), 6 safety/forge-defense coverage guards. 4 not-worth/rejected by verify (incl. one rejected for being defensive code for an impossible state, per the operator rule). Gate green; 8 invariant files byte-unchanged. |
| 3 | 2026-06-30 | all four | 6 (of 11 candidates) | 5 | 96.31 / 83.11 / 93.73 | Deep audit of the forge non-invariant modules + iso sandbox + canonical-data inertness. **HIGH model-authored RCE** (C3-01): the Forge proposable-scorer denylist had drifted from plan's (missing floor + llm-judge → arbitrary command exec via floor's second shell, proven end-to-end); root-cause fix = single canonical SHELL_SCORERS in scorer-safety.mjs. +4 forge coverage guards. The forge-core / tournament / driver-core / converge-core correctness audits came back NEGATIVE (sound). 1 not-worth (deliberate pure-seam export). Gate green; 8 invariant files byte-unchanged. |
