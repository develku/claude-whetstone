# Whetstone Quality Loop — Findings Register

Persistent, cross-cycle registry of quality findings. The loop dedups against this
so cycles don't re-surface known items. See `RUNBOOK.md` for the process.

**Status values:** `open` (found, not yet verified) · `verified` (adversarially
confirmed real) · `fixed` (resolved + committed + gate green) · `deferred` (real but
postponed, with reason) · `wontfix` (rejected — not a real issue / behavior is
intentional / not worth the cost).

**Severity:** CRITICAL · HIGH · MEDIUM · LOW.

---

## Coverage baseline (ratchet floor)

Via `npm run coverage` (src + scorers, deterministic). Ratcheted up by cycle 1.

| Metric | Cycle 0 | Cycle 1 | Cycle 2 | Cycle 3 | Cycle 4 (2026-06-30) | Audit (2026-07-02) | Cycle 5 (2026-07-02) |
|--------|---------|---------|---------|---------|----------------------|--------------------|----------------------|
| Line | 96.03% | 96.10% | 96.27% | 96.31% | 96.31% | 96.42% | **96.42%** |
| Branch | 82.15% | 82.54% | 82.89% | 83.11% | 83.48% | 84.12% ◇ | **84.03%** ◇ |
| Function | 91.83% | 92.12% | 92.28% | 93.73% | 93.89% | 94.22% | **94.22%** |

The loop must not drop below the latest column; ratchet **line / function** (stable, exact) upward as
coverage improves.

◇ **Branch floor recalibrated in cycle 5 (84.12 → 84.03).** Branch coverage is NOT deterministic — it
jitters across ~[84.03, 84.12] run-to-run because three spawn-based tests flip a branch on an
*already-covered line* depending on subprocess-scheduling timing: `converge.mjs`, `act-claude.mjs`, and the
**invariant** `loop.mjs` (which cannot be stabilized without touching a tripwired file). The audit's 84.12
was the band's *peak* (all three fully covered in that one run), so HEAD — byte-unchanged — cannot reliably
reproduce it (empirically 84.03/84.06/84.09/84.12 across runs). The branch floor is therefore the reproducible
**minimum**: a genuine regression drops below it, jitter within the band does not. Line (96.42) and function
(94.22) are stable and stay exact ratchets. This is a SOFT, manually-compared ratchet (RUNBOOK gate item 4);
no automated gate reads it. Provenance: cycle-5 QL-01.

---

## Register

### Seeds (cycle 0)

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| Q-001 | coverage | — | (whole repo) | wontfix | **Audit overclaim corrected.** Setup audit claimed "17 untested modules / no coverage tool"; measurement shows 96% line coverage — modules are exercised via integration tests, not dedicated unit files. Premise invalid. |
| Q-002 | coverage | LOW | `scorers/io-trace.mjs` | fixed | Branch 37%→50%; CLI guard tests added (cycle 1, `86c92e1`). |
| Q-003 | coverage | LOW | `scorers/io-effect.mjs` | fixed | Branch 55%→58%; scalar `--expect-returns` guard test added (cycle 1, `86c92e1`). |
| Q-004 | correctness/security | MEDIUM | `src/act-claude.mjs` | fixed | NaN-coercion `|| 0` guard pinned for present-but-non-numeric cost/token fields (cycle 1, `86c92e1`). |
| Q-005 | simplification | LOW | `src/safe-rel.mjs`, `src/plan-resolve.mjs`, `src/scope-cli.mjs` | wontfix | Adversarial verify CONFIRMED the differences are load-bearing (throw-vs-null, realpath-vs-pure, root-allowed-vs-rejected); unifying would re-open the symlink import-RCE the io-* epic closed. No change. |
| Q-006 | coverage | LOW | `src/outer-cli.mjs`, `src/replan-cli.mjs`, `src/plan-cli.mjs` | deferred | Function coverage 64–71% on alpha-tier CLIs (Track A / dynamic control plane, maintainer-marked alpha-unsupported). Lower value until those graduate. |
| Q-007 | security | LOW | `src/iso-frame.mjs` | wontfix | Verified during the 2026-07-02 audit → NOT exploitable. The guarantee is nonce SECRECY, not marker distinctness: the 64-bit `randomBytes(8)` nonce is passed over stdin (off-disk) and heap-recovery is denied (`node:v8` in the child DENY set), so a forged `<<nonce>>` frame requires a 2^-64 guess. A nonce-collision inside the payload degrades to unparseable → score 0 (fail-safe), never a forged pass. Covered by the A2 fd-forge + heap-snapshot-deny tests. No change (no defensive code for an impossible case). |

### Cycle 1 (2026-06-30) — adversarial 4-axis audit (13 candidates → 12 verified → 11 fixed)

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| C1-01 | correctness | HIGH | `src/converge-state.mjs` | fixed | Manifest-declared global budget was validated then dropped (enforcement read cfg only) → unattended fan-out ran with no pool cap. Folded manifest budget into `initConvergeState` (`3d4f426`). |
| C1-02 | correctness | MEDIUM | `src/converge-cli.mjs` | fixed | `noEscalate: argv.includes()` forced `false`, killing the `?? true` default → converge children escalated (cost 2×) and diverged from outer-cli. CLI now yields `undefined`-when-absent (`0a67eee`). |
| C1-03 | security | MEDIUM | `src/state.mjs` | fixed | `safeSnapshotPath` was realpath-blind → in-dir symlink escaped containment on `--resume`. Mirrored `safe-rel.mjs` realpath re-check (`9547a4d`). |
| C1-04 | simplification | LOW | `src/state.mjs` | fixed | Dead export `setStatus` (zero callers) removed (`1c934c3`). |
| C1-05 | simplification | LOW | `src/state.mjs` | fixed | Dead export `snapshotExists` + orphaned `existsSync` import removed (`1c934c3`). |
| C1-06 | coverage | LOW | `scorers/io-trace.mjs` | fixed | = Q-002 (`86c92e1`). |
| C1-07 | coverage | MEDIUM | `scorers/floor.mjs` | fixed | Chained `--and` confirm error escalations (crash / non-JSON → exit 2) pinned; branch 72%→81% (`86c92e1`). |
| C1-08 | coverage | MEDIUM | `src/act-claude.mjs` | fixed | = Q-004 (`86c92e1`). |
| C1-09 | coverage | LOW | `scorers/contains.mjs` | fixed | Unreadable `--output` → exit 2 (not silent score 0); branch 71%→83% (`86c92e1`). |
| C1-10 | coverage | LOW | `scorers/test-pass-rate.mjs` | fixed | `pass 0 + fail 0` (zero tests) → exit 2, not NaN score (`86c92e1`). |
| C1-11 | coverage | LOW | `scorers/io-effect.mjs` | fixed | = Q-003 (`86c92e1`). |
| C1-12 | simplification | LOW | `src/git-snapshot.mjs` (+3) | wontfix | 4 byte-identical private `git` exec helpers — adversarial verify REJECTED unification: intentional tolerated duplication (clarity > reuse; the converge modules deliberately avoid the import cycle a shared helper would add). |
| C1-13 | correctness | LOW | `src/outer-cli.mjs` (+ other `*-cli.mjs`) | deferred | Surfaced by the cycle-1 review: the non-`driver` CLI entry guards still use the lexical-only `import.meta.url === pathToFileURL(argv[1]).href` (no realpath fallback), so a symlinked launch silently no-ops — the same class the driver fix (`5e9117f`) closed. NOT a live bug: only `driver` is the package `bin`; the others are invoked by absolute path via the `whet` router. Latent consistency gap; revisit if any becomes a bin entry. |

### Cycle 2 (2026-06-30) — deeper audit of the unexplored surface (14 candidates → 12 verified NEW → 9 fixed)

Finders targeted the cycle-1-untouched modules (planner/outer/replan, converge rollback/batch internals, iso-* sandbox, utils), with the cycle-1 findings fed to the verifier as a dedup list (0 re-reported).

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| C2-01 | correctness | MEDIUM | `src/converge-parallel.mjs` | fixed | A lone-survivor batch regression wrote a SINGLETON quarantine entry, which pickBatch matches against every batch → a healthy objective permanently barred from parallel (false termination). Quarantine only combinations (`length >= 2`) (`6424350`). |
| C2-02 | correctness | LOW | `src/outer-cli.mjs` | fixed | `runOuterCli` didn't catch a throwing `proposeReplan`/`planManifest` (routine planner refusal) → unhandled rejection crash. try/catch → `e.exitCode ?? 2` (`42e168c`). |
| C2-03 | correctness | LOW | `src/converge-diagnostics.mjs` | fixed | `plateaued` comment claimed "same notion" as the gate's plateau, but it's a RAW delta vs the gate's running-max (diverge on non-monotonic). Advisory-only → comment corrected (`f51ee4b`). |
| C2-04 | coverage | MEDIUM | `src/converge.mjs` | fixed | Resume with the deterministic floor failing at last-good (blocked-on-resume early-return) untested (`378f076`). |
| C2-05 | coverage | LOW | `src/converge-parallel.mjs` | fixed | Whole-batch no-op tail (no in-scope change) untested (`378f076`). |
| C2-06 | coverage | LOW | `src/converge-parallel.mjs` | fixed | Empty-pickBatch terminal cap (all objectives skipped) untested (`378f076`). |
| C2-07 | coverage | LOW | `scorers/io-assert.mjs` | fixed | `judgeCases` 'no result' (results shorter than cases) untested (`378f076`). |
| C2-08 | coverage | LOW | `scorers/io-invariant.mjs` | fixed | `sorted` allStr (string-array) branch untested (`378f076`). |
| C2-09 | coverage | LOW | `src/iso-execute.mjs` | fixed | `executeEffect` non-JSON return under wantReturns (forge defense) untested (`378f076`). |
| C2-10 | security | LOW | `src/redact.mjs` | wontfix | AWS_SECRET_ACCESS_KEY-style + credential-URL redaction misses — but the module DOCUMENTS best-effort over a self-gitignored run dir (zero exfil path); broadening risks false-positive redactions. Verifier: not worth. |
| C2-11 | coverage | LOW | `src/converge-parallel.mjs` | deferred | Done-edge stability 'unstable' branch untested — but it's a SYMMETRIC gap (sequential analog also untested), reachable only with stability_runs>1 + a non-empty held-out stub. Verifier: not worth (would need both paths). |
| C2-12 | coverage | LOW | `src/iso-runner.mjs` | wontfix | Artifact-resolve early-return single line untested — but the reason→score-zero contract IS tested in iso-runner-contract.test.mjs; verifier judged the addition over-claimed and not worth. |
| C2-13 | coverage | — | `src/scope-context.mjs` | wontfix | confirm() no-snapshot fallback is DEAD in real execution (a persist-with-snapshot always precedes confirm); per the maintainer's "no defensive code/tests for impossible cases" rule, rejected. |
| C2-14 | correctness | LOW | `src/converge-parallel.mjs` | deferred | Surfaced by the cycle-2 self-review: `consecutive_batch_regressions` resets only on an accepted BATCH, never on a successful sequential fallback — so a combo regression, a successful sequential round, then an unrelated combo regression hits the cap "consecutively". Pre-existing asymmetry (NOT introduced by C2-01); separate question from the increment guard. Revisit if premature parallel-disable is observed. |

### Cycle 3 (2026-06-30) — forge non-invariant + iso sandbox + data-inertness audit (11 candidates → 6 verified NEW → 5 fixed)

Finders targeted the cycle-1/2-untouched DEEP surface (the 8 non-invariant forge modules, the iso-runner/iso-frame sandbox + nonce framing, canonical-data inertness, driver/converge core). Full register fed as dedup. The correctness audits of the forge core, the tournament/winner's-curse path, and driver/converge core all came back **NEGATIVE (no bug — verified sound)** — a strong signal the cores are correct.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| C3-01 | security | **HIGH** | `src/forge/hook.mjs` (+`scorer-safety.mjs`, `plan-allowlist.mjs`) | fixed | **Model-authored RCE.** The Forge proposable-scorer denylist was `{test-pass-rate, composite}` — missing `floor` + `llm-judge` (which plan-allowlist correctly denies). With `--scorer-allow scorers/floor.mjs`, a model-authored `floor --cmd <cmd>` runs an arbitrary command via floor's second shell (proven end-to-end). Root-cause fix: canonical `SHELL_SCORERS` defined ONCE in scorer-safety.mjs, both boundaries import it (no more drift) (`6f8a899`). |
| C3-02 | coverage | LOW | `src/forge/mutate.mjs` | fixed | Half the mutation operator directions never executed (fn 60.87%) → an equivalent-mutant regression undetected. All directions pinned (fn→100%) (`16bab59`). |
| C3-03 | coverage/security | LOW | `src/forge/scope-generate.mjs` | fixed | Scope-mode allowlist rejection (trust gate) + absent-file `safeRead` fallback untested (`16bab59`). |
| C3-04 | coverage | LOW | `src/forge/generate.mjs` | fixed | `claudePropose` exit-0 non-JSON stdout parse-error path untested (`16bab59`). |
| C3-05 | coverage | LOW | `src/forge/scope-hook.mjs` | fixed | No-changed-files skip (same-tree good/bad SHAs) untested (`16bab59`). |
| C3-06 | simplification | LOW | `src/plan-call.mjs` | wontfix | `buildPlannerArgs` exported but internal-only — verifier judged it a deliberate pure-testable-seam export (sibling `extractPlannerText` is exported+tested), cosmetic, not worth the churn. |

### Cycle 4 (2026-06-30) — iso sandbox internals + utils + scope edit path (7 candidates → 4 verified NEW → 2 fixed)

Finders swept the last un-deeply-audited surface: the iso-runner/iso-frame sandbox spawn/scrub/env, prompt-fence, redact (off-disk only), the utils (whet/validate/shq/ledger/...), scope-act/scope-context. **The security + correctness audits found NO new bug** (the boundary is sound) — the 2 MEDIUM worth-fixing were coverage gaps on already-correct gate-integrity guards. Strong convergence signal (worth-fixing trend 11 → 9 → 5 → **2**).

**Note — security axis re-run:** the original cycle-4 security finder was terminated by the prompt-injection scanner (a web-search hit `"exfiltrate"`, HIGH), losing its work. Re-run from LOCAL SOURCE ONLY via a no-web `security-auditor` agent → confirmed the boundary SOUND, surfaced one LOW (C4-05), recovered the gap.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| C4-01 | coverage | MEDIUM | `scorers/io-invariant.mjs` | fixed | `canonicalKey` (the multiset engine behind permutation-of-input/unique/input-unchanged) was exercised only via flat numeric arrays — its type-prefix (1 vs "1") + key-sort anti-gaming properties + throws now pinned directly (`0629458`). |
| C4-02 | coverage | MEDIUM | `src/scope-context.mjs` | fixed | `runScopeScorer`'s non-zero-exit (L20) + maxBuffer-overflow (L19) guards — which turn a broken project scorer into a throw, not a silent JSON.parse — untested. Both pinned (`0629458`). |
| C4-03 | simplification | LOW | `src/plan-cli.mjs` (+replan/outer) | wontfix | `gitLsFiles`/`buildRepoContext` byte-duplicated across 3 CLI entries — verifier: low-probability drift, the CLI entries deliberately stay self-contained (cycle-free static graphs); not worth the churn. |
| C4-04 | coverage | LOW | `src/iso-execute.mjs` | wontfix | `executeTrace` null-subject ternary untested — but its OUTPUT verdict path is already covered by the missing-method test; trivial correct ternary, not worth pinning. |
| — | — | — | `src/scope-act.mjs` | rejected | `enforceReadOnly`'s `reverted[]` porcelain mis-parse — the field is DEAD (zero consumers, never logged); enforcement runs on the readOnly pathspecs directly, so no behavioral impact at all. real=false. |
| C4-05 | security | LOW | `src/iso-runner-child.mjs` | fixed | (Recovered from the scanner-killed security re-run.) The sandbox builtin-DENY scheme strip was case-SENSITIVE (`/^node:/`), so `import('NODE:V8')` dodged the deny set. **Empirically NOT exploitable today** — Node's loader rejects a cased scheme (ERR_UNKNOWN_BUILTIN_MODULE) on 26.4 / the ≥23.5 floor / CI 24+26 — but the deny set must not rely on that external assumption. Fixed `/^node:/i` (defense-in-depth, matching the file's own belt-and-suspenders scrub) + an outcome-pin regression test; the `getBuiltinModule` scrub stays the primary guard (`e694edf`). |

### External dogfood (2026-06-30) — running it on an external project (dogfooding)

First use of whetstone on a real external target (a Python project) surfaced a portability
gap invisible from inside (whetstone's own suite is all node:test). Full friction log:
[`dogfood-tracegram.md`](./dogfood-tracegram.md).

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| DF-01 | portability | HIGH | `scorers/test-pass-rate.mjs` | fixed | The "most portable scorer" parsed **only** node:test output (`ℹ pass N`) end-to-end — count regex, `✖ failing tests:` detail marker, `--test-name-pattern`. A pytest run errored at the scorer (`could not parse pass/fail counts`, 0 tokens, editor never spawned). Made multi-runner via TDD (5 RED→GREEN): `parseCounts()` node-first then pytest (`N passed/failed`, collection `N error`=failure); `failureDetail()`/`failingNames()` pytest branches. 999/999 green, coverage ≥ ratchet (branch 83.48→83.52), scorer not invariant. End-to-end: bundled scorer on a real external project's pytest → score 100. Branch `feat/portable-test-scorer`. |

### Full-repo audit (2026-07-02) — post-v1.3.0 surface (spawn-editor concurrency + plateau knobs) + drift re-check

A user-requested full audit (3 parallel finders: architecture map, dead-code sweep, correctness/robustness) + source re-verification + an independent `security-auditor` pass + a bidirectional DCA (cross-model codex leg) on the fix. Headline: the correctness finder's 3 CRITICAL / 3 HIGH mostly EVAPORATED on source inspection (nonce-forge = nonce-secrecy not marker-distinctness; gitHead "race" is inside the try; state JSON.parse already wrapped on the resume path driver.mjs:185; held_out hash re-validated at converge.mjs:447; iso-runner IS e2e-tested via io-*.test.mjs real child spawn) — confirming the cores are sound (matches the cycle 1–4 convergence). One real HIGH survived every check.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| AUD-01 | security | **HIGH** | `src/decompose.mjs`, `src/scope-cli.mjs` | fixed | **Model-authored RCE on the scope-decompose boundary** — the same class as C3-01, on the THIRD boundary the C3-01 fix never reached. `scope-cli.mjs buildAllowlist` used a narrower `SUBGATE_UNSAFE={composite,floor}` than canonical `SHELL_SCORERS`, so a decompose finding naming `test-pass-rate`/`llm-judge` with a model-authored `--cmd`/`--rubric` resolved and ran via `spawnSync(...,{shell:true})`. Reachable because the default loopDir `.loop/run_*` (driver.mjs:253) nests inside `--scope` under `whet --scope .`, and the editor (`--permission-mode acceptEdits`) can overwrite the review file to author the finding. **Root-cause fix (DCA `20260702T110808`, ship C):** (B) `resolveSubGate` typed arg policy — a `test-pass-rate` sub-gate PINS its `--cmd` to the run's code-owned scorer command and carries only the model's `--only` datum; any other shell scorer rejects; data-only scorers unchanged. (A, defense-in-depth) a realpath-aware `loopDirInsideScope` refusal so the run dir cannot nest in the scope. (C) `llm-judge` added to `SUBGATE_UNSAFE`. Independent `security-auditor` CONFIRMED; codex cross-model concurred (B mandatory root-cause, A defense-in-depth). TDD RED→GREEN; 1045/1045; branch 83.48→83.92, fn 93.89→94.19; 8 invariant files byte-untouched. |
| AUD-hygiene | hygiene | LOW | `README.md`, `.gitignore` | fixed | README status badge v1.1.1 → v1.3.0 (package.json/plugin.json drift); `.superpowers/` (ephemeral SDD artifacts, was untracked+non-ignored) gitignored. Committed separately (branch `chore/hygiene-version-superpowers`). |
| AUD-02 | testability | MEDIUM | `src/act-claude.mjs` (+`test/fixtures/fake-claude.mjs`) | fixed | The editor spawn was the ONE genuinely-mocked boundary (every other act test injects a file-writing stub instead of `makeClaudeAct`, so the real spawn→JSON-parse→exit-disposition→file-hash path never ran — the operator's "a gate that mocks the boundary doesn't test the wiring" lesson). Added a $0 fake `claude -p` executable driven as a REAL child across 5 exit shapes (edit+cost/tokens, no-op, error_max_turns non-fatal, fatal throw, timeout kill). No wiring bug found (boundary confirmed sound). |
| AUD-03 | security | MEDIUM | `src/preflight.mjs`, `src/driver.mjs`, `src/scope-cli.mjs` | fixed | **F2 (dogfood ledger) — DELIVERED (safety half).** Cross-repo permission-surface preflight: `crossRepoPermissionWarning` warns (non-fatal) when the target dir is OUTSIDE cwd and its `.claude/settings*.json` carries a non-empty `permissions.allow` or a bypass-by-default mode. Automates the whet.md SAFETY manual check the editor inherits (`--permission-mode acceptEdits` in the artifact dir). Wired into the driver + scope-cli entries; unit + driver-entry subprocess tests. The `--target-repo` routing convenience (pure ergonomics) is the still-deferred remainder of F2. |
| AUD-04 | security | MEDIUM | `src/iso-runner-child.mjs`, `src/iso-runner.mjs` | fixed | **Sandbox network egress unblocked — comment overclaimed the guarantee.** The iso behavioural sandbox denied heap/nonce escape but NOT off-machine egress: `DENY` omitted the socket builtins and `fetch`/`WebSocket` were never scrubbed, so a model-authored artifact could exfil the test spec + its own source (`--permission` does not gate the network, contrary to the `iso-runner.mjs:26` comment). Blast radius MEDIUM: operator secrets already excluded via `ENV_ALLOWLIST`. **Fix (TDD RED→GREEN):** `net,http,https,http2,dns,dgram,tls` added to the module `DENY` set (the chain-wide `registerHooks` resolve hook — proven to gate builtins by the `node:v8` test — now denies sockets; `bare()` maps subpaths e.g. `dns/promises`→`dns`); `fetch`/`WebSocket`/`EventSource` globals deleted in the lockdown block before `await import(artifact)`; the two overclaiming comments corrected. Independent `security-auditor` run — its speculative extras (`navigator.sendBeacon`, `WebTransport`) empirically refuted (undefined on the Node floor) so no dead poison-code added; its `data:`-URL nesting vector confirmed closed + pinned by a regression test. 10 red-team tests; 1067/1067; 8 invariant files byte-untouched; honest io-* scoring reconfirmed. |

Dead-code sweep: **clean** (no unused exports, TODO/FIXME 0, all fixtures/scorers referenced, bench/ properly shelved+isolated). Architecture: the "3× allowlist builder" duplication is NOT unifiable (distinct threat models — plan positive fail-closed, forge operator-path denylist, scope-decompose needs test-pass-rate); the security core (`SHELL_SCORERS`+`isUnsafeScorer`) is already single-sourced. Still deferred: F2 `--target-repo` routing (ergonomics), config-fragmentation (alpha), converge.mjs 731 LOC (core sound, risk>reward).

### Test-infra hardening (2026-07-02) — flaky-test de-flake

Standalone maintenance finding (outside the 4 discovery cycles): a load-sensitive
timing assertion, not a logic bug. The wall-clock-concurrency feature (v1.2.0)
works; only its *proof* was fragile.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| FT-01 | test-flakiness | LOW | `test/converge-parallel-overlap.test.mjs` | fixed | The `--parallel` wall-clock-concurrency proof asserted a load-SENSITIVE duration ratio (`concurrent < serial * 0.7`); it flaked once under `npm run coverage` (coverage instrumentation + heavy parallel load inflate the concurrent arm's ratio past the bound). A duration ratio is the wrong instrument — not a logic bug. Replaced the durational proxy with a CAUSAL interval-overlap check: capture each editor child's `[spawn, exit]` interval via the existing `onSpawn`/`onExit` hooks (monotonic `performance.now`), assert the two CONCURRENT children's intervals overlap (`sa < eb && sb < ea`), + a SERIAL negative control that must NOT overlap (gives the check teeth — a serializing spawnSync fails it). Load-INDEPENDENT: overlap is ordering, not speed. Verified: isolation + full `npm run coverage` incl. one under core saturation, all green; coverage ≥ floor; 8 invariant files byte-identical. Adversarial 3-lens review (no-weakening / teeth / residual-flakiness) all PASS. Not an invariant file. Spun off as its own session (task `task_c9b5a4ee`, branch `claude/unruffled-lederberg-623e2c`); landed into the audit merge. |

### Cycle 5 (2026-07-02) — adversarial re-probe of AUD-04 + AUD-01 + 4-axis discovery (2 candidates → 0 confirmed)

A 6-agent Workflow (4 parallel axis finders + refute-by-default verifiers, **no-web**, empirical) re-probed the
two freshest security fixes and swept for new issues. **All four axes returned NEGATIVE — boundaries sound**,
independently reproduced by a separate main-loop probe harness that ran hostile artifacts through the real
`runIsolated` (verify against source, not model consensus). The two surfaced candidates were both REFUTED by the
adversarial verifiers. **Zero code changes** this cycle — strong convergence (cores/boundaries sound) continues
across cycles 1–4 + the audit + now cycle 5.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|----|------|-----|---------|--------|-------------------|
| AUD-04-reprobe | security | — | `src/iso-runner.mjs`, `src/iso-runner-child.mjs`, `src/iso-frame.mjs`, `src/iso-execute.mjs` | verified-sound | 12 egress + nonce-recovery hypotheses empirically refuted through the real `runIsolated`: all socket builtins (+`dns/promises` subpaths) DENY at the resolve hook; `data:`-URL nested `node:net` still denied; network-import URLs refused by Node's loader (the `bare('https://…')`=`'https:'` trailing-colon DENY-miss is a **DEAD path** — schemes unsupported + `--experimental-network-imports` removed on Node ≥22); `fetch`/`WebSocket`/`EventSource`/`WebTransport` deleted; `process.{getBuiltinModule,binding,_linkedBinding,dlopen}` deleted; `node:wasi` imports but `new WASI()` is `--permission`-blocked (no `--allow-wasi`, preview1 has no sockets); nonce unrecoverable (fd0→EOF, argv scrubbed, env allowlisted, iso-frame namespace exports immutable, primitive-poisoning never intercepts the template-literal frame on a string primitive); `process.report` carries no nonce / no tcp-udp handle. **AUD-04 FIXED disposition holds.** |
| AUD-01-reprobe | security | — | `src/decompose.mjs`, `src/scope-cli.mjs`, `src/scorer-safety.mjs`, `scorers/*` | verified-sound | 6 shell-reach hypotheses refuted: `SHELL_SCORERS` is EXACTLY the shell-executing set (grep of all 10 scorers → `composite`/`floor`/`llm-judge`/`test-pass-rate` are the only `shell:true`/claude spawns; the 6 data-only scorers never shell — io-* spawn a **fixed arg-array** locked child, not a shell); `shq` neutralizes `$()`/backtick/quote/newline/`;`/`&&`/`\|` proven in a real shell across the two-hop `resolveSubGate`→`test-pass-rate` path (double-shq); `allowlist.get(id)` is exact-match (no normalization dodge admits a shell scorer); `loopDirInsideScope` realpath-aware; `base+sep` containment segment-correct; `trustedScorerCmd` = operator's `--scorer` (no model influence). **AUD-01 FIXED disposition holds.** |
| QL-01 | coverage/process | LOW | `docs/quality-loop/{findings-register,RUNBOOK}.md` | fixed | **Branch-coverage floor mis-calibration.** The recorded branch floor 84.12 is the *peak* of a ~[84.03, 84.12] jitter band (line 96.42 / function 94.22 stable); HEAD (byte-unchanged) reproduces 84.03–84.12 across runs. Root cause: three spawn-based tests flip a branch on an *already-covered line* by subprocess-scheduling timing — `converge.mjs`, `act-claude.mjs`, invariant `loop.mjs`. The adversarial verifier correctly REFUTED the finding's "gate spuriously trips" framing (the ratchet is SOFT/manual per RUNBOOK gate 4 — no code reads it), but the underlying mis-calibration is real and recurs at each cycle's manual coverage check. Fix (operator-approved): recalibrate the branch floor to the reproducible **minimum** 84.03, document the jitter + its invariant-file source, keep line/function as exact ratchets. Docs-only; no code/test/invariant change. |
| SIMP-1 | simplification | — | `src/act-claude.mjs` (+`plan-call.mjs`, `forge/generate.mjs`, `scorers/llm-judge.mjs`) | wontfix | 5-site `claude -p` result-element extractor duplication (`JSON.parse` + `find(type:'result')`) — REFUTED as a fix by adversarial verify: same tolerated-dup disposition as C1-12 / C4-03 (only a 1-line shared ternary; downstream field extraction + parse-fail behavior diverge per site; a shared helper adds cross-module coupling for little clarity gain). Its one novel argument — a `find` vs `findLast` "inconsistency" — is defensive-code-for-impossible-state (a real `--output-format json` stream has exactly one terminal `result` element, so both resolve identically; the `findLast` is deliberately documented forward-proofing), which the maintainer's rules reject. |

### Feature audit (2026-07-03) — field-informed architecture-adaptation ADOPT items (v1.9.0)

A 15-agent audit vs field prior art (evaluator-optimizer / DSPy / Agent Capsules / hacker-fixer loops) surfaced 6 source-verified ADOPT items; the gaps were all feedback-fidelity (the loop misleading itself), not control machinery. Phase A landed the live bug + 3 small/high items. Roadmap: project memory `architecture-adaptation-roadmap.md`.

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|---|---|---|---|---|---|
| AUD-05 | correctness | HIGH | `src/loop.mjs`, `src/state.mjs`, `src/ledger.mjs` | fixed | **Stale critique after keep-best restore.** `loop.mjs` persisted the regressed pass's critique, then silently restored the best snapshot — every post-restore editor pass was steered by a critique of the reverted (dead) artifact version. Fix: `recordPass` tracks `best_critique`; on restore, `loop.mjs` re-points `last_critique` + stamps `restored_at_pass` + `save()`s (confirm-veto idiom), BEFORE `verifyDone` so a later veto legitimately overwrites; `ledger.mjs` adds a finite-guarded REVERTED note. `loop.mjs` is invariant-pinned — DCA `20260703T203705` (REFINED-AND-PROCEED, Option A; Codex gpt-5.5 flagged + we pinned the null-normalization guard). TDD RED→GREEN. |
| AUD-06 | security | MEDIUM | `src/blast-radius.mjs`, `src/driver.mjs`, `src/summary.mjs` | fixed | **Single-file edit boundary was prompt-only.** "Edit ONLY the artifact" was advisory (scope mode's git enforcement is not portable — the artifact dir need not be a repo); a sibling edit can launder the io-* signal. New code-owned snapshot/diff/revert wrapper at the driver act seam; default ON, `--allow-sibling-edits` opts out; violations stamped on `state.blast_radius` + summary warning. Bounded (copyCap/walkCap) with a loud `capped` signal. |
| AUD-07 | hardening | MEDIUM | `src/forge/exploit-regression.mjs`, `src/forge/hook.mjs` | fixed | **Exploit-regression archive was frozen at 3 static seeds.** Real observed gaming (confirm-vetoed snapshots) was discarded. Live `exploits.json` beside the store file: append on recovered-veto (sha256 dedup, FIFO 20), consumed at admission via the existing materialize seam. `store.mjs` (invariant) untouched. No redaction (sources must round-trip runnable); executes only through `runCheck`, the channel admitCheck already uses. |
| AUD-08 | verification | LOW | `src/gate-audit.mjs`, `src/driver.mjs`, `src/summary.mjs` | fixed | **Primary-gate strength never measured** — a weak scorer converges confidently. Opt-in `--gate-audit`: post-done, mutate the final artifact, re-score ≤6 sampled mutants with the PRIMARY scorer, report the kill-rate (survived = the scorer let a broken mutant clear target). Advisory only (never changes the verdict); opt-in because the scorer may be paid; fail-safe; skipped under `--observe`. |

### Phase B (2026-07-03) — deferred architecture-adaptation items (planned by Fable, run by Opus)

| ID | Axis | Sev | File(s) | Status | Note / provenance |
|---|---|---|---|---|---|
| AUD-09 | correctness | LOW | `src/converge.mjs`, `src/state.mjs`, `src/scope-act.mjs` | fixed | **Converge retries started blind** — a failed objective retried in a fresh child could repeat the exact dead approach the last attempt already failed (`state.rounds` recorded the failures but nothing fed them forward). Fix (v1.10.0): `composeRetryMemo(rounds, objId)` summarizes THIS objective's prior failed rounds (code-authored `reason`s + finite floor scores only); `buildObjectiveCfg` carries it as `retryMemo` → `initState` `retry_memo` → `buildScopePrompt` renders it as a nonce-**fenced** `PRIOR-ATTEMPTS` DATA block (own nonce). No invariant file touched; no model spawn; the child is in-process `runFromConfig` so the memo flows straight through. TDD RED→GREEN. |
| AUD-10 | verification | LOW | `src/forge/gate-probe.mjs`, `src/forge/hook.mjs`, `src/driver.mjs`, `src/summary.mjs` | fixed | **A `done` was only as trustworthy as its confirm gate — never adversarially tested.** Opt-in `--gate-self-probe` (v1.11.0, full hacker-fixer): post-done, `runGateSelfProbe` mutates the accepted artifact and probes the COMPOSED confirm gate; a mutant the gate reproducibly PASSES is a survivor (a hole), routed via a new `runForgeHook` `'gate-survivor'` trigger (good=final so admission can't veto the final; the branch never indexes history, requires both deps, fails loud) into Forge learning. PAID → bounded per DCA `20260703T222155`: sample ≤4 mutants, ≤1 survivor default, SEQUENTIAL with early-stop (bounds both paid gate runs and paid generations); only outcome-`'pass'` routes; fires only with a composed gate + `--forge --forge-store`, else skip-LOUD; fail-safe (never changes the verdict). Store-poisoning risk is inherited from forge learning generally (existing admit/mutation-admit/corroborate/prune mitigations apply). No invariant file touched. TDD RED→GREEN ($0; the self-heal itself needs a paid smoke). |

---

## How findings enter

Cycle DISCOVER + TRIAGE appends new rows here (next id continues the sequence).
Each fix flips a row to `fixed` and lands a commit referencing the id.
