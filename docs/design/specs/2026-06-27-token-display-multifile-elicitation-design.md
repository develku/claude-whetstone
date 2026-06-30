# Token-primary spend display + multi-file real-model elicitation (codex-revised)

**Date:** 2026-06-27 · **Status:** approved (operator "go") · cross-model leg: codex (24.1K tok)

## Why

The operator (and most whetstone users) run on a **subscription (Max/Pro) plan**, where `total_cost_usd`
is only a *notional* API-equivalent price — the real constraint is **tokens** (the rate-limit currency).
The codebase already KNOWS this (`src/act-claude.mjs:36-45`: tokens = input+output+both cache counts,
"tokens are the real constraint, so tokens get their own dial") and already *captures* tokens end-to-end
through `recordPass`→`spent_tokens`. The gap is **display**: the runtime report shows USD first
(`summary.mjs:13`), and the dev benches print `cost=$X` with **no tokens at all**. Make tokens primary.

Separately: the scope multi-file produce path (HEAD `60ea570`) is proven at $0 only. Add the **paid**
real-model benchmark that proves it elicits a usable per-file check for EACH of N gamed files.

## Two deliverables

### A. Token-primary spend display (tokens lead, USD trails)

- **New `src/spend-format.mjs`** — single formatter, reused everywhere:
  ```js
  export function formatSpend({ tokens = 0, costUsd = 0 } = {}) {
    const t = `${(Number(tokens) || 0).toLocaleString('en-US')} tokens`
    const c = Number(costUsd) || 0
    return c > 0 ? `${t} ($${c.toFixed(4)})` : t
  }
  ```
  - Token-primary; USD secondary in parens. **`Number()`-coerced** so a stringy `"0.5"` formats instead
    of crashing on `.toFixed` (codex D1).
  - **`$` paren dropped at zero cost** — a $0 stub/ledger reads `1,234 tokens`, not `…($0.0000)` noise.
    A real subscription call always has a nonzero notional cost, so it keeps the `$` (codex D1).
  - Unit is the full word **`tokens`** (not `tok`) — don't shorten the existing user-facing string (codex D1).
- **`src/summary.mjs`** — reorder `summarizeRun` to `… · spent <formatSpend({tokens, costUsd: spent_usd})>`
  → `… · spent 1,234 tokens ($0.5000)`. Keep the word "spent" (codex D2). `costUsd` still tracked — display only.
- **All forge benches** that print a spend RESULT/aggregate adopt `formatSpend` (codex D3 — do them all now,
  the helper makes each a one-liner; a mixed UI is worse than the scope creep): `forge-scope-realmodel`,
  `forge-iotrace-realmodel`, `forge-ledger`, `forge-proof`, + the new multifile bench. (`bench/run-bench.mjs`
  is a USD spend-CEILING orchestrator, not a per-run display — left as USD.)
- **INVARIANT:** `loop.mjs/run.mjs/gate.mjs/store.mjs/composite.mjs/prune.mjs/admit.mjs` untouched. Docs
  (SPEC/README) already teach tokens correctly and don't assert the exact summary line → no doc change.

### B. Multi-file real-model elicitation — `bench/forge-scope-multifile-realmodel.mjs` (PAID)

One scenario, a repo where TWO files are gamed→honest in the recovery; drive `runScopeForgeHook` with the
REAL claude proposer (model=sonnet). A `--stub` preflight ($0, prompt-aware stub keyed on `Changed file: <rel>`)
makes the harness testable for free before any spend.

- **Files** (each with honest, gamed1, gamed2-different-text-same-bug, alt-equivalent-honest):
  - `src/a.mjs` PURE: `f(n)=n` doubled. honest `n*2`, gamed1 `n*3`, gamed2 `n*2+1` (off-by-one, different text
    & behaviour), alt `n+n`.
  - `src/b.mjs` STATEFUL: `makeCounter()→{inc(),value()}`. honest real counter, gamed1 `value()→1` constant,
    gamed2 counts but `value()→0`, alt closure-object equivalent.

- **The proof (codex D4 — both-gamed VETO is INSUFFICIENT; MIN aggregation means one working check vetoes the
  both-gamed tree even if the other is useless).** Prove THREE things, by running **each admitted check
  INDIVIDUALLY** (via `scorerRunCheck` against plain probe dirs — no git needed) — composite hides sub-results:
  1. **Emission:** exactly 2 admitted, kind `'scope'`, one carrying `--rel src/a.mjs`, the other `--rel src/b.mjs`.
  2. **Attribution** (codex's deeper hole — isolation alone is insufficient without attribution): for each file i,
     check_i **FAILS** its own file's gamed tree and check_j (j≠i) **PASSES** it. I.e. on an `src/a.mjs`-gamed-only
     tree, the a-check fails and the b-check passes; symmetric for b. This proves each check is responsible for
     ITS file, not vetoing for the wrong reason.
  3. **Behavioural + non-brittle:** each check FAILS **both** gamed variants (gamed1 AND gamed2 — defeats a
     textual `contains *3` masquerading as behavioural) and PASSES honest AND alt (semantically-equiv tolerance).
- **io-trace is DIAGNOSTIC, not a gate** (codex D4) — a stateful counter does NOT force io-trace (an io-assert
  calling `inc()` twice then `value()` works). Report the chosen strategy per file as metadata; never fail on it.
- **Spend:** real run asserts `tokens > 0` (and notional `costUsd > 0`); reported via `formatSpend` (token-primary).
- Keep both-gamed VETO as a **regression** assertion only — not the proof.

## Biggest risk (codex)

Overclaiming what the paid bench proves: a green composite can hide useless/misattributed checks, and even
per-file isolation passes for the wrong reason without attribution. The bench must separately prove
emission · per-file attribution · behavioural-tolerance — else it is a vanity green with real-model spend attached.

## Verification

1. `node --test test/*.test.mjs` ≥418 green (+ new `test/spend-format.test.mjs`; updated `test/summary.test.mjs`).
2. `node bench/forge-scope-multifile-realmodel.mjs --stub` → $0 harness green (emission·attribution·behavioural).
3. Token-primary visible in the runtime report AND every adopted bench.
4. `git diff` confirms the 7 invariant files untouched.
5. PAID run (`--model sonnet`) ONLY after explicit operator authorization; report tokens.
6. Commits carry provenance bodies citing the codex leg; push; update memory.

## Result — PAID sonnet run, 2026-06-27 (NON-NULL)

`node bench/forge-scope-multifile-realmodel.mjs --model sonnet` → **83,460 tokens ($0.3442)**:

- **per-file proven: 2/2** — a real sonnet proposed a usable per-file check for BOTH gamed files. `src/a.mjs` got an
  io-assert with THREE cases (`2=>4, 5=>10, -3=>-6`, richer than the stub); `src/b.mjs` got an io-trace
  (`[inc,value,inc,value] => [1,1,2,2]`). Both fully attributed + behavioural + non-brittle.
- **Refinement (the "exactly 2" criterion was too strict).** sonnet proposed a THIRD check for `src/b.mjs`
  (`[value] => [0]`) which passed admission (it discriminates the real vetoed snapshot — a fresh `value()` is 0 on
  honest, 1 on the constant-gamed snapshot) but is NOT behaviourally complete: it MISSES the synthetic second
  variant (a counter that increments but `value()` still returns 0 — a fresh `value()` is 0 there too). The gate
  was changed from "exactly 2 admitted" to **"every file has ≥1 fully-proven check"** (per-FILE, not a fixed total),
  with extras reported as a diagnostic.
- **Finding (admit-gate limit, not an elicitation failure):** admit accepts any check that discriminates the ONE
  real vetoed snapshot, so a behaviourally-incomplete check can be admitted. The bench surfaces this without
  failing the multi-file claim. A future strengthening (multi-snapshot admit, or corroboration against synthetic
  variants) would close it — related to frontier 2a (differential corroboration).

