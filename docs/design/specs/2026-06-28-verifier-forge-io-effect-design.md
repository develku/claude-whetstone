# Verifier Forge "2b-extended trace form": `io-effect` (argument-mutation / IO-side-effect) scorer (design)

**Date:** 2026-06-28
**Status:** design → codex review → implementation
**Builds on:** the DATA-only scorer family — `io-assert` (pure fn), `io-trace` (stateful subject, method-sequence
RETURNS), `io-invariant` (property of the output). All three observe RETURN VALUES.

## Problem

A whole class of correct behaviour is a **side effect**, not a return: a function MUTATES an argument in place
(`sortInPlace(arr)`, `pushAll(target, items)`, `Object.assign`-style) or writes to an injected **sink/accumulator**
(`logEvent(sink, evt)` pushes to `sink`; `tally(counts, key)` increments `counts[key]`). The return is often
`undefined`. `io-trace` constructs a subject and asserts the RETURNS of a method sequence — it never inspects the
post-call state of the *arguments*, so a gamed impl that returns the right value but does NOT perform the mutation
(or mutates wrongly) slips through. The backlog calls this the "mutated-input/output trace" that 2b-extended
io-invariant did not cover.

## Design decision: a SIBLING scorer, not a mode of io-trace

The backlog says "extend io-trace". Realized as a NEW sibling scorer `scorers/io-effect.mjs`, exactly as io-trace
was a sibling to io-assert rather than a mode of it — argument-mutation of free functions is a different shape
(no subject construction; the observable is arg state, not a return), and bolting a mode onto io-trace would bloat
and risk its shipped returns-only contract. io-effect composes via `composite.mjs` (MIN) like the others, stays
inside the allowlist (DATA-only args), and adds only an additive `hook.mjs SCORER_USAGE` hint. **7 invariant files
untouched.** io-trace.mjs itself is also left byte-identical (it is not in the 7 but the sibling pattern keeps it so).

## Non-goals

- **No external IO.** Files, network, processes are NOT DATA and are out of the DATA-only fence. io-effect covers
  IN-MEMORY mutation/accumulator effects only (the "sink" is a JSON value passed by reference).
- **No general predicate language** (YAGNI — same boundary as io-invariant).

## The mechanism

The observable is the **post-call state of a carried mutable first argument (the "sink")** across a call SEQUENCE
(the "trace"). The fn is invoked `fn(sink, ...callArgs)` for each call; `sink` is passed by reference, so the fn
mutates it in place. After all calls, deep-equal the (mutated) sink against `--expect-sink`; optionally also
deep-equal the per-call returns against `--expect-returns`.

The "sink as the FIRST argument" convention covers the common APIs (target-first: `Object.assign(target, …)`,
`pushAll(target, items)`, `logEvent(sink, evt)`, and a single-call in-place transform `sortInPlace(arr)` =
`fn(sink)` with `calls=[[]]`). It is a documented MVP constraint (a fn whose mutated arg is not first is out of
scope for now — the model adapts or proposes a different scorer).

### CLI

```
io-effect --output <root> [--rel <file>] --fn <name>
  --sink '<JSON>'                  (required: initial carried mutable value, e.g. [] or {} or [3,1,2])
  --calls '<JSON [[...args],...]>'  (required: each entry is the EXTRA args; fn is called fn(sink, ...args))
  --expect-sink '<JSON>'           (required: deep-equal the sink AFTER all calls)
  [--expect-returns '<JSON [...]>'] (optional: deep-equal the per-call return values)
```

A single call with no extra args is `--calls '[[]]'` (one call, `fn(sink)`).

### Exported core

```
evaluateEffect(mod, { fnName, sink, calls, expectSink, expectReturns }) -> {pass:true} | {pass:false, failing}
```

- `fn = mod[fnName]`; not a function → `{pass:false, failing:{error}}` (score 0, like io-trace's missing export).
- For each `args` in `calls`: `returns.push(fn(sink, ...args))`; a throw → `{pass:false, failing:{step, error}}`.
- After the sequence: `JSON.parse(JSON.stringify(sink))` (undefined→null, DATA-comparable) deep-equal `expectSink`.
- If `expectReturns != null`: JSON-normalize `returns` deep-equal `expectReturns` too (covers the "output" side).
- The sink comes from `--sink` JSON, so it is a fresh object each run; the fn mutates that fresh object.

### Error vs fail discipline (mirror io-trace/io-invariant)

- **scorer error → exit 2:** missing `--fn`/`--sink`/`--calls`/`--expect-sink`, bad `--*` JSON, `--calls` not an
  array of arrays, `--expect-returns` present but not an array, un-importable artifact, missing `--output`.
- **artifact fails → score 0:** fn missing/non-function, a call throws, sink mismatch, returns mismatch.

## Change surface (bounded)

1. `scorers/io-effect.mjs` — NEW scorer (DATA-only, `resolveOutput` `--rel`, exported `evaluateEffect` + CLI guard).
2. `test/io-effect.test.mjs` — NEW: sink-pusher passes / no-op fails; in-place sort passes / non-mutating "sort"
   (returns sorted, leaves input) fails; accumulator object; expect-returns optional + asserted; call throws →
   fail; `--rel` join; CLI errors → exit 2; non-JSON sink output → handled.
3. `src/forge/hook.mjs` — add an `io-effect` entry to `SCORER_USAGE` (additive map key; file + scope via forgeCatalog).
4. `bench/forge-effect-ledger.mjs` — NEW, $0: prove io-effect discriminates a gamed "returns-right-but-doesn't-
   mutate" impl non-brittly on surfaces io-trace/io-assert structurally can't observe. `--verify`.
5. `bench/forge-effect-realmodel.mjs` — NEW (paid): does a real model PROPOSE io-effect on a mutation/side-effect
   surface? (mirror forge-iotrace-realmodel.mjs).

**UNTOUCHED (7 invariant files):** `loop.mjs`, `forge/run.mjs`, `forge/gate.mjs`, `forge/store.mjs`,
`scorers/composite.mjs`, `forge/prune.mjs`, `forge/admit.mjs`. Also UNTOUCHED: `scorers/io-trace.mjs`.

## Options considered

- **A) New sibling scorer `io-effect` observing post-call sink state (CHOSEN)** — additive, DATA-only, composes,
  matches the io-assert→io-trace→io-invariant sibling lineage; io-trace stays byte-identical.
- **B) Add a `--expect-args` mode to io-trace (REJECTED)** — bloats/risks io-trace's crisp returns-only contract;
  the subject-construction shape doesn't fit free-function arg mutation.
- **C) A general "before/after state predicate" language (REJECTED)** — YAGNI; reopens the code-execution fence
  the DATA-only boundary closes.

## Verification

1. `node --test test/*.test.mjs` — all green (482 + new).
2. `node bench/forge-effect-ledger.mjs --verify` — discriminates / non-brittle / io-trace-can't.
3. Paid `bench/forge-effect-realmodel.mjs --model sonnet` — NON-NULL (a real model proposes io-effect).
4. `git diff` confirms the 7 invariant files (and io-trace.mjs) untouched.

## Codex cross-model review — folded

Codex's sharpest finding was a genuine TRUST-BOUNDARY hole, since io-effect is a verifier scorer and the gamed
artifact CONTROLS the sink object it mutates:

- **#4/#5/#9 (CRITICAL): `JSON.stringify(sink)` invokes a user-controlled `toJSON`/getters.** A gamed artifact
  could attach `sink.toJSON = () => expectedSink` (or accessor properties) to FORGE the observed state and pass
  while the real state is wrong. FOLD: read the post-call sink with `canonicalData` — a strict own-DATA-property
  walker that rejects accessors, a `toJSON`-as-function (never INVOKED), non-plain prototypes, symbols, BigInt,
  undefined, non-finite numbers, and cycles. Same walker on the returns.
- **#7/#8/#10 (HIGH): cycles/BigInt crash `JSON.stringify` OUTSIDE the assert, so the CLI exits non-2.** FOLD:
  an artifact-produced non-JSON sink is an ARTIFACT failure → score 0 (caught), never a scorer crash.
- **#2/#3 (MEDIUM): `undefined`→`null` normalization weakened the data contract.** FOLD: canonicalData rejects
  `undefined` (JSON input can never contain it) rather than silently coercing.
- **#1 (LOW): `--expect-returns` length unvalidated.** FOLD: a length ≠ `--calls` length is a scorer error (exit 2).
- **#11: error-vs-fail contract.** Clarified: un-importable artifact → exit 2; missing/wrong export or non-JSON
  output → score 0 (candidate failure).
- **#14/#15 (noted, gate-level not scorer-level): a gamed artifact can special-case the exact public (sink,calls)
  and stamp `expectSink`.** This is inherent to example-based scorers and is defended by the ADMIT gate
  (discrimination on the known-bad) + **mutation-backed admit (item 1)** which probes a mutant neighbourhood — not
  io-effect's job. Documented.
- **#16/#17 (documented constraints): sink-not-first-arg / multiple mutable targets** — deferred (`--sink-index`
  is the natural future extension); the target-first MVP covers the common APIs.
- **#12 (noted): `await import(artifact)` is still arbitrary code execution.** "DATA-only" means the test VECTOR
  carries no code; artifact execution safety is the verifier sandbox's job, outside this file.

NOTE (spawned as a follow-up task): `io-trace.mjs` and the returns side of other scorers use the same naive
`JSON.parse(JSON.stringify(...))` and share the `toJSON`/getter forge vector in principle. io-trace is out of
this item's scope (and the "io-trace untouched" invariant); flagged for a separate hardening pass.
