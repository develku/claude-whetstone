# decompose v2 — the planner tier (design spec)

> Status: **approved design, pre-implementation** (2026-06-25). Implements the **v2** row of
> [`docs/orchestrator-design.md`](../../orchestrator-design.md) — "this earns the word *orchestrator*."
> The MVP + v1 scope loop are merged (PR #1). This spec folds in a cross-model (Codex) adversarial
> review of the first design draft; the 7 review findings are addressed inline and tagged `[CR#n]`.

## 1. One-line decision

When the whole-repo scorer **plateaus on a coarse signal**, fan out one short child whetstone run per
**code-owned finding**, each with a narrower + harder gate the scorer itself emits, then let the
*unchanged* parent loop re-measure the whole repo. Decomposition is injected into the existing
`actEscalated` seam, so `runLoop` / `gateVerdict` / `recordPass` are **untouched**.

## 2. Two locked decisions (from the design dialogue)

- **D1 — child gate source = the scorer emits a validated, structured sub-gate.** A finding may carry
  optional `scope` and `scorer` fields (see §4). A finding **without** a usable `scorer` cannot be
  decomposed → the run honestly plateaus (code refuses to invent sub-goals from a coarse scalar).
  Backward compatible: scorers that don't emit these still work; decompose just won't fire.
- **D2 — escalation interaction = branch on findings inside the escalated slot.** The injected closure:
  decomposable findings present **and** genuinely at a plateau → decompose; otherwise → fall back to the
  existing opus single-editor "rescue" act. No `runLoop` change; v1 capability is not lost.

## 3. Architecture — where the new code lives

| Piece | File | Size | New? |
|---|---|---|---|
| `makeDecomposeAct` + pure helpers | `src/decompose.mjs` | ~120 lines | **new** (the only genuinely new decision logic) |
| `--decompose`, `--max-children`, `--child-cap`, allowlist wiring | `src/scope-cli.mjs` | ~20 lines | edit |
| `gitHead`, `gitTreeChanged` | `src/git-snapshot.mjs` | ~8 lines | edit |
| optional per-finding sub-gate emission (demo) | `scorers/test-pass-rate.mjs` | ~4 lines | edit |
| reused verbatim | `runLoop`, `gateVerdict`, `recordPass`, `restoreTarget`, `scope-context`, `scope-act` | 0 | unchanged |

## 4. Scorer contract extension (D1)

`findings[]` entries gain two **optional** fields. They are read only by decompose and are validated
before use — they are code-owned data, never executed as model votes:

```jsonc
{
  "area": "auth login rejects bad password",   // existing: human label / dedupe key
  "severity": "high",                            // existing
  "suggestion": "make this failing test pass",   // existing: becomes the child goal addendum
  "scope":  "src/auth",                          // NEW (optional): child EDIT pathspec, validated inside repo
  "scorer": {                                    // NEW (optional): the narrower, harder gate (NOT a raw string)
    "id":   "test-pass-rate",                    //   resolved against an allowlist of known scorer scripts
    "args": ["--cmd", "node --test", "--only", "auth login rejects bad password"]
  }
}
```

**Injection defense `[CR#4]`.** The previous draft let a finding carry a raw scorer *command string* that
flowed into `spawnSync(cmd, { shell: true })` — a shell-injection surface if `area` (a test name) carried
metacharacters. Instead:
- `scorer.id` is resolved against an **allowlist** of scorer scripts (default: the files under `scorers/`,
  plus any path the operator passes via `--scorer-allow <path,…>`). An id not in the allowlist → the
  finding is **not decomposable**.
- `scorer.args` is an **argv array**; decompose builds the child command as
  `node <resolved-allowlisted-path> <shq(arg)…>` (each arg POSIX-single-quoted, reusing `shq`). No
  finding-supplied string is ever concatenated into a shell command.
- `scope` is resolved against the repo root and **rejected if it escapes** (same guard shape as
  `safeSnapshotPath` in `state.mjs`).
- Boundary honesty: decompose guarantees no injection *into its own spawn*. How a scorer uses `area`
  *inside* its own gate is the scorer author's responsibility — exactly as in v1. The reference scorer takes
  `--only <area>` and applies it as `<cmd> --test-name-pattern <shq(area)>` (single-quoted literal), so the
  area never reaches a shell unquoted; it does **not** embed `area` into the `--cmd` string itself.

## 5. `src/decompose.mjs` — surface

`makeDecomposeAct({ repoDir, parentLoopDir, parentCfg, runChild, rescueAct, allowlist, maxChildren = 4, childCap = 3 })`
returns the escalated-slot closure `async (state) => { changed, costUsd, tokens }`.

Pure, unit-testable helpers (no spend):
- `coarseSignalPlateau(state)` → `gateVerdict(state).status === 'plateau' && state.best_score < state.target_score`. `[CR#1]`
- `readLatestFindings(parentLoopDir, state)` → parse `state.history.at(-1).critique_ref` review JSON; `[]` if none.
- `resolveSubGate(finding, { repoDir, allowlist })` → `{ editScope, scorerCmd }` or `null` (applies all §4 validation).
- `decomposable(findings, seen, ctx)` → findings with a non-null `resolveSubGate` and key not in `seen`.
- `splitBudget(remaining, n)` → per-child `{ budgetUsd, budgetTokens }` (`remaining/n` on each **set** dial; `null` stays `null`).
- `buildChildCfg(parentCfg, state, finding, subgate, share, childCap, parentLoopDir)` → child cfg.

The closure (the live part, integration-tested with a stub `runChild`). `ctx = { repoDir, allowlist }`;
`seen` is a closure-level `Set` created once per `makeDecomposeAct` (persists across passes in a run,
resets on `--resume`); `topBySeverity` / `remainingBudget` / `exhausted` / `left` (children still to launch)
are trivial inline helpers:

```text
if (!coarseSignalPlateau(state)) return rescueAct(state)         // [CR#1] only fan out at a real plateau;
                                                                 //        no-op-path entry lands here → rescue
fresh = decomposable(readLatestFindings(parentLoopDir, state), seen, ctx)
if (!fresh.length) return rescueAct(state)                       // nothing to decompose → bolder single edit
picked = topBySeverity(fresh, maxChildren)                       // [CR#6] bound fan-out width
log projectedFanoutCost(picked, childCap)                        // [CR#6] surface, don't hide
headBefore = gitHead(repoDir)
costUsd = 0; tokens = 0
for (f of picked) {
  remaining = remainingBudget(state, costUsd, tokens)            // [CR#6] recompute BEFORE each child
  if (exhausted(remaining)) { log('budget exhausted — stopping fan-out'); break }
  seen.add(key(f))                                               // dedupe across parent passes (resets on --resume)
  childHead = gitHead(repoDir)
  cfg = buildChildCfg(parentCfg, state, f, resolveSubGate(f, ctx), splitBudget(remaining, left), childCap, parentLoopDir)
  try {
    const { state: cs, verdict } = await runChild(cfg)           // [CR#3] spend is in cs.state.*, not cs.*
    if (verdict.status === 'error' || !cleanTree(repoDir)) gitRestore(repoDir, childHead)   // [CR#2]
    costUsd += cs.spent_usd; tokens += cs.spent_tokens
  } catch (e) { gitRestore(repoDir, childHead); log(`child failed: ${e.message}`) }         // [CR#2]
}
return { changed: gitTreeChanged(repoDir, headBefore), costUsd, tokens }                    // [CR#1 cost] / tree-diff
```

- `runChild` default = in-process `runFromConfig(childCfg, scopeDeps(childCfg))`. Children get **no**
  `--decompose`, so their `actEscalated` is the normal opus rescue → **depth cap 1** (cannot recurse).
- `changed` is computed by **tree diff** (`git diff --quiet headBefore HEAD`), not HEAD movement: children
  always commit (incl. `--allow-empty` baselines), so a fan-out that produced no real edit reads as an
  honest no-op and flows into `runLoop`'s existing no-op handling.
- Child spend returns to the parent; `recordPass` adds it to `spent_*` and `overBudgetVerdict` caps the
  **total**. Per-child share is the pre-cap, the parent aggregate is the post-cap.

## 6. CLI wiring (`scope-cli.mjs`)

- `--decompose` (default OFF). When set, `scopeDeps` sets `actEscalated = makeDecomposeAct({…})` instead of
  the plain opus rescue; the rescue act is still constructed and passed in as the closure's `rescueAct`.
- `--max-children N` (default 4; `1` = the conservative one-child-per-plateau mode), `--child-cap N`
  (default 3 — deliberately small `[CR#6]`), `--scorer-allow <paths>` (extra allowlist entries).
- **`--decompose` requires `--confirm-scorer`** `[CR#7]`. Refuse to start otherwise: the done-edge is then
  verified from a **pristine checkout** via the existing `gitVerifyAt`, so a decomposition cannot fake done
  through dirty-tree influence on the primary score. (The primary evaluate runs in the live dir; only
  `confirm` is clean-checkout — so for `--decompose` the confirm gate is mandatory, not optional.)
- **repoDir vs editScope `[CR#5]`.** `--scope` stays the **git repo dir** (cwd for editor/git/scorer). A
  finding's `scope` is an **edit pathspec** applied only to the child's prompt + read-only fence, never as a
  cwd. `buildChildCfg` always sets the child `repoDir = parent repoDir`; the editScope narrows *where it
  edits*, not *where git runs*.

## 7. Data flow

```
parent loop:  cheap editor plateaus ──gate──▶ actEscalated slot = decompose closure
   ├ coarseSignalPlateau && fresh decomposable findings
   │     └▶ sequential children (each: repoDir=parent, editScope=finding.scope, gate=finding.scorer,
   │         budget share, childCap, own gitignored loopDir) ── commits accumulate (self-commit trail)
   │         └ per-child transactional: error/dirty → git reset --hard childHead  [CR#2]
   └ else ─▶ opus single-editor rescue (fallback)                                  [CR#1]
parent evaluate:  whole-repo re-measure (automatic, every act) ─▶ gate → done/plateau/capped
parent done-edge: confirm scorer re-scores a PRISTINE checkout (gitVerifyAt)        [CR#7] (mandatory here)
```

## 8. Safety properties (verified against the code, with tests to lock them)

- **git keep-best on a shared branch is safe for normal completion** (Codex-confirmed): each child's
  baseline is the prior HEAD, so a child `reset --hard` to its own best snapshot only rolls back within its
  own commit range. The unsafe cases — child error / dirty tree — are closed by the per-child reset `[CR#2]`.
- **No loopdir pollution.** `git add -A` in the child could otherwise commit run dirs into the repo;
  `ensureLoopDir` writes a self-ignoring `.gitignore` (`*`) into every loop dir, so nothing under a loop dir
  is staged. Child loop dirs live under `<parentLoopDir>/children/<area-slug>/` (inherit that location).
  A test asserts the repo gains no `state.json`/`reviews/` after a fan-out.
- **Moat holds, conditionally** (Codex-confirmed): a child reaching 100 on its narrow gate while the repo
  regressed is *not* a moat break, because the parent re-runs the whole-repo scorer after any changed act
  before declaring done — **provided** decompose returns `changed` honestly, child failures are not ignored
  `[CR#2]`, and the done-edge is clean-verified `[CR#7]`.
- **Irreducible soft spot (state plainly):** code proves each leaf gate is measurable; it does **not** prove
  the *set* of sub-goals is sufficient for the whole-repo target. Mitigated by the whole-repo re-measure
  (a lazy/gamed decomposition wastes budget but cannot fake done), not eliminated.

## 9. Cost bounding (the fan-out tamer) `[CR#6]`

Total is bounded by **four** independent limits, any of which trips: `maxChildren` (width) · `childCap`
(depth per child, small default) · per-child budget **share recomputed before each launch** (stop when a set
dial is exhausted) · the parent's post-hoc `overBudgetVerdict` aggregate cap. With no budget set, the bound
is `maxChildren × childCap` sub-passes **per plateau pass**; the plateau-guard `[CR#1]` + dedupe stop it
from repeating every pass. Projected fan-out cost is logged before the first child.

## 10. Testing plan (TDD, no real spend)

`test/decompose.test.mjs`, using a fake on-disk review file, a fake `state`, and a stub `runChild` that
returns `{ state, verdict }` and optionally mutates a throwaway git repo:
- plateau-guard: `coarseSignalPlateau` false (running / no-op entry) → `rescueAct` called, no children. `[CR#1]`
- dedupe: same finding key across two passes → child run once.
- injection rejection: `scorer.id` not in allowlist, or `scope` escaping the repo → finding not decomposable. `[CR#4][CR#5]`
- child failure: stub returns `verdict.status==='error'` (or throws) → `gitRestore` to `childHead`, next child still runs, no contamination. `[CR#2]`
- cost aggregation reads `cs.state.spent_*`; sums returned; over-budget stops the loop. `[CR#3][CR#6]`
- `gitTreeChanged`: empty-commit-only fan-out → `changed === false`.
- no loopdir pollution after a fan-out (repo `git status` clean of run-dir files).
Integration reuses the `test/scope-loop.test.mjs` harness. `makeDecomposeAct`'s live spawn path is
validated manually (like `makeScopeAct`), not unit-tested.

## 11. Out of scope (YAGNI)

Parallel children / worktree isolation (sequential on the shared branch is simpler and safe); recursion
beyond depth 1; a standalone `decompose-cli` (wire through `scope-cli`); area→glob inference (D1 puts the
narrowing in the scorer, not in decompose).
