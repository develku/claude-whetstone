# Verifier Forge: mutation-backed admit (design)

**Date:** 2026-06-28
**Status:** design → codex review → implementation
**Builds on:** `docs/design/specs/2026-06-27-mutation-backed-admission.md` (the converged DEFERRED note) and frontier 2a (`src/forge/corroborate.mjs` oracle machinery).

## Problem (the finding that motivates it)

`admitCheck` (brick 1) admits a candidate verifier-check iff it **passes the one known-good artifact and
fails the one known-bad artifact**, reproducibly. `bad` is a SINGLE point, so a check can fail it for a
non-generalizing reason — **pointwise overfitting**. The paid multi-file elicitation run surfaced the canonical
case: on a counter, a model proposed `value()===0` on a *fresh* instance. That passes good (fresh value is 0)
and fails the constant-1 bad (fresh value is 1) → `admitCheck` admits it. But it MISSES a sibling bug — a
counter that never increments (`value()` always 0): a fresh `value()` is also 0, so the weak check passes that
broken impl. The check kills the observed bad for the wrong reason.

**Goal:** strengthen admission from "kills the one observed bad snapshot" to "kills a mutant NEIGHBOURHOOD" of
the good artifact — without weakening any existing guarantee and without touching `admit.mjs`.

## Non-goals

- **No history-accumulated bad snapshots (Opt B — REJECTED, per the DEFERRED note).** Requiring the candidate to
  also fail every previously-seen bad snapshot is retrospective *point* accumulation ("also catch the exact
  previous failures"), not generalization, and it pushes artifact-history semantics into admission. The
  backlog's "reject history-accumulated bad snapshots too" = follow this rejection. Mutant-neighbourhood is the
  generalization mechanism; history-accumulation is not built.
- **No new admit gate semantics in `admit.mjs`.** `mutationAdmit` is a WRAPPER injected through `runForge`'s
  existing `admit` seam. `admit.mjs` stays byte-identical.
- **Scope-mode (worktree/`--rel`) mutation deferred.** Placing a mutant at a `--rel` path inside a materialized
  worktree (so the candidate's `--rel` resolves and relative imports still work) is genuinely harder; this MVP
  wires `mutationAdmit` into FILE-mode `runForgeHook` only. Scope-mode mutation is a documented follow-up.

## The mechanism

`mutationAdmit({ candidateCmd, goodArtifact, badArtifact, replayRuns, runCheck, oracleCmds, mutate, target,
mutationKillThreshold, maxMutants })`:

1. `base = await admitCheck({ candidateCmd, goodArtifact, badArtifact, replayRuns, runCheck })`.
   **If `!base.admit` → return `base` verbatim.** The primitive gate is the floor; mutation only ever ADDS
   rejections. (Strictly conservative: `mutationAdmit` never admits anything `admitCheck` rejects — so the gate
   can never be made more permissive. This preserves the DEFERRED note's "inert or hardens" invariant for the
   gate even though admission itself gets stricter.)
2. **No oracle ⇒ cannot strengthen.** If `oracleCmds` is empty, return `base` with a `mutation:{skipped:'no
   oracle'}` annotation. Mutation-backed admit REQUIRES an independent oracle (it reuses 2a's `--forge-oracle`).
   Honest dependency, same as corroboration.
3. Read the GOOD source; `mutate(source)` → a bounded set of textual mutants (operators below). Mutants are
   written to a SIBLING temp file in `dirname(goodArtifact)` (a unique `.forge-mutant-*` name) so relative
   imports in the artifact still resolve; cleaned up in `finally`.
4. **Oracle-filter (the equivalent-mutant defense).** For each oracle, compute `oracle(good)` once; an oracle
   that REJECTS good is unusable (would reject everything) and is excluded. A mutant is a **confirmed
   genuine-bad** iff at least one *usable* oracle REJECTS the mutant. A mutant no usable oracle rejects is
   EXCLUDED (equivalent mutant, or beyond oracle coverage) — it is NOT a required-kill. *This is exactly the
   spec's "oracle-filtered mutants, NOT candidate-I/O filtering": we never ask the candidate whether the mutant
   is bad (that would exclude precisely the sibling behaviour the weak check fails to observe); we ask an
   INDEPENDENT oracle.*
5. **Required-kill check.** If there are zero confirmed-bad mutants → cannot strengthen → return `base` with
   `mutation:{confirmedMutants:0}`. Otherwise, for each confirmed-bad mutant, the candidate KILLS it iff the
   candidate does NOT pass it (`runCheck(candidateCmd, mutantFile).pass === false`; a candidate *throw* on a
   mutant counts as a kill — it did not let the bad through, matching the gate's exit-≠0 ⇒ veto behaviour).
   Admit iff `killed / confirmed >= mutationKillThreshold`.

### Why a threshold, not kill-all

The oracle is typically BROADER than a single candidate check (e.g. oracle = a held-out behavioural spec;
candidate = one io-assert case). A mutant breaking a behaviour *outside* the candidate's intended surface is
oracle-confirmed-bad yet legitimately survives the candidate — kill-all would falsely reject a perfectly good
narrow check. A fractional `mutationKillThreshold` (default **0.5**) requires the candidate to generalize beyond
the single observed point without demanding it cover behaviours it never claimed. The operator dials it via
`--forge-mutation-threshold`. (Honest limit: the threshold is a heuristic, not a proof of generalization; it
raises the bar from "1 point" to "≥ half the oracle-confirmed neighbourhood".)

## Mutation operators (`src/forge/mutate.mjs`, pure)

`mutate(source, { maxMutants = 24 } = {})` applies a fixed operator set and returns
`[{ operator, source: <mutantSource> }]`, deduped, excluding any mutant identical to the input, capped. Textual
(language-agnostic-ish, tuned for JS/TS), deliberately crude — robustness comes from the oracle-filter (a
non-parsing mutant makes the oracle error → excluded; an equivalent mutant makes the oracle accept → excluded),
NOT from the mutator being clever:

| operator | transform |
|---|---|
| `return-constant` | each `return <expr>` → `return 0` / `return null` / `return true` (skip if expr already that constant) |
| `arithmetic-swap` | binary `+ - * /` swapped pairwise at token sites (not `++`/`--`/`+=` etc.) |
| `comparison-flip` | `<`↔`>`, `<=`↔`>=`, `===`↔`!==`, `==`↔`!=` |
| `boolean-flip` | `true`↔`false` |
| `increment-tweak` | `++`→`--` and `--`→`++` (off-by-one in stateful counters/loops) |

Each operator mutates ONE site per emitted mutant (first-site or each-site, capped), so the neighbourhood spans
many small single-point deviations from good. Pure given the source string.

## Change surface (bounded; 7 invariant files UNTOUCHED)

1. `src/forge/mutate.mjs` — NEW: pure mutant generator (`mutate`).
2. `src/forge/mutation-admit.mjs` — NEW: `mutationAdmit` wrapper (imports `admitCheck` from admit.mjs, does not
   modify it) + a default `mutationRunCheck`-free design (reuses injected `runCheck`). Mutant file write/cleanup
   adapter lives here.
3. `src/forge/hook.mjs` — wire: when `cfg.forgeMutationAdmit` is set, the default `admit` injected into
   `runForge` becomes `mutationAdmit` (closing over `scorerRunCheck`, `cfg.forgeOracleCmds`,
   `cfg.forgeMutationThreshold`). Additive; `deps.admit` still overrides for tests.
4. `src/driver.mjs` / `src/cli.mjs` (or wherever single-file flags are parsed) — parse `--forge-mutation-admit`
   and `--forge-mutation-threshold` into `cfg`. (NOT an invariant file.)
5. `test/forge-mutate.test.mjs`, `test/forge-mutation-admit.test.mjs` — NEW.
6. `bench/forge-mutation-ledger.mjs` — NEW, $0: prove the weak `value()===0` check is ADMITTED by `admitCheck`
   but REJECTED by `mutationAdmit`, while a strong sequence check is admitted by both; an equivalent mutant
   (oracle-accepted) never forces a false rejection. `--verify` preflight, exit 1 on regression.
7. `bench/forge-mutation-realmodel.mjs` — NEW (paid): does a real model whose check `mutationAdmit` rejects get
   replaced by a stronger admitted check? (elicitation of the strengthening's effect). Optional but in scope per
   the per-item workflow (item 1 is a learning-capability change).

**UNTOUCHED (7 invariant files):** `loop.mjs`, `forge/run.mjs`, `forge/gate.mjs`, `forge/store.mjs`,
`scorers/composite.mjs`, `forge/prune.mjs`, `forge/admit.mjs`.

## Biggest risk

Equivalent mutants forcing FALSE REJECTIONS of good checks (worse than the harmless status quo) — mitigated by
the oracle-filter: a mutant counts as a required-kill ONLY if an independent oracle rejects it. Perf: each
confirmed mutant is `1 + |oracles|` scorer runs; `maxMutants` + the per-operator cap bound the cost.

## Options considered

- **A) `mutationAdmit` wrapper over `admitCheck`, oracle-filtered mutants (CHOSEN).** `admit.mjs` untouched;
  reuses 2a oracles; strictly conservative on the gate.
- **B) History-accumulated bad snapshots (REJECTED).** Point accumulation, not generalization; artifact-history
  semantics leak into admission (DEFERRED-note convergence).
- **C) Candidate-I/O-filtered mutants (REJECTED).** Excludes exactly the sibling behaviour the weak check failed
  to observe — defeats the purpose.

## Verification

1. `node --test test/*.test.mjs` — all green (457 + new).
2. `node bench/forge-mutation-ledger.mjs --verify` — weak rejected / strong admitted / equivalent-safe.
3. Paid `bench/forge-mutation-realmodel.mjs --model sonnet` — NON-NULL effect.
4. `git diff` confirms the 7 invariant files untouched.

## Codex cross-model review — folded

Codex returned 9 findings (VERDICT: directionally good, two places could "look hardened while admitting the
same weak checks"). Folded:

1. **`{pass}` is lossy — classify outcomes (CRITICAL).** `runCheck` returns only `{pass}`; "a non-parsing
   mutant makes the oracle error → excluded" is NOT implementable from that alone. FOLD: a `classify(runCheck,
   cmd, artifact, runs)` helper catches throws and returns one of `pass | reject | error | flaky`. The default
   `scorerRunCheck` THROWS on a non-zero scorer exit (an unimportable/non-parsing mutant makes io-* `die()` →
   exit 2 → throw), so `error` is cleanly separable from a `{pass:false}` `reject`.
2. **Oracle usability must be reproducible.** A usable oracle is one that `classify(oracle, good) === 'pass'`
   over `replayRuns` (not a single read). A flaky/erroring oracle is excluded.
3. **Candidate THROW is NOT a kill (CRITICAL).** A kill counts ONLY on a clean `classify(candidate, mutant) ===
   'reject'`. A candidate `error` (crash / API-shape break / unimportable mutant) is tracked separately
   (`crashed`) and never satisfies the threshold — otherwise a weak `value()===0` check could crash-kill enough
   `return null` mutants to pass while still missing the real `increment-no-op` mutant (exactly the class this
   feature exists to catch). This reverses the original spec's "throw counts as a kill".
4. **Mutant confirmation is reproducible clean-reject.** A mutant is confirmed-bad iff some usable oracle
   `classify(oracle, mutant) === 'reject'` (reproducible). Oracle `error`/`flaky` on a mutant does NOT confirm
   it → excluded. (This dissolves most of finding 4's distribution pathology: API-breaking mutants make BOTH
   oracle and candidate `error`, so they drop out of numerator AND denominator.)
5. **`minConfirmedMutants` floor (default 2).** If fewer than this many confirmed-bad mutants exist, mutation
   cannot meaningfully strengthen → return base with `mutation:{confirmedMutants:N, note:'below floor'}`. The
   result reports `confirmedMutants / killed / crashed / excluded / oraclesUsable` for transparency (ledgered
   policy, not an opaque 0.5).
6. **Preserve the original extension.** The mutant temp file keeps the good artifact's extension
   (`.forge-mutant-<n><ext>`) so module resolution (`.mjs`/`.cjs`, package `type`) is unchanged. (Basename-derived
   behaviour — `import.meta.url` sidecar lookups — is a documented limitation; Forge artifacts don't rely on it.)
7. **FILE-mode boundary ENFORCED.** If `candidateCmd` or any `oracleCmd` carries `--rel` or `--output`, the
   mutant-`--output` substitution would not actually evaluate the mutant (scope mode, or a fixed-path scorer
   where `arg()` takes the first `--output`). mutationAdmit then SKIPS strengthening with a clear annotation
   (conservative: never falsely rejects, never falsely strengthens). Belt-and-suspenders — file-mode candidate
   cmds carry neither.
8. **No-oracle is a CONFIG ERROR when the flag is explicit.** `--forge-mutation-admit` without `--forge-oracle`
   is refused at CLI parse (mirrors `forgeNeedsStoreAndConfirm`). The library wrapper still defensively returns
   base+`skipped:'no oracle'` (robustness), but the operator cannot silently get false confidence.
9. **Permissiveness invariant by construction.** mutationAdmit calls an injectable `baseAdmit` (default the
   imported `admitCheck`) and returns it verbatim on `!admit`; it only ever ADDS a rejection. So
   `mutationAdmit ⊑ baseAdmit` always (never more permissive than its own base gate).
10. **Opt B (history bads): rejected for THIS build per the operator's explicit instruction, but not zero-value.**
    Codex's nuance: an *oracle-filtered per-family holdout corpus* is a cheap regression complement (not the core
    generalization mechanism). Recorded as a documented future option; not built tonight.

### Revised wrapper signature

```
mutationAdmit({ candidateCmd, goodArtifact, badArtifact, replayRuns = 2, runCheck, oracleCmds = [],
                mutationKillThreshold = 0.5, minConfirmedMutants = 2, maxMutants = 24,
                baseAdmit = admitCheck, mutate = defaultMutate,
                prepareMutant = defaultPrepareMutant, cleanupMutants = defaultCleanupMutants })
  -> { admit, reason, mutation: { confirmedMutants, killed, crashed, excluded, oraclesUsable, threshold, skipped? } }
```
