# CLAUDE.md — claude-whetstone

Guidance for Claude Code when working in this repo. Read `README.md` for the concepts and `SPEC.md`
for the file/scorer/gate contracts.

## What this is

A deterministic **loop-engineering** driver for Claude Code. The thesis is **code owns the gate**:
a pure function (`src/gate.mjs` `gateVerdict`) decides continue/stop; the **model** only diagnoses and
makes one edit per pass; a **scorer** only produces the 0–100 number. The single-file inner loop
(`driver.mjs`) is the **stable v1**; the whole-repo `scope` loop and the multi-objective `converge`
control plane are **beta — actively dogfooded** (supported and run for real, findings →
`docs/quality-loop/findings-register.md`), not yet stable-pinned like `driver.mjs`; their `done` stays
provisional until the known holes (leaf-set *sufficiency*, indirect scorer-capture) close.

## Golden rules — do not break these

- **The 8 invariant files are SHA-256-pinned** in `test/converge-invariant.test.mjs` and MUST stay
  byte-identical: `src/gate.mjs`, `src/loop.mjs`, `src/forge/run.mjs`, `src/forge/gate.mjs`,
  `src/forge/store.mjs`, `src/forge/prune.mjs`, `src/forge/admit.mjs`, `scorers/composite.mjs`. Change
  one only as a deliberate, justified hash bump — never as a drive-by edit.
- **Security controls fail loud.** A safety/isolation/gate control must **throw** on mismatch, never
  silently no-op — a green suite can hide a control that was disabled on an un-runnable (Docker/paid)
  path. Prove controls with an adversarial check, not just a passing test.
- **Never weaken the sandbox.** The behavioural scorers (`io-*`, `doc-exec`) run untrusted,
  model-authored candidate code inside the locked-down out-of-process child `src/iso-runner.mjs`
  (no fs-write, no network, no `child_process`). EXECUTE in the child, ASSERT in the parent.
- **Node ≥ 23.5 required** (Permission Model + `module.registerHooks`).

## Tests & gates (verify before claiming done)

- `npm test` — the full `node:test` suite. It must stay **green** (1229+ as of v1.12.0). TDD: write the
  failing test first; fix the implementation, not the test.
- Coverage floor 80%; branch coverage is a soft ratchet (non-deterministic spawn-race jitter).
- **Doc gate (split)** — two composed gates, run from the repo root:
  - **SPEC.md is the completeness surface** — `node scorers/composite.mjs --scorers-file examples/spec-gate.scorers --output SPEC.md` MIN-combines `doc-coverage` (recall vs the committed `scorers/doc-required.json` manifest) + `doc-lint` (precision). SPEC must substantively document **every** required flag / scorer / config-key / module — a table row, a heading with a body, or a prose line clearing the word floor — **never** a bare list item or a code-fence-only mention (those don't count). Add a new flag → document it in SPEC.md.
  - **README is lint + exec only** — `node scorers/composite.mjs --scorers-file examples/readme-gate.scorers --output README.md` runs `doc-lint` (refs resolve, version matches `package.json`) + `doc-exec` (every fenced `js` example importing from the repo runs in the iso child). The README is the readable concept/usage doc, **not** completeness-gated — keep the full reference in SPEC.md, not the README.
  - `scorers/doc-required.json` is the editor-unwritable required-token oracle; a drift-tripwire test (`test/doc-required.test.mjs`) asserts it matches `driver.mjs`'s flags.

## Docs & diagrams

- `README.md` describes **what the tool does and why** (concepts + usage). The complete flag / scorer /
  config / module reference lives in `SPEC.md` (the completeness-gated doc); release history goes in
  `CHANGELOG.md`. Don't grow the README with reference tables — add them to SPEC.md.
- **Diagrams**: edit the HTML design source (`assets/whetstone-*.html`) first, then hand-port the layout
  to a **native SVG** — GitHub strips raw HTML and SVG `<foreignObject>`, so the committed diagram must
  be native SVG. SVG has no auto-wrap: use a card-stack layout, pre-split lines by hand, and stack a
  vertical spine label as per-letter `tspan`s (`dy`), not a rotated string.

## Release ritual

- Bump `package.json` + `.claude-plugin/plugin.json` in lockstep. Add a `CHANGELOG.md` entry. The README
  status-line version must equal `package.json` (`doc-lint` enforces it). Squash-land to `main`.
- The plugin **snapshots** into `~/.claude/plugins/cache/`; refresh it with a version bump then
  `claude plugin marketplace update whetstone` and `claude plugin update whetstone@whetstone` (the
  `plugin update` arg must be the fully-qualified `whetstone@whetstone`).

## Where things live

`src/gate.mjs` pure gate · `src/loop.mjs` control flow (deps injected) · `src/driver.mjs` CLI + wiring +
config · `src/act-claude.mjs` the headless `claude -p` edit step · `scorers/` the 0–100 scorers ·
`src/forge/` per-file verifier learning · `src/converge*.mjs` the beta control plane ·
`src/iso-runner.mjs` / `src/prompt-fence.mjs` / `src/blast-radius.mjs` the hardening primitives.

## Working style

Conventional, imperative, English commit messages (attribution disabled). Simplicity and surgical
changes — don't refactor what isn't broken. Grow verifier **depth** before breadth: the gate is only as
strong as its scorer.
