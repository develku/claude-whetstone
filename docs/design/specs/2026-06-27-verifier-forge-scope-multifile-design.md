# Scope-Forge multi-file produce — design (codex-revised)

**Date:** 2026-06-27
**Status:** approved → implementation
**Builds on:** `2026-06-27-verifier-forge-scope-design.md` (scope MVP, single changed file)

## Context

The Verifier Forge learns durable verifier checks from a gaming event. Scope (repo) mode
works today for a recovery whose good/bad diff touches **exactly one file**:
`src/forge/scope-hook.mjs` refuses with `if (changed.length !== 1) return skip(...)`.

The **consume, store, and retire** sides are already multi-file:
- `composeConfirm` composes *all* `kind:'scope'` checks via `scorers/composite.mjs`.
- `store.mjs` keys a check on its full normalized cmd (which embeds `--rel <path>`), so distinct
  files yield distinct keys — no collision, no mis-dedupe.
- `pruneFlaky({kind:'scope'})` operates on the whole scope namespace.

So the entire feature is **the produce side**: lift the one-file cap and learn a per-file check
for each genuinely-gamed file in the recovery diff.

## codex cross-model review (folded in)

A codex leg reviewed the first-draft design and returned **REVISE before implementing**. The
material corrections, all folded into this spec:

1. **The cap is a coverage limiter, not "cost-only".** The first draft claimed "admit is the
   correctness filter, so the cap never costs a catch." This is **false**: `admitCheck` only filters
   *generated* candidates — it cannot rescue a gamed file the cap never generated for. If the gamed
   file sorts beyond `maxFiles`, its check is never proposed. Accurate framing: *admit prevents false
   admission among generated candidates; the cap genuinely bounds coverage.*
2. **Risk-order before capping.** Plain path order biases truncation toward alphabetically-early
   files. Order code-before-noncode (then path) so the cap drops the *least* likely-gamed files
   (docs/config) first.
3. **Surface truncation honestly.** Return `coverageComplete`; list `skippedFiles` with metadata;
   `log()` skips as "coverage incomplete — missed learning," never as a silent/cost-only drop.
4. **Cross-file prompt context.** Multi-file-*emergent* bugs (e.g. serialize in file A, deserialize
   in file B — each plausible alone) need the whole pattern. The per-file prompt gains the full
   changed-file list as context, while still asking for checks scoped to `rel`.
5. **Richer per-file return** so partial failure is visible, not hidden in concatenated totals.
6. **Lost-update (N store load/save):** codex rated per-file `runForge` "probably acceptable" and
   offered a batch-save alternative. **Decision: keep per-file `runForge`** — the cross-process
   lost-update hazard pre-exists identically in single-file Forge (one fire = one process doing
   sequential, key-idempotent, atomic-rename writes) and is **not worsened per-fire** by multi-file.
   Batch-save would need a `runForge` persist-flag or duplicated admit logic — scope creep for a
   pre-existing, rare, cross-process edge. Documented, deferred.

### Distinction from the rejected "extension pre-filter"

The operator rejected pre-filtering files by extension (it could *exclude* — and thus miss — a
genuinely-gamed file). Risk-ordering is **not** that: code-vs-noncode here only decides *priority*
when the cap forces truncation. Every changed file remains eligible if it fits within the cap. No
file is excluded by its extension; a code file with an unusual path simply sorts before docs.

## Design

All change is confined to the produce path. **Untouched (invariant):** `src/loop.mjs`,
`src/forge/run.mjs`, `src/forge/gate.mjs`, `src/forge/store.mjs`, `scorers/composite.mjs`,
`src/forge/prune.mjs`, `src/forge/admit.mjs`.

### 1. `rankChangedFiles(changed)` — pure helper (new, in `scope-hook.mjs`)

Deterministic order: **code files before non-code, then by path** (stable). Code = a small
extension allowlist (`.mjs .js .cjs .ts .jsx .tsx .mts .cts .py .go .rb .rs .java .php .swift .c
.cc .cpp .h .hpp`); everything else is non-code. Returns the same files, reordered — never drops.
Diff-magnitude ordering (numstat) is a deferred refinement; code-first+path suffices while the cap
default (8) rarely truncates code in a single recovery.

### 2. The produce loop in `runScopeForgeHook`

Replace the `changed.length !== 1` refusal with:

```
if (changed.length === 0) return skip('scope-forge: no changed files between good/bad')
const ranked = rankChangedFiles(changed)
const maxFiles = cfg.forgeMaxFiles ?? 8
const learnSet = ranked.slice(0, maxFiles)
const skippedFiles = ranked.slice(maxFiles).map((rel, i) => ({ rel, reason: 'cap', rank: maxFiles + i }))
if (skippedFiles.length) log(`scope-forge: coverage incomplete — ${skippedFiles.length} changed file(s) beyond --forge-max-files=${maxFiles} not learned: ${skippedFiles.map(s=>s.rel).join(', ')}`)
```

Materialize good/bad worktrees **once**. For each `rel` in `learnSet`, call `runForge` with
`generate` bound to `scopeGenerateCandidates({ ...a, rel, allChanged: changed, ... })` and
`kind:'scope'`. Accumulate per-file results. Then `pruneFlaky({kind:'scope'})` once, before the
`finally` cleanup. (`log` is injected via `deps.log ?? (() => {})` so tests can assert it and
non-CLI callers stay silent.)

### 3. Return shape (back-compat + additive)

```
{
  admitted:   [...all files' admitted],      // concat — existing readers unchanged
  rejected:   [...all files' rejected],      // concat
  candidates: [...all files' candidates],    // concat
  costUsd, tokens,                           // summed
  conflicts: [], excluded: [], corroborated: true,  // scope has no oracle yet — inert defaults
  // additive:
  perFile:    [{ rel, admitted: n, rejected: n, status }],  // status: 'admitted'|'none'|'error'
  skippedFiles,                              // [{rel, reason:'cap', rank}]
  coverageComplete: skippedFiles.length === 0,
  retiredFlaky?,                             // present iff prune tombstoned something
}
```

A per-file `runForge` that throws is caught → that file's `perFile` entry is `status:'error'`
(the fire does not abort; other files still learn).

### 4. `buildScopeGeneratorPrompt` — add `allChanged`

Add a "Files changed in this recovery: a, b, c" line (data block) so the model can reason about
cross-file invariants. Replace "Exactly ONE file changed" with "This file is one of the files that
changed in a gamed→honest recovery; propose checks scoped to THIS file." Accurate for N=1 too.

### 5. CLI — `--forge-max-files <n>`

`src/scope-cli.mjs` parses `--forge-max-files` → `cfg.forgeMaxFiles` (positive integer; default 8
applied in the hook, so an unset flag = 8). Usage string updated.

## Testing (TDD)

`test/forge-scope-hook.test.mjs` (extend):
- 2-file gaming diff → one scope check learned per gamed file (both stored, distinct keys).
- A refactor-only file in the diff → no check from it (admit filters: candidates pass good AND bad).
- Cap: `forgeMaxFiles:1` with 2 changed files → only the rank-0 file learned; `skippedFiles` has
  the other; `coverageComplete === false`; `log` called.
- `rankChangedFiles`: code before non-code, stable path order; never drops.
- Partial: one file errors in `runForge` → `perFile` shows `status:'error'`, others still learn.

`test/forge-scope-generate.test.mjs` (extend): prompt includes the `allChanged` list; check still
prepends `--rel <rel>` for the single target.

## $0 measurement — `bench/forge-scope-ledger.mjs`

Add a **2-gamed-file** scenario (a real git repo whose recovery fixes gaming in two files). Prove
$0/deterministic: both checks learned, both bite on a pristine checkout (veto gamed, pass honest),
both non-brittle (pass an alternate honest tree). Keep the existing single-file scenarios green.

## Verification

1. `node --test test/*.test.mjs` ≥409 green (expect ~415+).
2. `node bench/forge-scope-ledger.mjs` — multi-file scenario: learned=2, bites=2, non-brittle=2.
3. `git diff` confirms `loop.mjs`/`run.mjs`/`gate.mjs`/`store.mjs`/`composite.mjs`/`prune.mjs`
   byte-identical; single-file `--forge` path behaviour unchanged.
4. Commit with provenance (cite this codex leg); push; update memory.

## Deferred (YAGNI)

Diff-magnitude (numstat) risk ranking; batch single-save store write; real-model multi-file
elicitation (paid follow-up after the $0 ledger is green); per-file corroboration on scope;
multi-file-emergent *cross-file* checks (a check spanning two `--rel` targets).
