# Verifier Forge — scope (multi-file/repo) mode MVP

> Status: **implemented** (2026-06-27), 3 bricks. Extends the single-file Verifier Forge to a git repo.
> Design driven by a codex cross-model review (verdict proceed-with-changes). loop.mjs untouched throughout.

## Why / the gap

The single-file Forge learns→stores→consumes per-file behavioural checks. A scope run differs structurally:
a snapshot is a **git SHA** (not a file), the artifact is the **repo dir**, and the confirm is **`gitVerifyAt`**
(a pristine worktree checkout), not a shell-command scorer. `--forge` was refused on `--scope`.

## The design (codex-revised — key decisions)

1. **Check unit = per-file behavioural check.** A scope check is `io-assert`/`io-trace`/`contains` targeting ONE
   changed file, run with the worktree **root** as `--output` plus a path-guarded **`--rel`** (`src/safe-rel.mjs`
   `resolveOutput`). This keeps checks DATA-only and lets the existing string `composite.mjs` (MIN) be reused —
   **codex rejected the originally-planned function-valued composer** (non-serializable confirm, resume
   asymmetry); per-file `--rel` keeps `confirm_scorer_cmd` a plain string, so `composeConfirm` works unchanged.
2. **`kind` namespacing (codex's #1 change).** Store records gain `kind` ('file'|'scope'); `listActiveChecks` /
   `composeConfirm` filter by kind, so a scope check never poisons a single-file gate (the cmds differ via
   `--rel` so `checkKey` is already distinct; `kind` is the explicit filter). file records stay byte-identical.
3. **Materialize-and-hold (codex).** `gitVerifyAt` is sync and removes its worktree in `finally` — unusable for
   the awaited admit. `gitMaterialize`/`gitCleanup` check out the good/bad SHAs and HOLD both across the await.
4. **Scope generator** reads the changed file's honest+gamed bodies (not a bare diff — codex: a diff hides
   exports → pushes toward brittle `contains`) and PREPENDS `--rel`.

## Architecture (3 bricks)

- **Brick 1 (consume):** `safe-rel.mjs`; `--rel` on the 3 data-only scorers; `kind` in `store.mjs`
  (record + kind-filtered list fns); `composeConfirm` `kind` filter. Proven: a hand-seeded scope check BITES
  on a pristine checkout (`test/forge-scope-consume.test.mjs`, real git, $0).
- **Brick 2 (produce):** `git-snapshot.mjs` `gitMaterialize`/`gitCleanup`/`gitDiffNames`/`isSha`;
  `src/forge/scope-generate.mjs`; `src/forge/scope-hook.mjs` (`runScopeForgeHook` — source good=HEAD/bad=veto
  SHAs, 1-file MVP guard, materialize, `runForge` with `kind:'scope'`, cleanup in finally); `runForge` threads
  `kind`. `$0` ledger `bench/forge-scope-ledger.mjs`: produce 2/2 · bite 2/2 · non-brittle 2/2.
- **Brick 3 (wire):** `driver.mjs` composes with `kind: cfg.scope ? 'scope' : 'file'`; `scope-cli scopeDeps`
  injects `runForgeHook = runScopeForgeHook`; the `forgeUnsupportedOnScope` refusal is replaced by
  `forgeStoreInsideScope` (store must be OUTSIDE `--scope`) + `forgeNeedsStoreAndConfirm`.

## Trust / safety

Per-file checks stay DATA-only; `FORGE_UNSAFE_SCORERS` denylist still gates the allowlist; `--rel` is
repo-contained-guarded; `--forge-store` is refused inside `--scope` (the loop `git reset --hard`s the scope and
the editor could tamper); stored snapshot refs are `isSha`-validated before any worktree; materialized worktrees
are throwaway; `cleanTreeGuard` still protects the operator repo.

## Real-model elicitation — NON-NULL

`bench/forge-scope-realmodel.mjs` (sonnet, $0.49, `--stub` gives a $0 harness check): does a real model PROPOSE
a usable per-file scope check? **proposal 3/3 · 5/5 behavioural** (io-assert for pure `double`/`max`, **io-trace
for the stateful `counter`** — right type per surface, `--rel` correct) **· bite 3/3 · non-brittle 3/3**. Run
BEFORE the CLI wiring to de-risk the interface cheaply; it surfaced no `scope-generate` changes.

## Out of scope (deferred)

Multi-file / multi-check proposals (MVP refuses >1 changed file); corroborate-on-scope (`--forge-oracle`);
decompose interaction; scope `--resume` (the scope CLI has no resume branch).
