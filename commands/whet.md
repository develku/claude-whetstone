---
description: Launch a whetstone loop — raise one artifact toward a measured score threshold, with cost guardrails and confirm-before-run
argument-hint: '[goal | resume]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, AskUserQuestion
---

You are the `/whet` launcher for **whetstone** — a deterministic loop-engineering driver
that raises ONE artifact toward a measured score threshold. CODE owns the stop/continue gate;
the MODEL only supplies edits. Each pass spawns a headless `claude -p --permission-mode
acceptEdits` editor that **spends real money** and **auto-accepts file edits**. Your job is to
assemble a SAFE invocation and get explicit confirmation **before** running anything.

The driver lives at `${CLAUDE_PLUGIN_ROOT}/src/driver.mjs` (no `bin`; invoke with `node`).

If `$ARGUMENTS` is `resume` (or the user asks to continue a prior run), follow **RESUME**.
Otherwise follow **NEW RUN**.

## NEW RUN

Collect these (use AskUserQuestion; treat any other inline `$ARGUMENTS` text as the goal):

1. **goal** — the objective, injected into every edit prompt.
2. **artifact** — the single file the loop may edit. Confirm it exists (Read it) before running.
3. **scorer** — how each pass is scored 0–100. Offer the three bundled scorers:
   - **test-pass-rate** *(deterministic; best default)* —
     `node ${CLAUDE_PLUGIN_ROOT}/scorers/test-pass-rate.mjs --cmd "<test command>"`
   - **contains** *(trivial canary)* —
     `node ${CLAUDE_PLUGIN_ROOT}/scorers/contains.mjs --needle "<text>"`
   - **llm-judge** *(subjective; ⚠ SPENDS MONEY per pass, nondeterministic)* —
     `node ${CLAUDE_PLUGIN_ROOT}/scorers/llm-judge.mjs --goal "<goal>" --mcp-config ${CLAUDE_PLUGIN_ROOT}/empty-mcp.json [--rubric @file]`
     (the judge spawns its OWN `claude -p` every pass — pass `--mcp-config` so it skips the ~44K
     MCP tax too, and count its per-pass spend in the cost estimate, not just the editor's).
   - or a **custom** shell command — warn the user it is exec'd with their full privileges
     (arbitrary code execution; no sandbox).
4. **target** — score that means done (default `90`).
5. **cost ceiling** — REQUIRE at least one of `--cap` (max passes, default `10`),
   `--budget` (USD ceiling), or `--budget-tokens` (total-token ceiling). **Do not proceed without
   an explicit bound.** On a **subscription (Max/Pro) plan, prefer `--budget-tokens`** — the
   `--budget` USD figure is only a notional API-equivalent price there, while tokens are what the
   rate limit actually counts. When the user wants a token ceiling but no number, **suggest
   `--budget-tokens ≈ cap × 150000`** — each pass burns ~100–150K tokens (mostly the recurring ~44K
   system-prompt tax plus cache), so a small number caps after a single pass. Persistent defaults for
   these knobs (`budgetTokens`, `budgetUsd`, `hardCap`, `model`, `effort`) can live in
   `~/.config/whetstone/config.json` or `./whetstone.config.json` (the driver loads them; CLI flags
   override) — values the config already supplies don't need to be re-asked.
6. **model** — default `sonnet`; suggest `haiku` for mechanical artifacts; warn that `opus`
   is ~$0.22+/call.

ALWAYS append `--mcp-config ${CLAUDE_PLUGIN_ROOT}/empty-mcp.json` — the driver runs each
editor under strict MCP mode automatically, suppressing the ~44K-token per-spawn MCP context
tax the project measured.

Then **show the user the fully assembled command and a worst-case cost estimate**
(cap × per-call cost for the chosen model; if the scorer is llm-judge, add its own per-pass
spend — roughly cap × (editor + judge)) and ask for explicit confirmation. Only after they
confirm, run it with Bash. Pass an **absolute** `--artifact` and an absolute `--loop-dir <dir>`
to choose where the `.loop/` run state lands, so the run does not depend on the cwd:

```
node ${CLAUDE_PLUGIN_ROOT}/src/driver.mjs "<goal>" \
  --artifact <abs path> --scorer "<scorer>" --target <N> --cap <N> [--budget <X>] \
  --model <model> --mcp-config ${CLAUDE_PLUGIN_ROOT}/empty-mcp.json --loop-dir <abs run dir>
```

Report the final verdict + score trajectory the driver prints.

## RESUME

Continue a stopped run from its `state.json`. Ask for the run dir (`--loop-dir`) and which
limit to raise. Resume **refuses** unless you raise the binding limit (`--cap` or `--budget`)
above what stopped the run. Only the flags you pass override; everything else is restored from
`state.json`. Show the command, confirm, then run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/driver.mjs --resume --loop-dir <dir> \
  [--cap N] [--budget X] [--target T] [--model M]
```

## SAFETY — never skip

- Never run the driver without an explicit cost bound (`--cap` and/or `--budget`) **and**
  explicit user confirmation of the exact command.
- `--budget` is checked AFTER each pass completes, so a run can overshoot it by up to one
  pass's cost. Treat `--cap` as the real hard ceiling and pair `--budget` with it — never rely
  on `--budget` alone as a precise stop.
- A custom `--scorer` / `--observe` string is **arbitrary code execution** with the user's full
  privileges (no sandbox) — confirm the user trusts it before running.
- The editor runs **unattended** with `acceptEdits` in the artifact's directory and inherits
  THAT project's permission config. Never point `/whet` at a repo whose `settings.json` /
  `CLAUDE.md` grants broad write/exec permissions — the loop will auto-accept edits there every
  pass with no human in the loop. Point it at the artifact's own project, scoped so the edit is
  permitted but the blast radius is just that artifact.
