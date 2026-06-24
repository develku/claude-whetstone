# whetstone contracts

The durable design record. Three contracts make the loop work; keep them stable.

## 1. The gate (`gateVerdict(state) -> { status, reason }`)

Pure function. Reads only numbers the scorer produced. Precedence is deliberate:

1. **error** — latest score is not a finite number in `[0, 100]`. A malformed score
   is never allowed to read as success or progress (halt).
2. **done** — `latest >= target_score`. Beats capped: hitting target on the final
   allowed pass is a win.
3. **capped** — `pass >= hard_cap`.
4. **plateau** — best-so-far improved by `< min_delta`, comparing the best now against
   the best `plateau_window` passes ago (so it needs `plateau_window`+1 scored passes).
   Measured on the **best-score** series, not current, so a noise dip cannot reset it.
5. **running** — otherwise.

Two further code-owned guards live in the loop, not the gate: a **no-op** pass
(artifact byte-identical after ACT) → `error`; **spend over `budget_usd`** → `capped`.

**Done-branch confirmation (optional, `confirm_scorer_cmd`).** When the gate would declare
`done`, an INDEPENDENT confirm scorer re-scores the same output — but ONLY on the done edge, so
normal passes stay cheap and the skepticism is paid only at the finish line. If the confirm score
is below target, the `done` is VETOED (the editor likely gamed the primary signal): the loop keeps
running, steered by the confirm critique, still bounded by the cap/budget. This is the second layer
of verifier robustness above `composite` (multi-signal) — it catches a reward-hacked finish that a
single primary scorer would wave through. Same scorer contract; deterministic iff the confirm
scorer is. Wire it with `--confirm-scorer "<cmd>"` (e.g. a held-out test set or an independent judge).

**Escalation.** On the first `plateau`, if a stronger editor (`actEscalated`, default
`--model-escalate opus`) is available, the loop switches to it for one fresh window
(`escalationGrace`, default `plateau_window` passes) before plateau is re-judged. It
escalates at most once; the hard cap still bounds total passes. This is how a cheap
editor stays the default while Opus is paid for only when the loop *proves* it's stuck.
The escalated pass also runs in **rescue mode**: `buildEditorPrompt` reads `state.escalated`
and tells the strong editor a cheaper model plateaued here, so it makes a *bolder,
different-strategy* edit (still one file) rather than a pricier version of the same local tweak —
strength must change the edit STRATEGY, not just the model name. No retry ladder: one decisive
jump, because a plateau is evidence the cheaper config is already exhausted at this point.
Strength rises on BOTH dials in that one jump: the rescue editor also steps **effort** up to `high`
(`RESCUE_EFFORT`), while forward passes run at `--effort` (default `medium`, validated against
`low|medium|high|xhigh|max`). Editing is the easy half, so the editor stays cheap and `max` is
reserved for a judge scorer or a deliberate deep-stall override — never a fixed `max` every pass
(the frontier anti-pattern: uniform max budget wastes compute on the easy inputs).
`scorers/llm-judge.mjs` is the subjective-quality scorer (Opus-as-judge by default).

## 2. The scorer (a CLI the user supplies per task)

Invoked as: `<scorer_cmd> --output <produced-output> --loop-dir <dir> --pass <NNN>`.
Must print `{ score, critique, findings }` JSON to stdout; **exit 0** on success,
**non-zero** on scorer error (the driver halts `status=error` on any non-zero exit and
never fabricates a pass; `exit 2` is the recommended convention).

- `score`: number in `[0, 100]`.
- `critique`: non-empty string when `score < target` — "what to change to raise the
  score". It becomes the next ACT's steering input.
- `findings`: optional `[{ area, severity, suggestion }]`.

A scorer is valid iff it is deterministic given the same output+target (or documents
its nondeterminism), and honors the range + exit codes. The driver reads **only** the
score for the gate — it never re-derives it. `scorers/test-pass-rate.mjs` is the
reference (deterministic, zero extra deps).

**Composition (`scorers/composite.mjs`).** Scorers compose: `composite` runs N sub-scorers
(one raw command per line in a `--scorers-file` manifest, forwarding `--output/--loop-dir/--pass`
to each) and combines their scores by **min**, so the gate reaches `done` only when the
*weakest* dimension clears target. This hardens the gate — a green test suite no longer ships
if a paired security/robustness judge is still low. The critique steers the next edit at the
binding (min) dimension. A non-zero exit / non-JSON / out-of-range score from *any* sub-scorer
halts the composite with exit 2 (a broken dimension is never silently dropped). Deterministic
iff every sub-scorer is.

## 3. The act step (`act(state) -> { changed, costUsd }`)

The model edits **only** `artifact_path`, one coherent change, steered by
`state.last_critique` plus a code-owned **iteration ledger** (`buildLedger`: the recent score
trajectory, the best-so-far bar, and whether the last edit improved/regressed) so the editor does
not repeat a failed edit — the bounded middle between amnesia (last critique only) and the harmful
full-history context that degrades long refinement loops. The ledger is numbers-only, so it stays
trusted and outside the critique fence. `changed` is computed by the driver via a sha256 of the
artifact before/after (the no-op guard). `costUsd` is parsed from the headless
`claude -p --output-format json` result (`total_cost_usd`). Isolated in
`act-claude.mjs` because it is the costly, environment-sensitive part — everything
else is testable with a stub.

## state.json (code is the only writer)

```
goal, artifact_path, observe_cmd, scorer_cmd, confirm_scorer_cmd,
target_score(90), min_delta(1), plateau_window(3), hard_cap(10), budget_usd(null), model, effort(medium),
pass, last_critique, current_score, best_score, best_pass, spent_usd,
escalated, escalated_at_pass,   # set when a plateau triggered the stronger editor
status(running|done|capped|plateau|error), status_reason, started_at, updated_at,
history: [{ pass, score, critique_ref, snapshot, ts }]
```

## Run directory (`.loop/<run>/`, gitignored)

```
state.json
snapshots/iter_NNN.<ext>   verbatim artifact at end of pass NNN (iter_000 = baseline)
reviews/review_NNN.json    the scorer's {score, critique, findings} for pass NNN
```

`zip(snapshots, reviews)` over `history` is the full score trajectory — for
regression recovery, best-pass restore, and convergence study.

## Open questions for the dogfooding phase

- Cost control: wire `--mcp-config <empty>` by default? detect OAuth vs API-key auth?
- Regression policy: restore best snapshot when a pass regresses (keep-best) vs let
  the next critique recover (keep-latest)? Currently neither is enforced.
- Multi-file artifacts (a `git stash`/commit snapshot unit) vs strict single-file.
