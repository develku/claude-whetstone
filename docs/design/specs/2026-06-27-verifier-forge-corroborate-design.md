# Verifier Forge — frontier 2a: differential corroboration

> Status: **implemented** (2026-06-27). The Forge (bricks 1–4b + retirement) is complete and proven; the
> brittleness ceiling is closed (`contains` 8/8 → `io-assert` 0/5). This addresses the **deeper, separate**
> ceiling the cross-model review named as the sharpest open criticism: **"confirm = ground truth."**

## Why this

There is a **single** confirm oracle, and the Forge faithfully distils whatever it believes into permanent
cheap checks. If that one oracle is **wrong** — a buggy or over-strict proxy that vetoes genuinely-correct
code — the Forge bakes the mistake into a check that rejects correct code forever. `io-assert` fixed
*brittleness* (textual checks fossilizing a phrasing), not this *oracle-dependence*: in fact `io-assert`
faithfully fossilizes a **buggy** confirm when the good/bad artifacts differ behaviourally (it only can't when
they are behaviourally identical, where it fails admission anyway).

## The decision (one line)

Before the Forge LEARNS from a veto, require ≥1 **independent operator-trusted oracle** to corroborate the
good/bad labelling. On any **stable** oracle's dissent the veto is suspect → the Forge **declines** to learn
(returns early, before the paid generate — $0). No oracle configured → today's single-oracle behaviour.

## Agreement rule — unanimity, with flaky-oracle exclusion

- **Unanimity**: any stable oracle that disputes the labelling declines learning. Justified by asymmetry — a
  false-decline costs one cheap, recoverable check; a false-learn fossilizes a wrong veto **permanently**. (A
  quorum/majority would be *worse* here: under the design's own correlated-error caveat, a majority can be
  wrong together and would then ADMIT a wrong-grounded check unanimity declines.)
- **Flaky-oracle exclusion (the load-bearing subtlety)**: an oracle whose **own** verdict is not reproducible
  across `replayRuns` is **excluded** from the quorum and reported separately — it is **NOT** counted as a
  dissent. Otherwise one noisy oracle would silently veto *all* future learning (a permanent kill-switch —
  strictly worse than the ceiling this fixes). Corroboration is judged over the **stable** oracles only.
- A "dissent" is: the oracle **rejects the good** artifact, or **accepts the bad** artifact.

## Architecture — one new pure module + thin wiring (loop.mjs untouched)

**`src/forge/corroborate.mjs`** (mirrors `admit.mjs`; stdlib-only, import-independent):
```
corroborateLabels({ goodArtifact, badArtifact, oracleCmds = [], replayRuns = 2, runCheck })
  -> { corroborated, conflicts: [{ oracleCmd, reason }], excluded: [{ oracleCmd, reason }], checked }
```
Copies `admit.mjs`'s `replay(runCheck, cmd, artifact, runs) -> {pass, unstable}`. For each oracle: replay
good then bad; `unstable` → push to `excluded` (non-blocking); else `!good.pass` or `bad.pass` → push to
`conflicts` (blocking). `corroborated = conflicts.length === 0`. Empty `oracleCmds` → trivially corroborated.

**`src/forge/run.mjs` `runForge`** — corroboration is a **precondition before `generate`**. The decline arm
returns the **FULL** existing shape with empty/zero defaults plus the additive fields, so every consumer
(`driver.mjs`, the bench harnesses) keeps working:
```js
return { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: corr.conflicts, excluded, corroborated: false }
```
The success arm adds `conflicts: [], excluded, corroborated: true`.

**`src/forge/hook.mjs` `runForgeHook`** — injects `corroborate = (a) => corroborateLabels({ ...a, runCheck:
scorerRunCheck })` and passes `oracleCmds: cfg.forgeOracleCmds ?? []`.

**`src/driver.mjs`** — `parseCli` collects the **repeatable** `--forge-oracle "<scorer cmd>"` via a new
`getAll` helper (oracle values are full command strings with commas/spaces, so they must repeat, not
comma-split). `runPrepared` logs a distinct **`forge-declined`** status when `corroborated === false` (so a
healthy decline is not mistaken for a 0-admitted no-op or a `forge-error`).

## Trust-boundary invariant (do not "harden" this away)

`--forge-oracle` commands are **operator-authored** (same trust class as `--confirm-scorer`/`--scorer`) and run
**verbatim** via `scorerRunCheck`. They intentionally **do NOT** pass through `forgeAllowlist` /
`FORGE_UNSAFE_SCORERS`, which gate **model-proposed** checks. A future security pass must not route them through
the denylist "for consistency" — that would break command-executing oracles the operator legitimately trusts.

## Measurement (measure → fix → re-measure)

`bench/forge-corroborate-ledger.mjs` — deterministic, **$0** (a generate stub stands in for the discriminating
check a proposer learns; admit + corroborate run the real scorers). Each scenario encodes a **buggy primary
confirm** that accepted a gamed-to-its-bug "good" and vetoed the genuinely-correct "bad":

| arm | K | fossilizes correct code? |
|---|---|---|
| BEFORE (no oracle) | 1 | **2/2 YES** |
| AFTER (`--forge-oracle` = correct behavioural oracle) | 0 | **0/2** — declined, conflict flagged |

Result: **2/2 wrong-oracle fossilizations → 0/2, 2/2 clean declines.**

## Honest scope

REDUCES single-oracle single-point-of-failure for the *learn* decision and surfaces conflicts. Does **NOT**
escape needing *some* trusted measure (you now trust ensemble **agreement**); does nothing for **correlated**
errors (every oracle wrong the same way); degrades safely to today's behaviour when no `--forge-oracle` is set.

## Out of scope

- **Auto-discovering oracles** from `--scorer-allow` — explicit `--forge-oracle` only (operator-trusted).
- **Weighting / soft quorum** — YAGNI; unanimity over stable oracles is the thesis.
- **Scope-mode Forge** — still deferred (and `--forge` is now refused on `--scope` runs).
