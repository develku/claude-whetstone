# Confidence Gate — closing the flaky-score gap

> Status: **approved design, pre-implementation** (2026-06-26). Closes the one RED entry in the Exploit
> Taxonomy (`bench/taxonomy/manifest.mjs` → `flaky-score`). The next character on the "code owns the
> verifier LIFECYCLE" roadmap (see memory `srank-verifier-lifecycle-thread`).

## The gap

`gateVerdict` (`src/gate.mjs:28`) decides `done` from `scores.at(-1)` — a single latest reading, with no
repeated-measurement or variance check. A **flaky / nondeterministic scorer** (flaky tests, randomness,
ordering) can spike to target on one pass and reach `done` without a genuine, reproducible fix. The
taxonomy gap-demo pins this today: `gateVerdict([40,40,100]) → done`.

## The decision (one line)

Add a **done-edge stability re-measurement** as a sibling to the existing confirm-veto: when the gate
declares `done`, re-run the **primary** scorer K times and accept only if **min-of-K ≥ target**;
otherwise veto and keep going. `gateVerdict` is untouched.

## Why this shape (load-bearing facts)

- The loop already has a **done-edge hook**: `confirmDone(st, vd)` (`src/loop.mjs:42`) runs only when the
  gate would declare done, re-scores via an independent (held-out) scorer, and vetoes a gamed primary by
  returning `running`/`capped` plus a steering critique. The Confidence Gate is the *same shape* applied
  to the **primary** signal: confirm asks "does an independent signal agree?"; stability asks "is the
  primary reading reproducible?"
- `gateVerdict` is a **pure function** with no I/O — it cannot re-run the scorer. So the re-measurement
  lives in the loop (which already has the injected `evaluate` dep), and `gateVerdict`'s contract stays
  byte-identical. Blast radius on the 266 existing gate/loop tests: zero.
- Re-running `evaluate` re-runs the **scorer** (a test/build command), not the model editor. Scorer cost
  is not charged to the budget (only `act`/editor cost is). So K stability probes at the done-edge cost
  time, **not model spend** — nearly free, and only at the (rare) done-edge.
- `min-of-K` mirrors whetstone's existing `composite` min-combine ("the weakest dimension gates done"):
  here, **the weakest measurement gates done.** Most conservative, which is correct for a TRUST gate
  whose job is to minimize false `done`.

## Architecture

One new config dial + one new loop step; everything else reused.

### Config (operator-frozen at launch, like `target_score`)

- `--stability-runs K` → `cfg.stabilityRuns` → `state.stability_runs`. **Default 1** (off →
  byte-identical to current behavior). Validated as an integer ≥ 1 (`src/validate.mjs`).
- Frozen at launch (not in resume's overridable list), so the model cannot lower its own bar.

### Loop step (`src/loop.mjs`)

The two existing done-edge call sites (`src/loop.mjs:74` baseline, `:114` loop) currently call
`confirmDone(s, gateVerdict(s))`. Replace both with a `verifyDone(s, gateVerdict(s))` that composes
stability **then** confirm:

```
async function verifyDone(st, vd) {
  const stable = await stabilityCheck(st, vd)   // primary re-measurement; vetoes if min-of-K < target
  if (stable.v.status !== 'done') return stable  // unstable -> already running/capped
  return confirmDone(stable.s, stable.v)         // then the existing held-out confirm
}
```

`stabilityCheck(st, vd)`:
- If `vd.status !== 'done'` or `state.stability_runs <= 1` → return `{ s: st, v: vd }` (no-op; this is
  why default K=1 changes nothing).
- Else: the triggering reading is `st.history.at(-1).score`. Re-run the injected `evaluate(st)`
  **K-1** more times (no `persist` — these are probes, not history), collect their scores, take
  `m = min(triggeringScore, ...probeScores)`. Each probe score is held to the same `validScore` 0..100
  invariant (an invalid probe → terminal `error`, mirroring `confirmDone`).
- If `m >= st.target_score` → stable → `{ s: st, v: vd }` (done stands, proceed to confirm).
- Else → veto exactly like `confirmDone`: set `last_critique` to a stability critique, stamp the
  **existing** done-edge marker `confirm_vetoed_at_pass = st.pass`, `save()` it (so a kill during the
  next editor spawn is not mistaken for done on `--resume` — reuses the confirm marker semantics, so
  **`src/resume.mjs` needs no change**), and return `running` (or `capped` if `st.pass >= st.hard_cap`).
  Stability critique: `"score not reproducible: min ${m} over ${K} runs is below target ${target} — make the solution deterministic, not luck-dependent."`

### Scope loop

`scopeBuildContext` (`src/scope-context.mjs`) injects the same `evaluate`, so stability re-runs the
project scorer in `cwd=scopeDir` exactly as a normal pass does. No scope-specific code. (Confirm keeps
its pristine-checkout `gitVerifyAt` path; stability deliberately re-measures the **live** artifact — we
want the variance of the very signal the gate read.)

### Taxonomy update

- `bench/taxonomy/manifest.mjs` entry `flaky-score`: flip `status` to `GREEN`; `defense` = the stability
  gate (`name`: "stabilityCheck — done-edge min-of-K primary re-measurement", `file`: `src/loop.mjs`);
  `proof` = the new loop test (`file`: `test/loop.test.mjs`, `contains`: its exact test title).
- `test/taxonomy.test.mjs` — make RED handling future-proof now that the gap is closed (zero RED):
  - Drop the v1 scaffold assertion "exactly one RED, and it is `flaky-score`" — it pinned the single
    known gap; with the gap closed it would fail.
  - Change the "RED entry" test to **iterate** `TAXONOMY.filter(e => e.status === 'RED')` — each must
    have `defense === null`, `proof === null`, non-empty `notes` (vacuously true at zero RED, still
    correct if a future gap is ever added).
  - Remove the old gap-demo (`gateVerdict([40,40,100]) → done`): `gateVerdict` is unchanged, so it no
    longer demonstrates a gap. The flaky defense is now proven by the loop test above, which becomes the
    manifest's `flaky-score` proof.

## Testing (TDD)

- **Unit (loop, stubbed `evaluate`, no spend):**
  - `stability_runs=1` (default): a single target reading finishes `done` — backward-compat, current
    behavior unchanged.
  - `stability_runs=3`, flaky evaluate scripted `[100, 40, 100]`: min 40 < target → done vetoed →
    `running` then (at cap) `capped`. The next edit is steered by the stability critique.
  - `stability_runs=3`, stable evaluate `[100,100,100]`: finishes `done`.
  - Invalid probe score (e.g. 150 / NaN) on a re-read → terminal `error` (never confirms a flaky done,
    never silent-vetoes to cap) — mirrors the confirm invalid-score test.
  - Stability + confirm composed: stable primary but failing confirm → confirm still vetoes (ordering
    holds); flaky primary → stability vetoes before confirm runs.
  - `--resume` after a stability veto: the `confirm_vetoed_at_pass` marker makes `prepareResume` see
    `running`, not `done` (reuse the existing resume test shape).
- **CLI:** `--stability-runs 3` parses to `cfg.stabilityRuns=3`; absent → 1; `validateConfig` rejects 0,
  negatives, and non-integers.
- **Taxonomy:** the new flaky-veto loop test in `test/loop.test.mjs` is the manifest's `flaky-score`
  proof; `test/taxonomy.test.mjs` passes with zero RED (GREEN-integrity now also covers `flaky-score`,
  so its defense file + proof must exist and contain the needle).
- **Full suite:** 271 existing + new all green (default K=1 keeps every existing test byte-identical).

## Risks / non-goals

1. **Test-flakiness the editor can't fix** (e.g. a genuinely nondeterministic test harness): stability
   will veto to the cap rather than declare a false done — the honest outcome (better a capped run than a
   gamed done). The critique nudges toward determinism; if impossible, the operator sees `capped`, not a
   lie. Acceptable.
2. **Default off**: like `--confirm-scorer`, the Confidence Gate is opt-in (`--stability-runs > 1`).
   v1 ships the *mechanism* + proves it; making it default-on (or auto-enabling on observed variance) is
   a deliberate follow-up, not this brick. The manifest GREEN means "a proven defense exists," consistent
   with how class 2 (confirm) is GREEN despite being opt-in.
3. **Not a statistical estimator**: min-of-K, not a confidence interval. YAGNI for small K; revisit only
   if a real noisy-but-acceptable scorer needs tolerance (then quorum / lower-bound).
