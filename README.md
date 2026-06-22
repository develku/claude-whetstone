# claude-loopcraft

A deterministic **loop-engineering** driver for Claude Code: raise *one* artifact
toward a measured score threshold, where **code owns the gate** and the **model
owns only diagnosis + edits**.

> Status: **spike / private.** Built to be matured by running it on itself
> (dogfooding). Public release is deferred until the cost, auth, and security
> model are proven, not speculative.

## The one idea

A soft loop (a prompt that says "keep going until it's good") lets the same model
that wants to stop decide whether it's done. Loop engineering's upgrade is to take
that decision *away* from the model:

| Role | Owner |
|---|---|
| Compute the score, compare to target, count passes, decide continue/stop | **code** (`src/gate.mjs`) |
| Diagnose what's wrong and make one edit | **model** (`src/act-claude.mjs`) |
| Produce the real output and score it 0–100 + write a critique | **scorer** (`scorers/`) |

The model literally cannot vote itself done, because the `score >= target` branch
lives in `gate.mjs`, not in a prompt.

## Loop

```
baseline: observe → score the initial artifact (iter_000)
repeat:
  ACT      model makes the single highest-impact edit using the last critique
  (no-op guard: artifact unchanged → halt; likely a permission block or max-turns starvation)
  OBSERVE  produce the REAL output (run tests / render / call endpoint)
  SCORE    external scorer → { score 0..100, critique }   (review_NNN.json)
  PERSIST  snapshot the artifact (iter_NNN) + update state.json
  GATE     code decides: done | capped | plateau | error | running
```

Stop conditions, all decided in code (`gateVerdict`): `score >= target` → **done**;
`pass >= hard_cap` → **capped**; best score stalls under `min_delta` across
`plateau_window` passes → **plateau**; malformed score or spend over budget →
**error/capped**. Precedence: `error > done > capped > plateau > running`.

## Quickstart

```bash
node src/driver.mjs "make the suite pass" \
  --artifact src/thing.mjs \
  --scorer 'node scorers/test-pass-rate.mjs --cmd "node --test"' \
  --target 100 --cap 8 --budget 2.00
```

Run state lands in `.loop/<run>/` (gitignored): `state.json`, `snapshots/iter_NNN.*`,
`reviews/review_NNN.json`.

## ⚠️ Cost & auth (read before the first live run)

Empirically measured on this machine, **not** hand-waved:

- A headless `claude -p` spawn that does nothing but print "PONG" cost **~$0.046 /
  ~39K tokens**, because a non-bare spawn reloads the *whole* environment (every MCP
  server, every CLAUDE.md / rule). A real edit pass is larger. Budget accordingly;
  the `--budget` ceiling is code-owned and halts the run.
- `--bare` (which zeroes that tax) **does not work for OAuth/subscription (Max/Pro)
  auth** — it returns "Not logged in" and needs `ANTHROPIC_API_KEY`. Pass
  `--mcp-config <empty.json>` to suppress MCP loading instead.
- The nested edit can be **permission-blocked** by the surrounding environment; the
  no-op guard catches a pass that "succeeded" but changed nothing.

## When to use (and not)

USE it only when one-shot already failed **and** progress is *measurable* (a real
scorer exists) — raise a test pass-rate, a rubric score, an image/embedding
similarity. Do **not** wrap a one-shottable task in a loop (wrong scale wastes
tokens), don't point it at a whole-repo refactor (it raises *one* artifact), and
don't hand-craft a rigid static harness — the scorer is the pluggable seam exactly
so you don't have to. Most tasks don't need a feedback controller.

## Layout

```
src/gate.mjs        code-owned gate (pure)            test/gate.test.mjs
src/state.mjs       state.json + snapshots/reviews    (covered via loop/driver)
src/loop.mjs        control flow (deps injected)      test/loop.test.mjs
src/act-claude.mjs  the headless claude -p edit step  (live-validated, not unit-tested)
src/driver.mjs      CLI + real wiring                 test/driver.test.mjs
scorers/test-pass-rate.mjs   reference scorer          test/scorer.test.mjs
```

`npm test` runs the suite (25 tests, no spend — `act` and the scorer are stubbed
or deterministic). See `SPEC.md` for the file/scorer/gate contracts.

## Prior art & inspiration

The "external evaluator owns the gate" thesis is from the **Loop Engineering** talk
(코드팩토리). The code-owned hard-cap-with-re-injection pattern is the **Ralph
Wiggum** technique, shipped as the official **ralph-loop** plugin — loopcraft reuses
its code-owned cap but replaces its model-emitted "promise" completion gate with a
real score threshold.
