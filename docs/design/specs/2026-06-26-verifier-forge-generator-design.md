# Verifier Forge — brick 3: the generator (model proposes candidate checks)

> Status: **approved design, pre-implementation** (2026-06-26). Third of four bricks of the Verifier Forge
> (the "code owns the verifier LIFECYCLE" product; see memory `srank-verifier-lifecycle-thread`). Bricks:
> (1) admission meta-gate `admitCheck` [done] → (2) check store [done] → **(3) generator [this]** →
> (4) loop wiring + triggers. Standalone, unit-tested, **additive** (one new module) — the producer that
> feeds brick 1's admission and brick 2's store; the wiring that consumes it is brick 4.

## Why this brick

The store (brick 2) and admission (brick 1) can only *harden* the verifier if something **proposes** new
checks. Brick 3 is that producer: given a false-done (a gamed artifact that passed the gate) paired with an
honest artifact, a model proposes candidate verifier-checks that would discriminate the two. It does not
decide admission (brick 1), persist (brick 2), or fire (brick 4) — it only turns a gaming example into
**validated, allowlist-safe candidate checks**.

## The decision (one line)

`src/forge/generate.mjs` whose model-injected `generateCandidates` asks a model to propose checks as
`{scorerId, args[]}`, then parses and **resolves each through the operator allowlist** (the trust gate —
`resolveSubGate` reuse), returning validated candidates (resolved cmd + provenance). Generation only;
admission + storage + triggering are brick 4.

### Options resolved with the operator

- **Output form = `{scorerId, args[]}` via the allowlist (CHOSEN).** Over a flat model-authored shell
  string (REJECTED — executing a model string is the RCE-by-replay surface brick 2 flagged) and over
  generating a new scorer *script* (REJECTED/deferred — arbitrary code-gen needs sandboxing). The
  `{id,args}` + `buildAllowlist`/`resolveSubGate` pattern already exists in the repo (`scorers/test-pass-rate.mjs`
  emits exactly this shape), so it is the house-safe form — and it retroactively **closes brick 2's deferred
  trust boundary**: resolve at generation time, store the resolved flat cmd, brick 2 unchanged.
- **Boundary = generate-only (CHOSEN).** Over generate-and-admit (REJECTED — admission needs the good/bad
  reference artifacts, a brick-4 concern). Keeping brick 3 to "model → validated candidates" makes it a
  pure-ish unit testable with **zero model spend and zero artifacts**, mirroring how bricks 1 and 2 are each
  standalone.

## Architecture — one new module, no wiring

`src/forge/generate.mjs`, mirroring `admit.mjs` (pure logic first, thin injected adapter last).

**Pure (model/disk-free, unit-tested):**
- `buildGeneratorPrompt({ goal, goodContent, badContent, critique, scorerCatalog }) -> string` — trusted
  goal + scorer catalog; **untrusted** artifact bodies and critique fenced as reference-data (the editor/
  judge-prompt convention). Instructs: propose checks that PASS the good artifact and FAIL the bad one;
  respond as JSON only.
- `parseGeneratorResponse(text) -> [{ scorerId, args, rationale }]` — mirrors `scorers/llm-judge.mjs`
  `parseJudgeResponse`: extract the outermost JSON object, tolerate fences, validate shape (`scorerId`
  string, `args` array of strings); reject malformed.
- `resolveCandidate({ scorerId, args }, allowlist) -> { cmd } | null` — reuses `src/decompose.mjs`
  `resolveSubGate`: honor only an allowlisted `scorerId`, build `['node', shq(path), ...args.map(shq)]`;
  an unknown id → `null` (dropped). This is the trust gate.

**Injected adapter (only side-effecting):**
- `propose(prompt) -> { text, costUsd, tokens }` — default `claudePropose` spawns `claude -p` reusing the
  `act-claude.mjs` / `llm-judge.mjs` spawn + `extractCost`/`extractTokens` pattern.

**Orchestrator (pure given an injected `propose`):**
- `generateCandidates({ goal, goodArtifact, badArtifact, critique, scorerCatalog, allowlist, propose, maxCandidates = 5 })
   -> { candidates: [{ scorerId, args, cmd, rationale }], rejected: [{ scorerId, reason }], costUsd, tokens }`
   — read good/bad → build prompt → `propose` → parse → resolve each → resolved go to `candidates`,
   unallowlisted to `rejected`; cap at `maxCandidates`. **Does not** admit or store (brick 4).

## Why this shape (load-bearing facts)

- **Reuses the existing allowlist trust pattern** (`resolveSubGate` / `buildAllowlist`, `SUBGATE_UNSAFE`):
  the only honored form is `node <allowlisted-script> <shq args>`; an arbitrary model string can never run.
- **Reuses parse + spawn precedents** — `parseJudgeResponse` for fence-tolerant JSON, `act-claude` for the
  spawn + cost/token extraction. No new conventions.
- **Fences untrusted content** (artifact bodies + critique) as reference-data exactly like the editor/judge
  prompts; the goal + scorer catalog are trusted.
- **generate-only** keeps the good/bad artifacts and admission out of brick 3 — brick 4 supplies them
  (bad = gamed `best_pass` snapshot, good = honest snapshot, critique = the veto's `last_critique`) and runs
  `admitCheck` (brick 1) + `addCheck`/`saveStore` (brick 2).

## Testing (TDD)

- **Pure:** `buildGeneratorPrompt` fences untrusted content and lists the catalog ids; `parseGeneratorResponse`
  (valid / fenced / malformed-rejected / non-array-args-rejected); `resolveCandidate` (allowlisted id → shq
  cmd, unknown id → `null`).
- **Orchestrator** (injected `propose` stub, no spend): resolves candidates, drops unallowlisted into
  `rejected`, respects `maxCandidates`, surfaces `costUsd`/`tokens`.
- **Adapter:** thin — cover the parse path via the pure tests; do not spend on a live model in CI.
- **Full suite:** additive — new tests green, no existing file changed.

## Out of scope (later bricks — explicitly NOT here)

- **Triggering** (when the Forge fires) + sourcing good/bad from false-done detection — brick 4.
- **Running candidates through `admitCheck` + storing the admitted** — brick 4 (composition brick 3 → 1 → 2).
- **New scorer-*script* generation** (option C) — deferred (needs sandboxing of model-authored code).
- **exploit-regression admission leg** — brick 1.5.
