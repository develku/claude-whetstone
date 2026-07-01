# Whetstone hardening review — findings register (2026-06-29)

Source: a whole-repo final-hardening review (8 lenses + adversarial per-finding verification,
workflow `wz937t0zu`), an architecture/critique re-run (`wzkne1d98`), and two adversarial rounds
on the new `doc-lint` scorer (`wf_2314a5e3`, `wf_cf63fa17`). Every finding below was reproduced
empirically (a real run / test / cited code), not asserted.

Branch `feat/doc-lint-scorer` · PR #2 · contained fixes shipped in `2b55bc1` (doc-lint) and
`fe5e84e` (hardening). **962 tests green** (the count grows per fix; intermediate snapshots below — 924 at the
original review, 952 after #2/#3/#9-#10, 962 after the ultra-review MED follow-ups).

## FIXED + shipped (this session)

| # | Sev | Finding | Fix (commit) | Verified |
|---|---|---|---|---|
| 1 | CRITICAL | `src/safe-rel.mjs` `resolveOutput` was realpath-blind — an in-scope symlink escaping `--output` passed the lexical guard, and every `--rel` scorer follows it (`readFileSync`/`await import`) → out-of-repo read + import-RCE | realpath-contain both ends (`fe5e84e`) | E2E: read-leak & io-assert RCE both `exit 2`, marker never written; legit module still 100 |
| 5 | MED | (= #1 root, blue-team duplicate) | `fe5e84e` | as #1 |
| 6 | MED | `scorers/doc-lint.mjs` `PATH_TOKEN`/`MD_LINK` O(n²) ReDoS on a long slash-run line | bounded quantifiers (`fe5e84e`) | 100KB 12.8s→151ms; token-identity preserved (README still 100) |
| 7 | MED | `src/gate.mjs` strict-`<` plateau boundary unpinned (a `<=` mutation survived the suite) | boundary test (`fe5e84e`) | mutation `<`→`<=` now fails the new test |
| LOW | LOW | `src/scorer-safety.mjs` `scorerStem` dropped a leading dotfile prefix to `''`, letting `.composite.mjs` dodge the denylist | strip leading dots (`fe5e84e`) | RED→GREEN |
| — | HIGH×2 | doc-lint adversarial rounds: symlink existence-oracle + percent-encoding false-positive (+ a literal-`%XX` regression from the first fix) | `refResolves` realpath + both-spellings decode (`2b55bc1`) | both exploits E2E-closed; README 100 |

## FIXED + shipped — #2 (the deep one) and its dependents

| # | Sev | Finding | Fix | Verified |
|---|---|---|---|---|
| 2 | **CRITICAL** | `io-assert`/`io-trace`/`io-effect`/`io-invariant` `await import` the artifact **in the scorer process** → top-level code monkeypatches the oracle (`assert.deepEqual`/`stdout.write`) → forges `score 100`, defeating primary·confirm·held-out·Forge-admit | **Out-of-process isolation (Approach B): `src/iso-runner.mjs` (parent owns oracle, never imports artifact) + `src/iso-runner-child.mjs` (`node --permission` child) + `src/iso-execute.mjs` (execute half) + `src/iso-frame.mjs` (nonce frame + primitive-leaf serializer)**. Child denies `node:v8`/`inspector`/`vm`/`worker_threads`/`child_process`/`module` via `module.registerHooks` + scrubs `process.getBuiltinModule`/`binding`/`_linkedBinding`/`dlopen`; job (incl. nonce) over stdin (never on disk); allow-fs-read = realpath(src) + realpath(artifact dir) only | Full battery (H1/H2/A1-A5/heap/inspector/worker/getBuiltinModule/Array.push/stdin-steal) + exploit-archive regression across all 4 CLIs; **949 tests green** |
| 4 | HIGH | composite-MIN / confirm-veto / held-out can't detect a captured sub-scorer (a gamed io-* returns a genuine 100) | resolved-by-#2 (a gamed io-* now returns its REAL wrong observation → score 0) | exploit archive: oracle-override scores 0 on all 4 |
| 11 | MED | scorer-safety / Forge trust-boundary classes io-* as "DATA-only safe" — wrong; the danger is *importing artifact code*, not shell-arg exec | resolved-by-#2; comments fixed in `src/forge/hook.mjs`, `src/canonical-data.mjs` (safety = data-only args **+ out-of-process import**), io-* scorers stay allowlisted (now genuinely safe) | comment review |

**Design notes (corrections to the prior memo, learned during the build):** (a) `--permission` does NOT block the in-memory `v8.getHeapSnapshot()` — it survives and recovered the nonce in a red-team, so the `module.registerHooks` deny + `getBuiltinModule` scrub are load-bearing, not just `--permission`; (b) the ESM loader `realpathSync`-es the artifact, so `--allow-fs-read` must grant the REAL path and the child must be handed the real path (macOS `/tmp`→`/private/tmp`); (c) `--frozen-intrinsics` works and blocks the proto-hijack but is experimental + redundant given the primitive-leaf serializer — evaluated and omitted (the serializer is the real guard); (d) `module.register` (off-thread) is denied by `--permission` (it needs a worker) — the synchronous `module.registerHooks` is required.

**Adversarial verification (workflow `wf_40ba14a7`, 2026-06-29):** 5 independent bypass-family red-teamers (alt-introspection, fd3-framing, serializer-proto, parent-contract, io-execute) ran **77 distinct gamed-artifact attacks against the real scorers — 0 confirmed holes** (no wrong code scored 100). Code-review verdict: **ship** (951 tests). The review caught one MED (io-assert `undefined`→`null` over-coercion — a real discriminator-loosening I introduced; **FIXED**: the snapshot is now strict for assert/effect-returns/invariant, `undefined`→null kept only for io-trace's documented void-method case) and one LOW (an honest artifact importing a denied builtin → exit 2; **documented** as by-design — io-* check pure/stateful logic that never needs `v8`/`worker`/etc.). **951 tests green.**

## DEFERRED — other (surfaced for decision)

| # | Sev | Finding | Suggested fix |
|---|---|---|---|
| 3 | HIGH | ~~`src/act-claude.mjs` editor prompt uses a **forgeable static critique fence** (`----- END CRITIQUE -----`) instead of the nonce fence — prompt-injection breakout~~ — **FIXED `9333f1c`**: ported to the shared `fenceUntrusted` nonce fence (parity with scope-act/llm-judge); forgery-resistance test added; taxonomy `critique-injection` entry corrected (defense→`prompt-fence.mjs`, proof→the forgery test). power-reviewed (ship), 952 green | done |
| 8 | MED | ~~`src/gate.mjs` (the literal "code owns the gate" file) is absent from the byte-identity invariant tripwire, while its thin wrapper `loop.mjs` IS pinned~~ — **FIXED (PR #3, branch `fix/pin-gate-invariant`)**: pinned `src/gate.mjs` (sha `b0cb2139…`) → the set is now 8. **A cross-model design review** (Opus + a second model): REFINED-AND-PROCEED, both legs chose A (add); scope = gate.mjs only (not `converge-gate.mjs`, which is Track C's own product); comment framed honestly (a byte-drift tripwire forcing review, NOT a runtime/security/semantic guarantee). | done |
| 9 | MED | ~~`--parallel` runs editors **serially**; the speedup bench's "ran CONCURRENTLY" claim is **false**~~ — **CORRECTED `062d7f8`** (honesty fix): the false "concurrent"/"CONCURRENTLY" wording is replaced everywhere (converge-parallel.mjs header + comments, converge-cli.mjs, the speedup bench's user-facing string, the round test comment, README Alpha row) with the accurate framing — editors run SERIALLY (blocking `spawnSync`); the **real value is the single batched gate re-measure for N objectives** (one gated round vs N), NOT wall-clock speedup. True async concurrency = **deferred enhancement** (needs an async editor). |
| 10 | MED | ~~`raceChild` `setTimeout` can't fire while a sibling `spawnSync` blocks the loop; `killChild` is never wired into the CLI~~ — **CORRECTED `062d7f8`** (comments): documented that the `raceChild` timeout + `killChild` hook are DORMANT under today's blocking editor (the setTimeout can't fire mid-`spawnSync`; converge-cli doesn't wire `killChild`) — they are the harness for the future async editor. The actual per-child cap today is `spawnSync`'s own timeout+SIGKILL (`makeClaudeAct`). Wiring real async timeout/kill rides on the deferred async-editor work. |

## Ultra-review (2026-06-29, workflow `wf_627285d7`) — whole-branch follow-ups

A holistic 5-lens review of the ENTIRE branch (security-isolation, contract-regression, integration-seams,
test-quality, honesty-claims) with adversarial per-finding verification (25 agents). **Verdict: SOUND — zero
CRITICAL/HIGH.** Positive confirmations under adversarial check: the io-* contract is faithfully preserved across
the EXECUTE/JUDGE split; the exploit battery would catch a re-opened in-process import (proven by simulation);
the doc-lint/safe-rel/scorer-safety/gate tests are mutation-adversarial; headers/comments accurate; the readRoot
seam and the timeout/flood fail-safes work as designed.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| U1 | MED | isolation child inherited the FULL parent env → a gamed fn could return a secret (`EXA_API_KEY`/`*_TOKEN`) into the observation → critique → editor model (in-band; off-machine exfil already denied) | **FIXED `b605bd7`**: child spawned with an allowlisted env (`ENV_ALLOWLIST`); also excludes `NODE_OPTIONS` (can't widen the sandbox) |
| U2 | MED | no `engines` floor; child needs Node ≥23.5 (`registerHooks`) → on older Node an honest artifact silently scores 0 | **FIXED `b605bd7`**: `engines.node>=23.5.0` + a parent-side `meetsNodeFloor` guard → `reason:'runtime'` → clear scorer-error |
| U3 | MED | `classifyObservation` reason→exit/kind contract (comment claims "can't drift") had no direct test | **FIXED `b605bd7`**: `test/iso-runner-contract.test.mjs` pins the full mapping + `meetsNodeFloor` boundary |
| U4 | LOW | `plan-allowlist` "spawn NO subprocess" comment stale after #2 | **FIXED `d8e0bf9`**: reframed to the real basis (hardened no-shell spawn) |
| U5 | LOW | timeout/maxBuffer fail-safes + io-effect missing-export CLI path unguarded by tests | **FIXED `d8e0bf9`**: regression tests added |
| U6 | LOW | findings-register `<pending>` placeholder + stale `924` headline | **FIXED** (this commit): backfilled `062d7f8` + headline → 962 |
| U7 | LOW | `safe-rel` TOCTOU: a not-yet-materialized `--rel` returns the lexical path; an escaping symlink planted later would be followed at use time | **ACCEPTED RESIDUAL**: not escalatable — the artifact-under-test can't plant the symlink mid-gate (`--permission` denies fs-write), the scope dir is a static git-SHA worktree with no concurrent actor, and even an out-of-scope read has no exfil channel. Returning the realpath from `resolveOutput` would break its documented lexical-contained-path contract (tested). Revisit only if the threat model gains a concurrent writer. |
| U8 | LOW | io-trace/io-effect artifact-failure critique lost the `step`/`args` context vs the old format (score/exit identical) | **ACCEPTED (cosmetic)**: the critique still names the failure (e.g. `subject has no method "x"`); the full step array is a marginal diagnostic the loop doesn't need. Skipped per surgical-changes. |

## DEFERRED — LOW / INFO

- enforceReadOnly `reverted` **display** array off-by-one (`scope-act.mjs:26` `.slice(3)` on porcelain) — red-team confirmed **cosmetic only, enforcement is correct** (the revert uses the `readOnly` paths, not the parsed names). Needs the exact repro before touching.
- doc-lint `refResolves` re-runs `realpathSync(repoDir)` once per ref — **SKIPPED** (negligible: ~25 syscalls/pass on a once-per-pass scorer; surgical-changes).
- gate precedence orderings (`error>capped`, `error>plateau`, `capped>plateau`, `done>plateau`) only asserted indirectly — add explicit precedence tests.
- arch: two divergent state-mutation contracts (`converge.mjs` mutates in-place vs `loop.mjs`/`state.mjs` pure) — document the deliberate split in SPEC.
- arch: `converge-gate` "pure" `globalVerdict` reads fields a side-effecting upstream mutates — document or return new objects.
- arch: SPEC scorer-invocation contract omits the `--rel`/`--repo`/`--needle` dimension every scope scorer uses; the admit layer reverse-engineers scorer mode by grepping the command string for `--rel`/`--output`; converge-gate's `blocked` status + terminal `capped` meaning are undocumented in SPEC.
- critique: scorer CLI boilerplate (`arg`/`die`/`resolveOutput`) copy-pasted across all 10 scorers; vestigial `canonicalData` re-export in `io-effect.mjs`; **realpath-containment guard now duplicated between `safe-rel` and `doc-lint`** (created this session — fold into a shared leaf alongside #2's work); two parallel JSON walkers (`canonicalKey` vs `canonicalData`); `floor.mjs` arg-forwarding duplicates `composite`.
- concurrency INFO: a hung/timed-out parallel child leaks its git worktree (under tmpdir); `global_pass` can double-count on a crash-after-pre-spawn-save then resume; an escalated editor producing consecutive no-ops (→ error) is correct but untested.

## Coverage gaps in the review itself

- Approach C (vm.SourceTextModule) for #2 was unevaluated (the design agent failed on a tool retry-cap) — deprioritized anyway (needs `--experimental-vm-modules`, a portability cost whetstone avoids).
- The architecture/critique re-run did NOT deep-read the large orchestrators (`converge.mjs` 43K, `converge-cli.mjs`, `driver.mjs`, `plan-*`, `forge/*`) line-by-line — only their leaf deps. A scorer-contract-conformance lens (do all io-* honor exit-0/2 + 0..100 + `resolveOutput` uniformly?) is the suggested highest-value follow-up.
