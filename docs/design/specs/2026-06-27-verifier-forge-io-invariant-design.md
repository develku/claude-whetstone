# Verifier Forge "2b-extended": `io-invariant` property scorer (design)

**Date:** 2026-06-27
**Status:** approved (codex-revised) → implementation
**Cross-model review:** codex (gpt-5.5, xhigh) session `019f0936-2b63-7002-b180-358337912b24` — VERDICT REVISE, 9 changes folded in.

## Problem

`io-assert` (behavioural, pure-fn) needs the **exact** output for every `--case`. Many honest outputs cannot be
pinned exactly — non-deterministic ordering, input-dependent, or large — yet still obey a structural **property**
a gamed implementation violates. Classic example: a sort `f([3,1,2])`. In general you want to assert "output is
sorted **and** a permutation of the input" so the check passes ANY correct sort and fails `return input`
(not sorted) or `return [1,2,3]` (not a permutation of an arbitrary input). `io-assert` can't express that;
`contains` (textual) is brittle. `io-invariant` fills the gap with **named, AND-combined invariants**.

## Non-goals

- No general expression/predicate language (YAGNI). A fixed, extensible set of named invariants only.
- Does **not** strengthen the admit gate beyond its existing "pass-good + fail-the-observed-bad" guarantee.
  An over-strong invariant that would falsely veto a *future* honest implementation is NOT caught by admit
  (admit proves discrimination on one snapshot, not semantic correctness) — that is the separately-deferred
  **mutation-backed admit**. Mitigation here: the ledger's non-brittle leg (must pass an *alternate* honest impl).

## Design

New `scorers/io-invariant.mjs`, same skeleton as the other DATA-only scorers (`--output` + optional `--rel` via
`resolveOutput`, JSON-only args, exported pure core + CLI guard, `{score,critique,findings}` JSON, pass=100/
fail=0, exit 2 on **scorer** error). Composes via `composite.mjs` (MIN) exactly like `io-assert`/`io-trace`.

### CLI

```
io-invariant --output <root> [--rel <file>] --fn <exportedFn>
  --case '<JSON arg-list>'     (repeatable; arg list is SPREAD like io-assert — a unary array fn is DOUBLE-wrapped)
  --invariant '<name>'         (repeatable; ALL must hold; some take inline JSON params after ':')
  [--basis <argIndex>]         (default 0; which argument the input-referencing invariants compare against)
```

**Unary-array UX trap (codex #3):** because the arg list is spread, a sort case is `--case '[[3,1,2]]'`
(outer = arg list, inner = the array argument), **not** `'[3,1,2]'` (which would call `f(3,1,2)`). The usage
hint and tests state this explicitly, or a model will routinely propose invalid checks that admit then rejects.

### Exported core

```
evaluateInvariants(fn, cases, invariants, { basis = 0 }) -> {pass:true} | {pass:false, failing:{...}}
```

For each case: deep-snapshot the arg list to JSON **before** calling `fn` (codex #1 — a destructive impl must
not be able to mutate its input to fake `permutation`/`length`/`input-unchanged`); compute `out = fn(...argList)`;
the input **basis** is the pre-call snapshot `args[basisIndex]`. Every invariant must hold for `(basis, out)`
or the case fails with a bounded, truncated `failing` report (codex #7 — never blindly `JSON.stringify` raw
`out`, which can crash on cycles/BigInt/huge arrays). Inputs from `--case` are already JSON, so the snapshot is
a faithful `JSON.parse(JSON.stringify(args))`.

### Invariant set (codex #2, #4, #5, #6, #9)

| name | holds iff | param |
|---|---|---|
| `sorted` | `out` is an array of **numbers** (or all same-type primitives), non-decreasing — no JS `<=` coercion on mixed types | — |
| `permutation-of-input` | `out` and `basis` are **both arrays** and multiset-equal | — |
| `length-preserved` | `out` and `basis` are **both arrays** and `out.length === basis.length` | — |
| `unique` | `out` is an array with no duplicate elements (by canonical key) | — |
| `in-range` | `out` is a finite number, or a flat array of finite numbers, every one in `[min,max]`; non-numeric → fail (not ignored) | `[min,max]` |
| `input-unchanged` | the live `args[basis]` after the call deep-equals the pre-call snapshot (catches destructive transforms) | — |

`idempotent` is **cut** from the starter set (codex #6 — mutation can make a bad fn pass it by accident;
re-add later only with strict unary/clone/no-thenable rules). The set is extensible.

**Multiset / uniqueness via canonical keys, NOT "sort both" (codex #5):** a recursive `canonicalKey(v)` produces
a stable string for a JSON value (object keys sorted) and **throws** on non-JSON leaves (`undefined`, function,
symbol, `NaN`, `Infinity`, `BigInt`) or cycles. A non-JSON *artifact output* makes the invariant **fail**
(score 0 — a gamed fn returning `NaN` is caught, not a scorer crash). `permutation`/`unique` build count maps
keyed by `canonicalKey`.

### Error vs fail discipline (codex #8)

- **scorer error → exit 2:** missing `--fn`, zero `--case`, zero `--invariant`, unknown invariant name, malformed
  invariant param, bad `--case`/`--rel` JSON, missing/non-function export, un-importable artifact. (A malformed
  *check* is the operator's/model's fault.)
- **artifact fails → score 0:** an applicable, well-formed invariant that the artifact's output violates. admit
  then rejects a check whose invariants fail on the *honest* good (it can't discriminate the right way).

## Change surface (bounded)

1. `scorers/io-invariant.mjs` — NEW scorer.
2. `test/io-invariant.test.mjs` — NEW: per-invariant pass/fail; AND-combination; multi-case; `--rel` join +
   containment; **mutation defense** (destructive fn fails `permutation`/`input-unchanged`); double-wrapped
   unary-array case; bad JSON / unknown invariant / zero case / zero invariant → exit 2; non-JSON output → fail.
3. `src/forge/hook.mjs` — add an `io-invariant` entry to `SCORER_USAGE` (additive new map key; file + scope both
   read it via `forgeCatalog`). The hint shows the double-wrapped unary-array case + the named invariants.
4. `bench/forge-invariant-ledger.mjs` — NEW, $0. Deterministic game-then-recover + stub proposer; prove a
   `sorted`+`permutation-of-input` check is LEARNED, DISCRIMINATES (passes honest sort, fails `return input`),
   and is NON-BRITTLE (passes an *alternate* honest sort impl). Cases include **duplicate and negative values**
   (codex #10) so `unique`, hardcoded-`[1,2,3]`, length-only, and range-only mistakes can't look non-brittle by
   accident. `--verify` preflight.

**UNTOUCHED (7 invariant files):** `loop.mjs`, `forge/run.mjs`, `forge/gate.mjs`, `forge/store.mjs`,
`scorers/composite.mjs`, `forge/prune.mjs`, `forge/admit.mjs`.

**DEFERRED:** real-model paid elicitation (optional follow-up). The $0 ledger is mandatory and ships with this.

## Options considered

- **A) Fold property-checking into `io-assert`** (REJECTED — different CLI contract + model hint; muddies
  io-assert's crisp "exact output" contract; codex Q4 agreed: separate scorer is correct).
- **B) A general predicate/expression mini-language** (REJECTED — YAGNI, and an expression language evaluated
  on model-authored strings risks re-opening the code-execution fence the DATA-only boundary closes).
- **C) A fixed set of named, AND-combined invariants in a separate DATA-only scorer** (CHOSEN — composes via the
  existing string gate, stays inside the allowlist trust boundary, extensible).

## Verification

1. `node --test test/*.test.mjs` — all green (expect 429 + new io-invariant tests).
2. `node bench/forge-invariant-ledger.mjs --verify` then a deterministic run — learned + discriminates + non-brittle.
3. `git diff` confirms the 7 invariant files untouched.
