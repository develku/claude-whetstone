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

Via `npm run coverage` (src + scorers, deterministic). Ratcheted up by cycle 1.

| Metric | Cycle 0 (2026-06-30) | Cycle 1 (2026-06-30) |
|--------|----------------------|----------------------|
| Line | 96.03% | **96.10%** |
| Branch | 82.15% | **82.54%** |
| Function | 91.83% | **92.12%** |

The loop must not drop below the latest column; ratchet upward as coverage improves.

---

## Register

### Seeds (cycle 0)

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| Q-001 | coverage | — | (whole repo) | wontfix | **Audit overclaim corrected.** Setup audit claimed "17 untested modules / no coverage tool"; measurement shows 96% line coverage — modules are exercised via integration tests, not dedicated unit files. Premise invalid. |
| Q-002 | coverage | LOW | `scorers/io-trace.mjs` | fixed | Branch 37%→50%; CLI guard tests added (cycle 1, `86c92e1`). |
| Q-003 | coverage | LOW | `scorers/io-effect.mjs` | fixed | Branch 55%→58%; scalar `--expect-returns` guard test added (cycle 1, `86c92e1`). |
| Q-004 | correctness/security | MEDIUM | `src/act-claude.mjs` | fixed | NaN-coercion `|| 0` guard pinned for present-but-non-numeric cost/token fields (cycle 1, `86c92e1`). |
| Q-005 | simplification | LOW | `src/safe-rel.mjs`, `src/plan-resolve.mjs`, `src/scope-cli.mjs` | wontfix | Adversarial verify CONFIRMED the differences are load-bearing (throw-vs-null, realpath-vs-pure, root-allowed-vs-rejected); unifying would re-open the symlink import-RCE the io-* epic closed. No change. |
| Q-006 | coverage | LOW | `src/outer-cli.mjs`, `src/replan-cli.mjs`, `src/plan-cli.mjs` | deferred | Function coverage 64–71% on alpha-tier CLIs (Track A / dynamic control plane, operator-marked alpha-unsupported). Lower value until those graduate. |
| Q-007 | security | LOW | `src/iso-frame.mjs` | open | Theoretical frame-forgery: nonce extraction via `indexOf` twice; 16-hex-char random nonce makes collision implausible. Not re-surfaced by the cycle-1 security finder. Verify next cycle, likely wontfix. |

### Cycle 1 (2026-06-30) — adversarial 4-axis audit (13 candidates → 12 verified → 11 fixed)

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| C1-01 | correctness | HIGH | `src/converge-state.mjs` | fixed | Manifest-declared global budget was validated then dropped (enforcement read cfg only) → unattended fan-out ran with no pool cap. Folded manifest budget into `initConvergeState` (`3d4f426`). |
| C1-02 | correctness | MEDIUM | `src/converge-cli.mjs` | fixed | `noEscalate: argv.includes()` forced `false`, killing the `?? true` default → converge children escalated (cost 2×) and diverged from outer-cli. CLI now yields `undefined`-when-absent (`0a67eee`). |
| C1-03 | security | MEDIUM | `src/state.mjs` | fixed | `safeSnapshotPath` was realpath-blind → in-dir symlink escaped containment on `--resume`. Mirrored `safe-rel.mjs` realpath re-check (`9547a4d`). |
| C1-04 | simplification | LOW | `src/state.mjs` | fixed | Dead export `setStatus` (zero callers) removed (`1c934c3`). |
| C1-05 | simplification | LOW | `src/state.mjs` | fixed | Dead export `snapshotExists` + orphaned `existsSync` import removed (`1c934c3`). |
| C1-06 | coverage | LOW | `scorers/io-trace.mjs` | fixed | = Q-002 (`86c92e1`). |
| C1-07 | coverage | MEDIUM | `scorers/floor.mjs` | fixed | Chained `--and` confirm error escalations (crash / non-JSON → exit 2) pinned; branch 72%→81% (`86c92e1`). |
| C1-08 | coverage | MEDIUM | `src/act-claude.mjs` | fixed | = Q-004 (`86c92e1`). |
| C1-09 | coverage | LOW | `scorers/contains.mjs` | fixed | Unreadable `--output` → exit 2 (not silent score 0); branch 71%→83% (`86c92e1`). |
| C1-10 | coverage | LOW | `scorers/test-pass-rate.mjs` | fixed | `pass 0 + fail 0` (zero tests) → exit 2, not NaN score (`86c92e1`). |
| C1-11 | coverage | LOW | `scorers/io-effect.mjs` | fixed | = Q-003 (`86c92e1`). |
| C1-12 | simplification | LOW | `src/git-snapshot.mjs` (+3) | wontfix | 4 byte-identical private `git` exec helpers — adversarial verify REJECTED unification: intentional tolerated duplication (clarity > reuse; the converge modules deliberately avoid the import cycle a shared helper would add). |
| C1-13 | correctness | LOW | `src/outer-cli.mjs` (+ other `*-cli.mjs`) | deferred | Surfaced by the cycle-1 review: the non-`driver` CLI entry guards still use the lexical-only `import.meta.url === pathToFileURL(argv[1]).href` (no realpath fallback), so a symlinked launch silently no-ops — the same class the driver fix (`5e9117f`) closed. NOT a live bug: only `driver` is the package `bin`; the others are invoked by absolute path via the `whet` router. Latent consistency gap; revisit if any becomes a bin entry. |

---

## How findings enter

Cycle DISCOVER + TRIAGE appends new rows here (next id continues the sequence).
Each fix flips a row to `fixed` and lands a commit referencing the id.
