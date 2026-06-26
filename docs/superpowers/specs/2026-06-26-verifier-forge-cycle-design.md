# Verifier Forge — brick 4a: the Forge cycle (produce)

> Status: **approved design, pre-implementation** (2026-06-26). Brick 4 (loop wiring + triggers) is the
> final Forge brick and the only one that touches existing loop code, so it is **decomposed** into **4a (the
> Forge cycle — produce)** and **4b (gate consumption)**. This is **4a**. Bricks: (1) admitCheck [done] →
> (2) check store [done] → (3) generator [done] → **(4a) cycle [this]** → (4b) gate consumption. 4a FILLS
> the store from a recovered false-done; 4b (later) wires stored checks into the gate so future runs face a
> harder verifier. Until 4b lands, 4a accumulates checks that nothing yet consumes — that is the intended,
> independently-shippable boundary.

## Why this brick — and the sourcing reframe

The Forge's producer needs a known-GOOD and a known-BAD artifact (brick 1 `admitCheck` admits a check only
if it PASSES good and FAILS bad; brick 3 `generateCandidates` prompts from the pair). Exploration found the
make-or-break gap: **mid-loop, there is no reliably-honest snapshot** — every snapshot only passed the
PRIMARY scorer, never the confirm scorer (the definition of "honest"), so at the moment of a veto no
known-good exists.

**The reframe that dissolves the gap:** do not fire at the veto. Fire at **run end, when a run RECOVERED to
true-done after ≥1 confirm/stability veto**. At that point both halves of the pair exist and are reliable:

- **bad** = the vetoed gamed snapshot (passed primary, failed confirm) — marked by `confirm_vetoed_at_pass`.
- **good** = the final artifact (just passed confirm — honest by definition).

Bonus: this is a **post-run** step (driver-level), so loop.mjs control flow is untouched — no regression risk
to the existing 312-green suite.

## The decision (one line)

A guarded post-run hook in `src/driver.mjs` `runPrepared` fires a new pure-ish `src/forge/run.mjs`
`runForge` when a **single-file** run recovered to true-done after a veto: it sources good/bad as above and
runs generate (brick 3) → admit (brick 1) → store (brick 2), filling the check store.

## Scope boundary

- **Single-file artifact runs only.** `generateCandidates`/`admitCheck` read artifact CONTENT
  (`readFileSync`, `scorerRunCheck`); scope-mode (multi-file repo) runs snapshot as git SHAs and treat a
  directory as the artifact — a different content model, **deferred**.
- **4a fills the store; consumption is 4b.** Stored checks do not yet feed any gate.
- **Out:** scope-mode Forge, exploit-regression (brick 1.5), budget-gating the generation, multi-veto
  collection — all later / YAGNI.

## Trigger (driver post-run — no loop.mjs control-flow change)

In `runPrepared`, after `runLoop` returns `{ state: final, verdict }`, fire ONLY when ALL hold (else no-op):
- `cfg.forge` (the `--forge` flag),
- `verdict.status === 'done'`,
- `final.confirm_vetoed_at_pass != null` — a veto occurred. (The marker is never cleared on a later
  confirm-pass, so at a `done` verdict it means "recovered from a veto at that pass"; `resume.mjs` already
  relies on `confirm_vetoed_at_pass === pass` meaning *currently* vetoed, so `!= null` with `done` is
  unambiguously "recovered".)
- `cfg.confirmScorerCmd` set (no confirm ⇒ no veto signal ⇒ nothing to learn from),
- `cfg.forgeStorePath` set (where admitted checks accumulate).

## Sourcing

- `bad = safeSnapshotPath(loopDir, final.history[final.confirm_vetoed_at_pass].snapshot)` — the gamed artifact.
- `good = final.artifact_path` — the confirmed-honest final.

## Architecture — one new module + one guarded driver hook

**`src/forge/run.mjs`** (the cycle; pure given injected pieces, mirroring admit/store/generate):

```js
export async function runForge({
  goal, goodArtifact, badArtifact, critique = '', scorerCatalog, allowlist, storePath,
  generate, admit, loadStore, saveStore, addCheck,
  replayRuns = 2, target = 100, maxCandidates = 5,
}) {
  const gen = await generate({ goal, goodArtifact, badArtifact, critique, scorerCatalog, allowlist, maxCandidates })
  const admitted = []
  const rejected = [...gen.rejected]                       // unallowlisted (from brick 3)
  for (const c of gen.candidates) {
    const v = await admit({ candidateCmd: c.cmd, goodArtifact, badArtifact, replayRuns })
    if (v.admit) admitted.push({ cmd: c.cmd, target, reason: v.reason })
    else rejected.push({ scorerId: c.scorerId, reason: v.reason })   // admit-rejected (discrimination/flaky)
  }
  if (admitted.length) {
    let store = loadStore(storePath)
    for (const a of admitted) store = addCheck(store, a)
    saveStore(storePath, store)
  }
  return { admitted, rejected, candidates: gen.candidates, costUsd: gen.costUsd ?? 0, tokens: gen.tokens ?? 0 }
}
```

`generate`/`admit`/`loadStore`/`saveStore`/`addCheck` are injected — `runForge` is unit-testable with stubs,
**zero model/disk** in tests.

**`src/driver.mjs` `runPrepared` post-run hook** (the ONE existing-file change — a guarded block, no loop
control-flow change): when the trigger holds, build the real pieces and call `runForge`:
- `generate = (a) => generateCandidates({ ...a, propose: (p) => claudePropose(p, { model }) })`
- `admit = (a) => admitCheck({ ...a, runCheck: scorerRunCheck })`  (both from `src/forge/`)
- store ops from `src/forge/store.mjs`; `storePath = cfg.forgeStorePath`
- `allowlist = buildAllowlist(cfg.scorerAllow)`; `scorerCatalog` built from the allowlist ids + a small
  shipped-scorer usage map (default `''` for custom ids) so the model knows each scorer's args.
- log a one-line summary (`{ admitted: n, rejected: m, costUsd }`); the generation cost is reported, not
  budget-enforced (a single post-run `claude -p` at `--max-turns 1`).

CLI (scope-cli / driver arg parsing): `--forge`, `--forge-store <path>`, optional `--forge-catalog`.

## Why this shape (load-bearing)

- **Post-run hook, not a loop seam** → loop.mjs untouched → no regression to the 312-green suite.
- **Reuses bricks 1/2/3 as injected pieces** → `runForge` is pure and stub-testable; the driver hook is the
  thin I/O wiring.
- **The recovered-veto reframe** is the only place a reliable good/bad pair exists; mid-loop cannot supply it.

## Testing (TDD)

- **`runForge` (injected stubs, $0):** generate→admit→store happy path (admitted checks land in the store via
  addCheck/saveStore); admit-rejected candidates excluded and surfaced in `rejected`; empty candidates ⇒ no
  admitted, store never written; cost/tokens passed through from generate.
- **Driver hook trigger guard:** fires `runForge` only when done + veto + forge + confirm + store; no-op
  otherwise — assert via a stub `runForge` (called / not-called) using the `runFromConfig` deps-injection
  pattern (cf. `test/scope-loop.test.mjs`).
- **No model / no scorer spawn** in unit tests — everything injected.
- Full suite additive — new tests green; the one driver change is guarded so existing runs (no `--forge`)
  are byte-for-byte unaffected.

## Out of scope (4b / later)

- **Gate consumption** (stored checks → composite confirm scorer, via `scorers/composite.mjs` + `gitVerifyAt`
  isolation) — **brick 4b**.
- **Scope-mode (multi-file repo) Forge** — deferred (different artifact/snapshot model).
- **exploit-regression** admission leg — brick 1.5.
- **Budget-gating** the generation; collecting **all** vetoed passes (4a uses the last) — YAGNI.
