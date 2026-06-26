# Verifier Forge — brick 1: the admission meta-gate (`admitCheck`)

> Status: **approved design, pre-implementation** (2026-06-26). The first of four bricks of the Verifier
> Forge (the "code owns the verifier LIFECYCLE" product; see memory `srank-verifier-lifecycle-thread`).
> Forge bricks: **(1) admission meta-gate [this]** → (2) check store / verifier memory → (3) generator →
> (4) loop wiring + triggers. This brick is a standalone, unit-tested capability with **no loop or
> taxonomy changes** — it is the foundation the later bricks consume.

## Why this brick first

The Forge lets the verifier grow: new private checks accumulate so future runs face an ever-harder gate.
The danger is obvious — if the model can add checks, it can add a *trivial* (always-pass) or *flaky*
check that **lowers** the bar. So the load-bearing piece is not generation but **admission**: a
code-owned decision about whether a candidate check is trustworthy enough to join the verifier set. This
extends whetstone's spine from "code owns the stop" to "**code owns the meta-stop**" — which checks the
loop is allowed to trust. Codex named admission the heart of the Forge ("code owns admission through
replay, isolation, and exploit-regression"); this brick ships **replay + discrimination** (the other two
are later layers — see Out of scope).

## The decision (one line)

A pure, code-owned `admitCheck` admits a candidate verifier-check **only if** it DISCRIMINATES (passes a
known-good artifact AND fails a known-bad one) and its verdict is REPRODUCIBLE across `replayRuns` — so a
trivial or flaky check is rejected by code, not trusted because the model proposed it.

## Architecture — one new module, no wiring

New directory `src/forge/` (the Forge's home). New file `src/forge/admit.mjs`:

```js
// admitCheck: code owns whether a CANDIDATE verifier-check (a scorer/test command) may join the trusted
// verifier set. Admitted only if it DISCRIMINATES (passes a known-good artifact, fails a known-bad one)
// and its verdict is REPRODUCIBLE. The model may PROPOSE checks; a trivial always-pass check (which would
// lower the bar) or a flaky check is rejected here — this is the meta-stop. runCheck is injected so the
// decision logic is pure and unit-testable; scorerRunCheck is the default I/O adapter.
export async function admitCheck({ candidateCmd, goodArtifact, badArtifact, replayRuns = 2, runCheck }) { ... }

// Default adapter: run the candidate as a whetstone scorer against an artifact and map score >= target
// to a boolean pass, reusing the scorer contract (--output <artifact> --loop-dir <dir> --pass NN -> {score}).
export function scorerRunCheck(candidateCmd, artifact, { target = 100, loopDir } = {}) { ... } // -> { pass }
```

**`runCheck(candidateCmd, artifact) => Promise<{ pass: boolean }>`** — injected; runs the candidate
check against one artifact and returns a binary verdict. Default = `scorerRunCheck`.

**`admitCheck` logic** (a private `replay(runCheck, cmd, artifact, n) -> { pass, unstable }` helper runs
the check `n` times and reports the consistent verdict, or `unstable` if the verdicts disagree):

1. **good, replayed** — `replay(runCheck, candidateCmd, goodArtifact, replayRuns)`.
   - `unstable` → reject: "verdict on the known-good artifact is not reproducible — the check is flaky".
   - `!pass` → reject: "rejects a known-good artifact — false-positive-prone, would block honest fixes".
2. **bad, replayed** — `replay(runCheck, candidateCmd, badArtifact, replayRuns)`.
   - `unstable` → reject: "verdict on the known-bad artifact is not reproducible — the check is flaky".
   - `pass` → reject: "passes a known-bad artifact — trivial / non-discriminating, catches nothing".
3. Otherwise → **admit**: "discriminates (passes good, fails bad) reproducibly over N runs".

Returns `{ admit: boolean, reason: string }`. Pure given an injected `runCheck`; no state, no mutation.

## Why this shape (load-bearing facts)

- It **generalizes what we already have**: the taxonomy's `test/bench-fixtures.test.mjs` statically
  asserts, per fixture, "oracle rejects the seeded buggy src AND accepts an honest fix". `admitCheck` is
  that **discrimination property as a runtime function** over an arbitrary candidate check.
- It **reuses the scorer contract** (`scorers/*`, the `runScorer` spawn pattern in `src/driver.mjs` /
  `src/scope-context.mjs`): a candidate check is just a scorer command; `scorerRunCheck` maps its
  `{score}` to a boolean via a target threshold.
- **replay** reuses the Confidence Gate's just-shipped insight: a check that is itself nondeterministic is
  untrustworthy. Same min-of-K spirit, applied to the check's own verdict.
- The reference artifacts (`goodArtifact`, `badArtifact`) are **inputs**, not derived here — keeping this
  brick pure and testable. Where they come from (a vetoed false-done's gamed artifact, a git snapshot, a
  generator) is the job of bricks 3–4.

## Testing (TDD)

- **Unit (stub `runCheck`, no spend):**
  - admit: good→pass, bad→fail, both stable → `{ admit: true }`.
  - reject trivial: bad→pass (always-pass check) → `{ admit: false, reason: /trivial|non-discriminating/ }`.
  - reject false-positive: good→fail → `{ admit: false, reason: /known-good/ }`.
  - reject flaky-good: good verdict flips across runs → `{ admit: false, reason: /reproducible|flaky/ }`.
  - reject flaky-bad: bad verdict flips across runs → `{ admit: false, reason: /reproducible|flaky/ }`.
  - `replayRuns: 1` still works (single read, no flakiness check) — admit a discriminating check.
- **Adapter (thin, deterministic):** `scorerRunCheck` against a tiny test scorer fixture that scores by
  artifact content (e.g. reuse/extend a `test/fixtures/*-scorer.mjs`), asserting `score >= target` maps
  to `pass` and below maps to `!pass`.
- **Full suite:** 281 existing + new all green (additive only — no existing file changes).

## Out of scope (later Forge bricks — explicitly NOT here)

- **exploit-regression** (Codex's third admission leg): the candidate must also not open a gaming hole the
  TAXONOMY catalogues. Deferred — it needs *executable* exploit attempts against an arbitrary check,
  which don't exist yet (the taxonomy is a static catalogue). Brick 1.5.
- **isolation**: an admitted check must live read-only / held-out so the editor can't game it — a wiring
  property enforced when admitted checks feed the gate (brick 4), not an admission computation.
- **store** (brick 2), **generator** (brick 3), **loop triggers + feedback** (brick 4). `admitCheck` is
  consumed by, but does not depend on, any of these.
