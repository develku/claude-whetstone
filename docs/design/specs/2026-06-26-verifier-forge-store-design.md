# Verifier Forge — brick 2: the check store (verifier memory)

> Status: **shipped** (2026-06-26). The second of four bricks of the Verifier Forge (the "code owns the
> verifier LIFECYCLE" product; see memory `srank-verifier-lifecycle-thread`). Forge bricks: (1) admission
> meta-gate `admitCheck` [done] → **(2) check store [this]** → (3) generator → (4) loop wiring + triggers.
> Standalone, unit-tested, **additive** (no existing file changed) — the memory brick 1 admits into.

## Why this brick

Brick 1 decides *if* a candidate verifier-check may join the trusted set; it has nowhere to put the
admitted check. There is no persistent store of checks anywhere in the repo — each loop-dir is
self-contained, so nothing accumulates across runs. Brick 2 is that **memory**: an append-only catalogue
of admitted checks so over runs the trusted verifier set grows and future gates get harder. It does not
re-run admission (brick 1 did), generate checks (brick 3), or wire them into a gate (brick 4).

## The decision (one line)

A small, additive `src/forge/store.mjs` persists each admitted check as a **flat `cmd` string + `target`**
(the shape brick 1 already speaks), with content-keyed idempotent dedup, immutable append, and a
crash-safe atomic file adapter that **fails loud** on a corrupt store.

### Options considered

- **A — flat `cmd` + `target` (CHOSEN).** Matches brick 1's `candidateCmd` and the shipped `shell:true`
  scorer-execution model; smallest additive store; brick 1↔2 stay coherent.
- **B — structured `{scorerId, args[]}` via the `resolveSubGate` allowlist (REJECTED for now).** A harder
  trust boundary (the candidate is ultimately model-proposed, so brick 4 replaying a stored flat string is
  RCE-by-replay). Rejected because there is **no producer of model-authored cmds until brick 3** — hardening
  a boundary with no traffic is premature, and it would push a shape change back into brick 1/3. The
  `version: 1` field lets the on-disk format migrate to shape B when brick 3 lands.

## Architecture — one new module, no wiring

`src/forge/store.mjs`, mirroring `admit.mjs` (pure logic first, thin I/O adapter last). Append-only is
enforced by **API surface**: `addCheck` only — no remove/edit exists.

**Pure (unit-tested, zero disk):**
- `emptyStore() -> { version: 1, checks: [] }`
- `checkKey({ cmd, target=100 }) -> sha256(normalize(cmd) + ' ' + target)` hex. `normalize` = trim +
  collapse internal whitespace. `target` is in the key (same scorer at two thresholds = two gates); the
  separator split is unambiguous because `target` is a space-free number and `cmd` is trimmed.
- `addCheck(store, { cmd, target=100, reason=null, ts }) -> store` — immutable append, **idempotent**
  (same key → same object, so a caller detects the no-op). Throws `TypeError` on an empty `cmd` or a
  non-finite `target` (both are un-runnable / gate-breaking — silent corruption, refused at the boundary).
- `listChecks(store) -> [{ cmd, target, reason }]` — the read projection brick 4 consumes (cmd+target
  reconstruct a verdict via `scorerRunCheck`; `reason` powers veto messaging). A defensive copy.

**Thin I/O adapter (only side-effecting):**
- `checkStorePath(dir) = join(dir, 'checks.json')` (mirrors `statePath`).
- `loadStore(path)` — absent → `emptyStore()`; malformed (bad JSON, or any entry failing the same
  cmd/target boundary as `addCheck`) → **throw loud, naming the path**. A silently-empty verifier memory
  would *lower* the gate — the dynamic analogue of the taxonomy's static integrity-lock test.
- `saveStore(path, store)` — atomic `.tmp` + `rename` (mirrors `saveState`). Deliberately **no
  `redactSecrets`**: a verifier cmd is operator/scorer-authored and must round-trip verbatim to stay runnable.

`isoNow` is replicated locally (not imported from `state.mjs`) to keep the Forge a standalone lower layer,
exactly as `admit.mjs` imports nothing from `state.mjs`.

## Why this shape (load-bearing facts)

- **Reuses the scorer contract** — a stored `cmd` is a scorer command; brick 4 runs it via the existing
  `scorerRunCheck` (`score >= target -> pass`), no new execution path.
- **Boundary validation both ways** — `addCheck` (construction) and `loadStore` (a possibly hand-edited or
  foreign file) enforce the *same* cmd/target invariant, so corruption cannot enter from either direction.
- **Atomic + append-only** — a kill mid-write leaves the prior store intact; the absence of a mutate/delete
  method is the append-only enforcement (cf. how code owning `saveState` enforces "the model never writes
  state").

## Out of scope (later Forge bricks — explicitly NOT here)

- **Trust-boundary hardening (option B)** — store `{scorerId, args[]}` behind the `resolveSubGate` allowlist
  so brick 4 never executes a free-form model string. → brick 1.5 (isolation) / brick 3 (first model-cmd producer).
- **Retirement of a later-bad check** — retire from the active gate without deletion (append a tombstone, à
  la `confirm_vetoed_at_pass`), reconciling "preserve every false-done" with "a false-positive check blocks
  honest fixes." → brick 4. The entry omits a `status` field so adding it stays additive.
- **Cross-run scope / where the store lives** — the API is location-agnostic (path param); the where-policy
  → brick 4. **Content-addressed reference blobs, concurrency/locking** → brick 1.5+ / brick 4.
- **Per-entry key re-validation / signed integrity chain** — over-engineering for a single-user local tool;
  shape validation already rejects structurally-broken stores.
