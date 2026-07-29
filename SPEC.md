# whetstone contracts

The durable design record for **v1.14.1** — the complete, gated reference (flags, scorers, config,
modules). Three contracts make the loop work; keep them stable.

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
(artifact byte-identical after ACT) → `error`; **spend over `budget_usd` OR `budget_tokens`**
→ `capped` (two parallel cost dials — USD for API-key auth, tokens for a subscription/Max plan
where the USD figure is only a notional API-equivalent price).

**Forge triggers & consume (v1.8.0).** The Verifier Forge learns checks post-run on TWO disjoint
signals: a **recovered-veto** done (good/bad = final/vetoed snapshot — the original trigger) and an
**easy done** (1 edit pass, no confirm/stability wired; good/bad = final/BASELINE snapshot). Learned
checks are consumed at the next fresh run's start: with a base confirm cmd they compose MIN(base,
…checks); with NO base confirm a file-mode run now composes the gate from the store alone
(`composeConfirmFromStore`), so an unwired run that learned on run N is gated on run N+1 — which also
self-quiets the easy trigger. Checks from the easy pair pass the current final by construction (they
cannot veto the run that learned them; the payoff is strictly next-run).

**Thin-scorer suspicion (v1.7.0).** A run that reaches `done` in ≤1 edit pass with NO done-edge check
wired (`--confirm-scorer` / `--stability-runs`) also raises a code-owned warning in the final report
(`src/summary.mjs`) — fixed prose + numbers, never model text — flagging that the *scorer* may be thin,
not that the artifact is genuinely good. It stays quiet when the done edge already paid skepticism or
when convergence took real work.

**Done-branch confirmation (optional, `confirm_scorer_cmd`).** When the gate would declare
`done`, an INDEPENDENT confirm scorer re-scores the same output — but ONLY on the done edge, so
normal passes stay cheap and the skepticism is paid only at the finish line. If the confirm score
is below target, the `done` is VETOED (the editor likely gamed the primary signal): the loop keeps
running, steered by the confirm critique, still bounded by the cap/budget. An invalid confirm score
(outside 0..100, or missing) halts with `error`, the same invariant the gate holds the primary score
to. The veto is persisted (`confirm_vetoed_at_pass`) so a kill during the post-veto edit resumes as
`running`, not a false `done`. This is the second layer
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
Strength rises on BOTH dials in that one jump: the rescue editor steps **effort** up to a `high`
**floor** (`RESCUE_EFFORT` via `editorEffort` — never *below* your `--effort`, so escalation
only ever raises or holds effort), while forward passes run at `--effort` (default `medium`, validated against
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
- `usage`: optional `{ tokens, costUsd }` — the scorer's OWN model spend for this call
  (v1.6.0). The driver adds it to `spent_tokens` / `spent_usd` alongside the editor's, so a
  model-backed scorer (llm-judge pays a second `claude` call every pass) counts against the
  budget dials. Absent (every deterministic scorer) reads as 0. Done-edge stability/confirm
  probes and failed retry attempts remain uncounted — `--cap` stays the hard backstop.

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
halts the composite with exit 2 (a broken dimension is never silently dropped). Each sub-scorer also
gets its own wall-clock cap (5 min, `WHET_SUB_TIMEOUT_MS`) so one hung dimension can't wedge the
composite or leak as an orphan. Deterministic iff every sub-scorer is.

## 3. The act step (`act(state) -> { changed, costUsd, tokens }`)

The model edits **only** `artifact_path`, one coherent change, steered by
`state.last_critique` plus a code-owned **iteration ledger** (`buildLedger`: the recent score
trajectory, the best-so-far bar, and whether the last edit improved/regressed) so the editor does
not repeat a failed edit — the bounded middle between amnesia (last critique only) and the harmful
full-history context that degrades long refinement loops. The ledger is numbers-only, so it stays
trusted and outside the critique fence. Its semantic complement (v1.8.0) is the **area ledger**
(`src/area-registry.mjs`): scorer `findings[].area` sightings folded into `state.area_ledger` each
persist; areas attacked ≥2× with no best-score gain render into the prompt inside their OWN nonce
fence (TRIED-AREAS) — code decides WHICH areas qualify, the fence carries the scorer-authored strings
(they never enter the trusted region, even sanitized). `changed` is computed by the driver via a sha256 of the
artifact before/after (the no-op guard). `costUsd` and `tokens` are parsed from the headless
`claude -p --output-format json` result — `total_cost_usd` and the summed `usage` token counts
(input + output + both cache counts), feeding `spent_usd` and `spent_tokens` respectively. Isolated in
`act-claude.mjs` because it is the costly, environment-sensitive part — everything
else is testable with a stub. A FATAL editor exit (rate limit, API overload) is retried with backoff
(v1.7.0: 3 attempts, 2s/5s — the act twin of the judge's v1.5.1 retry) before the loop sees a throw;
the spawn-error path (ENOENT / ETIMEDOUT / ENOBUFS) still throws immediately (permanent, or re-pays the
10-minute timeout), `error_max_turns` stays non-fatal bounded progress, and a failed attempt's spend
stays uncounted (`--cap` is the hard backstop).

## state.json (code is the only writer)

```
goal, artifact_path, observe_cmd, scorer_cmd, confirm_scorer_cmd,
target_score(90), min_delta(1), plateau_window(3), hard_cap(10), budget_usd(null), budget_tokens(null), model, effort(medium),
pass, last_critique, current_score, best_score, best_pass, confirm_vetoed_at_pass, spent_usd, spent_tokens,
escalated, escalated_at_pass,   # set when a stall triggered a stronger editor (latest climb)
escalations, escalate_models,   # v1.6.0 ladder provenance: [{pass, rung}] per climb + the rung models in order
status(running|done|capped|plateau|error), status_reason, started_at, updated_at,
history: [{ pass, score, critique_ref, snapshot, ts }],
area_ledger: [{ area, first_pass, last_pass, seen_count, best_at_first }]   # v1.8.0 discard-memory (kept on --resume)
```

## Run directory (`.loop/<run>/`, gitignored)

```
state.json
snapshots/iter_<NNN>.<ext>   verbatim artifact at end of pass NNN (iter_000 = baseline)
reviews/review_<NNN>.json    the scorer's {score, critique, findings[, usage]} for pass NNN
```

`zip(snapshots, reviews)` over `history` is the full score trajectory — for
regression recovery, best-pass restore, and convergence study.

## Configuration (persistent defaults)

The cost/model knobs you repeat every run can live in a JSON config so they aren't retyped.
`loadConfig` reads `~/.config/whetstone/config.json` (personal) then `./whetstone.config.json`
(project — wins on conflict) and hands the merged object to `parseCli` as its defaults. Precedence:
**CLI flag > config file > built-in default**. Recognized keys (camelCase): `budgetTokens`,
`budgetUsd`, `hardCap`, `targetScore`, `model`, `effort`, `escalateModel`, `mcpConfig`. A missing
config is the normal case; malformed JSON throws a clear error rather than running with surprise
defaults. This is the answer to "`--budget-tokens` is awkward to size by hand" — set it once (each
pass burns ~100–150K tokens, so a per-run budget is roughly `cap × 150000`). Example:
`examples/whetstone.config.json`.

## 4. Flags — the full CLI surface

Everyday flags appear in the [README](README.md) usage guide; this is the complete `driver.mjs`
surface, one row per flag.

| Flag | What it does |
|---|---|
| `--artifact <path>` | the one file the loop repeatedly edits and re-scores each pass (required) |
| `--goal "<text>"` | the improvement objective handed to the editor every pass — the first positional arg if given, else this flag |
| `--scorer "<cmd>"` | the shell command that grades the artifact or observed output, producing the number the gate compares to `--target` (required) |
| `--target <N>` | the measured score that counts as done for the run |
| `--cap <N>` | the hard pass-count ceiling — the true stop; always set one so a paid loop can never run away |
| `--budget <USD>` | the dollar ceiling, checked after each completed pass so it may overshoot by one |
| `--budget-tokens <N>` | the token ceiling, the meaningful bound on a subscription plan where the dollar figure is only notional |
| `--confirm-scorer "<cmd>"` | an independent scorer re-run only at the done edge to veto a gamed finish and steer the loop onward |
| `--model <m>` | the editor model for forward passes (haiku / sonnet / opus) |
| `--model-escalate <m>` | the standing plateau-rescue ladder; a bare `fable` auto-expands to `opus,fable` so opus rescues first |
| `--no-escalate` | disable the plateau escalation ladder — a stuck run stays on the cheap editor and reports plateau |
| `--effort <level>` | reasoning effort for the editor's forward passes (`low`/`medium`/`high`/`max`, default `medium`); rescue rungs step it up independently |
| `--observe "<cmd>"` | a command that produces the artifact's real output (build or execute it) before scoring, instead of scoring the raw file |
| `--loop-dir <dir>` | where this run's `state.json`, `snapshots/`, and `reviews/` live; also selects which run `--resume` continues |
| `--plateau-window <N>` | how many recent passes the gate inspects when deciding the run has stalled |
| `--min-delta <X>` | the minimum best-score improvement across that window that still counts as real progress |
| `--stability-runs <N>` | re-run a candidate done artifact N times before accepting it, catching a pass that only looked done through run-to-run noise |
| `--resume` | continue a stopped run — its history, best score, snapshots, and spend all carry forward instead of starting over |
| `--mcp-config <path>` | an MCP config (e.g. `empty-mcp.json`) passed with `--strict-mcp-config` to suppress the default MCP tool surface during edits |
| `--allow-sibling-edits` | opt out of the blast-radius guard so the editor may also touch files beside the artifact |
| `--gate-audit` | opt-in, post-done: mutate the finished artifact and re-score a sample with the primary scorer, reporting its kill-rate (advisory only) |
| `--gate-self-probe` | opt-in, paid: mutate the accepted artifact against the composed confirm gate, and have Forge learn a check for any mutant the gate passes |
| `--forge` | opt-in: learn a new per-file verifier when a done is vetoed or reached too easily |
| `--forge-store <path>` | where Forge persists learned checks, outside the artifact's scope so a later pass cannot edit them away; required alongside `--forge` |
| `--scorer-allow <a.mjs,b.mjs>` | comma-separated allowlist of scorer script paths the Forge may run or generate checks against — the trust boundary |
| `--forge-oracle "<cmd>"` | repeatable; an independent operator-trusted scorer that must corroborate a veto before Forge learns a check from it |
| `--forge-mutation-admit` | strengthen Forge admission from "fails the one observed bad artifact" to "kills an oracle-confirmed mutant neighbourhood" |
| `--forge-mutation-threshold <X>` | the mutant kill-rate in `[0,1]` (default `0.75`) a candidate check must clear under mutation admission |
| `--forge-exploit-regression` | require an admitted check to also survive the executable exploit archive, rejecting one a known gaming pattern could dodge |
| `--forge-retire` | standalone maintenance command that tombstones a false-positive Forge-learned check without deleting its record |

## 5. Scorers — the shipped catalog

Every scorer honors the contract in §2. Objective scorers need no model; the subjective one calls a judge.

| Scorer | Axis / what it measures |
|---|---|
| `test-pass-rate` | runs a test command and scores the pass fraction — the deterministic reference scorer, zero extra deps |
| `contains` | checks the produced output for required substrings or patterns; a pure data comparison, no shell |
| `io-assert` | executes candidate code in the locked child and asserts a function returns the expected value |
| `io-trace` | records the call trace of executed candidate code and scores it against an expected sequence |
| `io-invariant` | runs candidate code and checks a stated invariant holds across generated inputs |
| `io-effect` | runs candidate code and scores its observable side effects against a declared expectation |
| `doc-lint` | precision — flags a claim the doc makes that the repo contradicts (a dangling ref, a wrong version) |
| `doc-coverage` | recall — scores the percentage of the committed required set substantively documented, excluding name-drops |
| `doc-exec` | executable accuracy — runs every fenced example that imports from the repo and scores the fraction that pass |
| `llm-judge` | subjective quality — an Opus judge scores against a rubric when good cannot be checked by code (nonce-fenced) |
| `composite` | MIN-combines N sub-scorers so the gate reaches done only when the weakest dimension clears target |
| `floor` | runs an operator command and gates a hard pass/fail floor beneath the measured score |

## 6. Config keys (persistent defaults)

Every knob you repeat has a camelCase key in `whetstone.config.json` / `~/.config/whetstone/config.json`
(project file wins). CLI flag beats config file beats built-in default.

| Config key | What it persists |
|---|---|
| `targetScore` | the `--target` counterpart — the score that counts as done for every run |
| `hardCap` | the `--cap` counterpart — the pass-count ceiling no unattended run may exceed |
| `budgetUsd` | the `--budget` counterpart — the dollar ceiling checked after each completed pass |
| `budgetTokens` | the `--budget-tokens` counterpart — the token ceiling, the real bound on a Max/Pro plan |
| `plateauWindow` | how many recent passes the gate inspects when deciding the run has stalled |
| `minDelta` | the minimum best-score improvement across that window that still counts as progress |
| `model` | the default editor model for forward passes |
| `effort` | the default reasoning effort for forward passes; rescue rungs step it up independently |
| `escalateModel` | the standing plateau-rescue ladder so the launcher stops asking per run |
| `mcpConfig` | a path to an MCP config passed through to suppress the default MCP tool surface during edits |

## 7. Hardening modules (opt-in, v1.9–v1.11)

| Module | What it does |
|---|---|
| `src/blast-radius.mjs` | code-enforces "edit ONLY the artifact": snapshots sibling files before an edit and reverts any the editor also touched, so a pass cannot launder score gains through files outside the artifact |
| `src/gate-audit.mjs` | `--gate-audit`, post-done: mutates the finished artifact and re-scores a sample of mutants with the primary scorer, reporting its kill-rate — advisory, never changes the verdict |
| `src/forge/gate-probe.mjs` | `--gate-self-probe`, paid: mutates the accepted artifact and runs the composed confirm gate against each mutant; a mutant the gate passes is a hole, and Forge learns a check that catches it |
| `src/prompt-fence.mjs` | the shared nonce-fence primitive: wraps untrusted, editor-influenced text (scorer critiques, TRIED-AREAS, doc-exec output) in an unforgeable per-run marker so it can never be read as instructions |
| `src/iso-runner.mjs` | the locked-down out-of-process child every behavioural scorer runs untrusted candidate code in — no fs-write, no network, no child_process — keeping that code out of the scorer's own process |
| `src/preflight.mjs` | two always-on, non-fatal warnings written to stderr before a run starts, both about what the editor INHERITS from the target's directory: `crossRepoPermissionWarning` fires when the target lives outside cwd and its own `.claude/settings*.json` carries a broad permission surface; `nestedClaudeConfigWarning` fires when the target sits inside a `.claude` tree at all |

**The nested-config hazard.** The editor spawns with cwd set to the artifact's own directory, and Claude
Code merges every `.claude` config it finds walking up from there. Point a loop at a file inside a live
config tree — a skill, a rule, a hook — and the editor inherits that tree's whole hook stack: it spends
its turn on hook ceremony, edits nothing, and the pass ends in ERROR. Measured on the maintainer's
machine, roughly USD 2.08 and 1.04M tokens for zero edits. `nestedClaudeConfigWarning` is a pure path
check with no filesystem access, so it cannot produce a false positive, and it is deliberately
independent of the permission check beside it: that burn happened with the target *inside* cwd and with
permissions that were never broad, so neither of the other check's conditions would have caught it. The
remedy the warning prints is to copy the artifact to a scratch directory outside every `.claude`
ancestor, run the loop there, and diff the result back by hand.

**The composed doc gate.** A doc fails two ways, so three scorers cover it under `composite`: `doc-lint`
(precision), `doc-coverage` (recall — walks the committed required-token set and scores the percentage
substantively documented, excluding bare name-drops and code-block-only mentions), and `doc-exec`
(executable accuracy — runs every fenced `js` example that imports from the repo in the locked-down
`iso-runner.mjs` child). `examples/spec-gate.scorers` gates this SPEC for completeness + precision;
`examples/readme-gate.scorers` gates the README for precision + runnable examples.

## 8. Run fit, and when a score may be trusted

Two judgments the code cannot make for you. Both are cheap to get wrong and expensive to discover late.

**Is the loop the right tool at all?** It earns its cost against a deterministic gate with a real
gradient — a pass/fail measure that moves when the artifact improves. Against a subjective judge it
does not, and the failure is structural rather than bad luck: judges anchor below 100, so `done` never
fires, and plateau detection keys off a running max that judge noise keeps bumping, so plateau never
fires either. The run therefore stops on its budget by construction, whatever the artifact is worth.
Measured on the maintainer's machine, same day: two `test-pass-rate` runs each converged in one edit
pass, at roughly USD 0.54 and USD 0.32. One `llm-judge` run over a 24KB prose artifact scored
71-78-72-72-80-74-72-83-88-66-82-74-63 — best at pass 8, worse afterwards — and stopped on budget, not
convergence, at roughly USD 12.34. For prose, one critique pass and a human edit is usually the better
tool; if you must loop it, use a tight `--cap` and expect the budget to bind.

**A score is not a result.** A deterministic run can reach 100 in a single pass and still have missed
the defect class entirely, because the assertions were written by whoever also wrote the fix. The
driver prints a thin-scorer suspicion warning when a run finishes suspiciously easily, and that warning
should be read as a finding. Before a run's diff is trusted, the gate wants an oracle its author did
not write:

- **Corpus replay is primary.** Run the candidate gate over real historical inputs and diff
  accept/reject per item against current behaviour. It works precisely because the corpus predates the
  task, so the gate cannot have been fitted to it. A corpus stops being an oracle the moment you revise
  the gate in response to it — after that it is development data, and re-qualifying needs an untouched
  partition or a different oracle.
- **Invented adversarial variants are secondary.** Mutations you author come from the same mental model
  as the assertions, so more of them adds ceremony, not independence.
- **`--confirm-scorer` counts only if genuinely held out** — not the same cases re-wrapped, and not a
  second suite derived from the same intended fix.
- **`--stability-runs` is for nondeterministic scorers only.** It detects noise, not blind spots. On a
  deterministic thin scorer it repeats the same mistake and suppresses the thin-scorer warning, which
  makes the report more misleading rather than less.
- **`--gate-audit` and `--gate-self-probe` are diagnostics, not qualification**, and
  `--forge-mutation-admit` validates forge-generated checks rather than your primary scorer.

Write the scorer and freeze it before editing starts, and keep it outside the directory the editor may
edit. A gate the editor can reach is not a gate — that is what `--scope`'s read-only enforcement
(`src/scope-guard.mjs`) and `src/blast-radius.mjs` exist to guarantee when the two must share a tree.

## Open questions for the self-hosting phase (running whetstone on its own codebase — dogfooding)

- Cost control: wire `--mcp-config <empty>` by default? detect OAuth vs API-key auth?
- Regression policy: **decided — keep-best is the enforced default.** `restoreTarget`
  (`src/regression.mjs`) rolls the best snapshot back over the artifact whenever a pass scores below
  the best so far; set `regression_policy: keep-latest` to opt out. (Resolved during dogfooding.)
- Multi-file artifacts: **in progress** — the `whetstone-scope` loop (`src/scope-*.mjs`) widens the
  artifact to a `--scope` dir with a git commit-per-pass snapshot unit and read-only gate fence (see
  `docs/orchestrator-design.md`).
