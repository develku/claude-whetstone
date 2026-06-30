# Verifier Forge — brick 4b: gate consumption (consume)

> Status: **approved design, pre-implementation** (2026-06-26). The final piece of brick 4 and of the
> Verifier Forge. Brick 4 = 4a (produce) + 4b (consume); this is **4b**. Bricks: (1) admitCheck → (2) store →
> (3) generator → (4a) cycle → **(4b) gate consumption [this]**. 4a fills the store from a recovered
> false-done; 4b makes the accumulated checks **bite**: at run start it composes the confirm scorer from
> base-confirm + the stored checks, so future runs face an ever-harder verifier. **This closes the
> verifier-lifecycle loop.**

## Why this brick

4a accumulates admitted checks but nothing consumes them — the store grows while the gate stays the same.
4b is the consumer: it wires the stored checks into the done-edge confirm so they actually veto future
gaming. This is the payoff of "code owns the verifier LIFECYCLE": the verifier hardens from its own past
failures.

## The decision (one line)

At run start (guarded by `--forge` with a store path), reuse `scorers/composite.mjs` to make the confirm
scorer `= MIN(base confirm, ...stored checks)`: load the store, write a manifest of `[base confirm cmd,
...check cmds]` into the loop-dir, and set `confirm_scorer_cmd` to a composite over that manifest. An empty
store → passthrough (base confirm unchanged).

## How it works

- `composite.mjs` reads `--scorers-file <manifest>` (one bare scorer cmd per line; `#` comments and blanks
  ignored via `parseScorerList`) and **auto-appends `--output/--loop-dir/--pass` to each line**, then combines
  by **MIN** (`combine`). So a stored cmd (`node /abs/contains.mjs --needle X`) lists **verbatim**.
- The MIN means ANY failing check (or the base confirm) vetoes the done-edge — exactly "a harder gate."
- A failing / erroring sub-scorer makes composite exit non-zero, which `runScorer` surfaces as a loud error
  in the confirm seam (same as any confirm failure today).

## Architecture — one new module + one guarded driver change

**`src/forge/gate.mjs`** (the consume side):
- `gateManifestLines(baseConfirmCmd, checks) -> string[]` — pure: `[baseConfirmCmd, ...checks.map(c => c.cmd)]`
  (the manifest body); returns `[]` when there are no checks (the caller treats that as passthrough).
- `composeConfirm({ baseConfirmCmd, storePath, loopDir, compositePath }, deps = {}) -> string` — the I/O
  orchestrator (injected `loadStore`/`listChecks`/`writeManifest` for testing): load the store via
  `loadStore(storePath)`; if `listChecks` is empty OR `baseConfirmCmd` is null, return `baseConfirmCmd`
  unchanged; else write the manifest (`gateManifestLines`) to `<loopDir>/gate-checks.txt` and return
  `node <compositePath> --scorers-file <manifest>`. `compositePath` defaults to the repo's
  `scorers/composite.mjs` (resolved from `import.meta.url`).

**`src/driver.mjs` `runPrepared`** (the one existing-file change — a guarded block after `validateConfig`,
before `buildContext` builds the confirm closure; **loop.mjs untouched**):

```js
if (cfg.forge && cfg.forgeStorePath) {
  const composed = composeConfirm({ baseConfirmCmd: state.confirm_scorer_cmd, storePath: cfg.forgeStorePath, loopDir })
  if (composed !== state.confirm_scorer_cmd) state = { ...state, confirm_scorer_cmd: composed } // immutable
}
```

`confirm_scorer_cmd` is set once and never mutated by `recordPass`, so the composed confirm propagates
through the whole loop.

## Why this shape (load-bearing)

- **Reuses composite.mjs verbatim** (MIN gate, flag-appending, per-sub timeout, loud errors) — no new
  scoring engine.
- **Inherent single-file isolation** — the stored checks live OUTSIDE the edited artifact (in the store +
  their own operator-allowlisted scorer scripts), so the editor cannot tamper with them; no `gitVerifyAt`
  worktree is needed for single-file (unlike scope-mode, which already isolates).
- **Immutable state update** — a new state object, consistent with the codebase's no-mutation rule.

## The false-positive risk (documented)

A stored check becomes a hard MIN-veto on every future `--forge` run. `admitCheck` guards false-positives at
admission (the check passed the admission-time good artifact), but a future honest artifact that legitimately
differs could be wrongly vetoed by a sticky check. With no retirement yet (tombstone — deferred), the
mitigation is: `--forge` is opt-in, and deleting the store file resets the verifier. A retirement mechanism
(append a tombstone, fold retired checks out of the active set, à la `confirm_vetoed_at_pass`) is the proper
future fix.

## Scope boundary

- **Single-file runs** (consistent with 4a). Scope-mode confirm already isolates via `gitVerifyAt`; scope-mode
  *production* was deferred, so scope consumption is moot here.
- **No retirement / weighting** — all stored checks are equal hard vetoes (the thesis: a harder gate).
  Retirement deferred.

## Testing (TDD)

- **`gateManifestLines` (pure):** base + N checks → `[base, ...cmds]` in order; no checks → `[]`.
- **`composeConfirm` (injected `loadStore`/`listChecks` + a capture for the written manifest):** non-empty
  store → returns a composite cmd referencing the written manifest, and the manifest content is
  `[base, ...cmds]`; empty store → returns `baseConfirmCmd` unchanged with no manifest written; null
  `baseConfirmCmd` → passthrough.
- **Driver integration:** `runFromConfig` with `cfg.forge` + a seeded store file → the run's
  `confirm_scorer_cmd` becomes the composite (assert via a confirm-seam spy or by inspecting the prepared
  state); without `--forge`, or with an empty store, `confirm_scorer_cmd` is unchanged. Zero real scorer
  spawn — injected/seeded store, stubbed confirm.
- Full suite additive; the guarded driver block leaves non-`--forge` runs byte-for-byte unchanged.

## Out of scope

- **Check retirement (tombstone)** — the proper fix for the false-positive risk. A later brick.
- **Scope-mode (multi-file) Forge** (produce + consume) — deferred.
- **Weighting / soft-combining** — YAGNI; MIN hard-veto is the thesis.
