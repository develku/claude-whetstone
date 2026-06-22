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

Directly measured on this machine (2026-06-22), **not** hand-waved:

- A single trivial `claude -p` call (reply "OK", clean cwd, MCP suppressed) cost
  **$0.22 on Opus / ~$0.05 on Haiku**, burning **~44K tokens** of context tax (system
  prompt + slash commands + tool defs) *even with no CLAUDE.md and no MCP loaded*. So
  **use `--model haiku` (or sonnet) for the act step** — Opus at `--cap 10` is ~$2.2+
  per loop in overhead alone. The code-owned `--budget` ceiling halts the run.
- `--mcp-config empty-mcp.json --strict-mcp-config` **works** (`mcp_servers` → `[]`) —
  a real cost lever. An empty config is bundled at `empty-mcp.json`.
- `--bare` (which would zero the tax) **does not work for OAuth/subscription (Max/Pro)
  auth** — it returns "Not logged in"; it needs `ANTHROPIC_API_KEY`. Use `--mcp-config`
  + a clean cwd instead.
- The act step runs the nested `claude -p` **in the artifact's own directory**, so the
  edit inherits *that* project's config. Keep the artifact in a repo *without* a
  restrictive `settings.json`/CLAUDE.md deny layer — otherwise the nested edit is blocked
  and the no-op guard halts a pass that "succeeded" but changed nothing.

Validated end-to-end 2026-06-22: `TODO` → `DONE` converged at pass 1 on Haiku for
**$0.05** (gate owned the stop, the model owned the edit, the scorer owned the number).

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
