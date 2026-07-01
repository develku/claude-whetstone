# Mutation-backed admission (frontier) — design note

**Status:** Originally deferred (2026-06-27): a cross-model design review judged close-now gold-plating and
recommended building it as its own scoped feature. **Later built** — see
`2026-06-28-verifier-forge-mutation-backed-admit-design.md`. This note preserves the original design reasoning.

## The finding that motivates it

The paid multi-file elicitation run (`bench/forge-scope-multifile-realmodel.mjs --model sonnet`, 2026-06-27)
surfaced: a real model proposed a check (`value()==0` on a fresh counter) that PASSES admission — it
discriminates the ONE vetoed snapshot (a constant-1 counter) — yet MISSES a sibling bug (a counter that
increments but `value()` still returns 0; a fresh `value()` is also 0). **Root cause:** `admitCheck`'s `bad` is
a single point, so a check can fail that point for a non-generalizing reason (pointwise overfitting).

## Why DEFER (not a tack-on)

Both models agree the weak check is **harmless to gate safety**: the gate composes checks with MIN, so a weak
admitted check can never make the gate more permissive — it is inert or occasionally hardens. The real costs are
SOFT and slow: **false confidence** (reading "admitted" as "generalizes"), store/runtime bloat, and **future
lifecycle risk** (if active-check caps / redundancy ranking / strong-check retirement ever land, weak checks
start mattering). codex's named single biggest risk: **credibility debt** — "admitted count" being treated as
"learned coverage." That risk is already partially mitigated: `forge-scope-multifile-realmodel.mjs` reports
*per-file proven* + a behavioural ratio and flags the weak check, so the docs do not overclaim.

## The converged design (Opt A — when built)

- **New `src/forge/mutate.mjs`** — generate small MUTANTS of the GOOD file with a fixed operator set:
  arithmetic-op swap, off-by-one, boolean flip, return-constant, drop-statement. Pure given the source string.
- **`mutationAdmit` = a policy WRAPPER over `admitCheck`, injected through `runForge`'s existing `admit` seam —
  `admit.mjs` stays UNTOUCHED.** Shape (codex):
  ```js
  const mutationAdmit = async (a) => (await admitCheck(a)).admit ? admitMutantNeighborhood(a) : admitCheck(a)
  ```
  i.e. first require the primitive "passes good, fails the real bad", THEN require the candidate to FAIL a
  threshold of the mutant neighbourhood.
- **Equivalent-mutant dodge (the sharp risk) = ORACLE-filtered mutants, NOT candidate-I/O-filtered.** Only count
  a mutant as a required-kill if a trusted oracle (the existing `--forge-oracle` machinery, corroborate.mjs)
  REJECTS the mutant while ACCEPTING good. Candidate-I/O filtering was rejected: it excludes exactly the sibling
  behaviour the weak check failed to observe, defeating the purpose. This reuses 2a's oracle infrastructure.
- **Reject Opt B (history-accumulated bads):** it is retrospective point accumulation ("also catch the exact
  previous failures"), not generalization, and pushes artifact-history semantics into admission.

## Biggest risk when built

Equivalent mutants forcing FALSE REJECTIONS of good checks (worse than the harmless status quo) — mitigated by
the oracle-filter (a mutant only counts if an independent oracle agrees it is genuinely bad). Perf: each mutant
is a scorer run; cap the operator count / sample mutants.

## When to pick this up

When pushing the Forge frontier deliberately (its own brainstorm → spec → plan → TDD → $0 ledger → paid
elicitation), NOT as a tack-on. Until then the limitation stays documented and the honest bench language stands.
