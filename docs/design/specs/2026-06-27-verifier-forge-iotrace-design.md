# Verifier Forge — frontier 2b: behavioural checks for stateful surfaces (`io-trace`)

> Status: **implemented** (2026-06-27). Extends the behavioural-check line past pure functions. `io-assert`
> (frontier of the brittleness ledger) checks one `IN=>OUT` of a pure function; many real surfaces are
> **stateful** (a class/factory whose behaviour depends on a *sequence* of calls) and cannot be expressed that
> way. `io-trace` is the natural generalization — still **DATA-only**, still inside the allowlist trust boundary.

## Why this

The Forge's learned checks must be **DATA, never model-authored code** (the standing trust-boundary
constraint). `io-assert` satisfies that for pure functions: `--fn f --case 'IN=>OUT'`. But a stack, a counter,
a parser, a state machine — their behaviour is "push then pop returns the pushed value", which a single
`IN=>OUT` cannot capture. Without a stateful behavioural check, the Forge would fall back to brittle textual
`contains` for stateful gaming (fossilizing a phrasing) or fail to discriminate at all.

## The decision (one line)

Ship `scorers/io-trace.mjs`: construct a **subject** (a class instance via `--new`, or a factory's return via
`--factory`), replay a **sequence** of method calls (`--trace`), and assert the **observed return values**
(`--expect`). All args are JSON DATA — method names, arguments, and expected returns — interpreted by a fixed
trusted scorer; no model-authored code. A 1-step trace IS `io-assert`'s case; `io-trace` is the N-step superset.

## Contract

```
io-trace --output <path>
         ( --new <ClassExport> | --factory <fnExport> )   # exactly one
         [--init '<JSON args>']                            # constructor/factory args (default [])
         --trace  '<JSON [[method, ...args], ...]>'        # the call sequence
         --expect '<JSON [returnValue, ...]>'              # expected returns, one per step
```
Score 100 iff the observed returns deep-equal `--expect`, else 0; exit 2 on scorer error (missing export,
missing method, bad JSON). Returns are **JSON-normalized** (`JSON.parse(JSON.stringify(returns))`) so a mutator
returning `undefined` compares against JSON `null` — consistent with DATA comparison.

**Final-state assertion needs no new concept:** end the trace with a getter (`["size"]`, `["value"]`) and its
return value is the observed final state. Example (stack): `--new Stack --trace
'[["push",1],["push",2],["pop"],["size"]]' --expect '[null,null,2,1]'`.

## Architecture

- **`scorers/io-trace.mjs`** — mirrors `io-assert.mjs`: a pure exported `evaluateTrace(mod, {newName,
  factoryName, init, steps, expect}) -> {pass} | {pass:false, failing}` (a test passes a fake module), plus a
  thin CLI that imports the artifact and prints `{score, critique, findings}`.
- **`src/forge/hook.mjs` `SCORER_USAGE`** — an `io-trace` usage hint so the generator proposes it for
  class/factory surfaces (preferred over `contains`, alongside `io-assert` for pure functions). It is data-only,
  so it is **not** in `FORGE_UNSAFE_SCORERS` — an operator allowlists it with `--scorer-allow`.

## Security surface

`io-trace` calls `subject[method](...args)` where `method` comes from DATA. This is bounded exactly like
`io-assert` importing+calling the artifact (already accepted): the subject is the artifact's own surface; a
non-function method (`__proto__`, a typo) → "no method" → exit 2 / score 0; `constructor` called without `new`
throws → caught → score 0. No path reaches arbitrary code execution beyond running the artifact-under-test,
which every behavioural scorer already does.

## Measurement (measure → fix → re-measure)

`bench/forge-iotrace-ledger.mjs` — deterministic, **$0**. Three stateful scenarios (counter, stack, toggle),
each gamed-to-the-visible vs honest + alternate honest phrasings (array- vs linked-list stack, closure- vs
object-counter):

| metric | result |
|---|---|
| io-trace true-discriminator (honest PASS, gamed FAIL) | **3/3** |
| io-trace brittleness (rejects a valid alternate phrasing) | **0/3** |
| io-assert applicable (can validate the honest stateful artifact at all) | **0/3** |

io-trace is a non-brittle behavioural discriminator on every stateful scenario — passing all alternate honest
phrasings, failing only the gamed impl — exactly as io-assert does for pure functions. io-assert is
structurally inapplicable (a single `IN=>OUT` call cannot carry state across a method sequence).

## Honest scope / out of scope

- **Covers:** stateful objects whose behaviour is observable through a method-call sequence (stacks, counters,
  state machines, accumulators, parsers with feed/result). The large majority of stateful surfaces.
- **Deferred (further frontier):** **argument-mutation / IO** surfaces (a function that mutates its argument or
  writes output — needs a trace form that asserts the mutated input/output, not just return values), and
  **non-deterministic** surfaces (random/time — exact `--expect` is wrong; needs a fixed vocabulary of named
  **invariants** like sorted / permutation-of / in-range, a separate `io-invariant`-style scorer).
- **Real-model elicitation — DONE, NON-NULL** (`bench/forge-iotrace-realmodel.mjs`, sonnet, $0.53): proposal
  3/3, **io-trace used 6/6** learned checks, non-brittle 6/6, true-discriminator 6/6. A real model reaches for
  io-trace on every stateful surface and writes multi-step traces that probe state evolution — the stateful
  analog of io-assert's proposal 5/5.
