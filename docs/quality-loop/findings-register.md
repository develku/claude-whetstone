# Whetstone Quality Loop — Findings Register

Persistent, cross-cycle registry of quality findings. The loop dedups against this
so cycles don't re-surface known items. See `RUNBOOK.md` for the process.

**Status values:** `open` (found, not yet verified) · `verified` (adversarially
confirmed real) · `fixed` (resolved + committed + gate green) · `deferred` (real but
postponed, with reason) · `wontfix` (rejected — not a real issue / behavior is
intentional / not worth the cost).

**Severity:** CRITICAL · HIGH · MEDIUM · LOW.

---

## Coverage baseline (ratchet floor)

Captured 2026-06-30 via `npm run coverage` (src + scorers, deterministic):

| Metric | Baseline |
|--------|----------|
| Line | **96.03%** |
| Branch | **82.15%** |
| Function | **91.83%** |

The loop must not drop below these; ratchet upward as coverage improves.

---

## Register

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| Q-001 | coverage | — | (whole repo) | wontfix | **Audit overclaim corrected.** Setup audit claimed "17 untested modules / no coverage tool"; measurement shows 96% line coverage — modules are exercised via integration tests, not dedicated unit files. Premise invalid. |
| Q-002 | coverage | MEDIUM | `scorers/io-trace.mjs` | open | Branch coverage 36.84% — lowest in the repo. Stable, security-relevant (runs in isolation). Candidate for branch-coverage tests. |
| Q-003 | coverage | MEDIUM | `scorers/io-effect.mjs` | open | Branch coverage 55.00%. Same class as Q-002 (side-effect/sink trace scorer). |
| Q-004 | correctness/security | MEDIUM | `src/act-claude.mjs` | open | Cost/token regex parsing of `claude` stdout (97% line-covered, but verify malformed-output edge cases; it is the cost-accounting path). |
| Q-005 | simplification | LOW | `src/safe-rel.mjs`, `src/plan-resolve.mjs`, `src/scope-cli.mjs` | open | Audit flagged 3-way path-containment duplication. **VERIFY FIRST** — the realpath difference (safe-rel re-checks, plan-resolve stays pure) may be intentional per the security model; unifying could change semantics. Reject if so. |
| Q-006 | coverage | LOW | `src/outer-cli.mjs`, `src/replan-cli.mjs`, `src/plan-cli.mjs` | deferred | Function coverage 64–71% on alpha-tier CLIs (Track A / dynamic control plane, operator-marked alpha-unsupported). Lower value until those graduate. |
| Q-007 | security | LOW | `src/iso-frame.mjs` | open | Theoretical frame-forgery: nonce extraction via `indexOf` twice; 16-hex-char random nonce makes collision implausible. Verify, likely wontfix. |

---

## How findings enter

Cycle DISCOVER + TRIAGE appends new rows here (next id continues the sequence).
Each fix flips a row to `fixed` and lands a commit referencing the id.
