# Whetstone hardening review — findings register (2026-06-29)

Source: a whole-repo final-hardening review (8 lenses + adversarial per-finding verification,
workflow `wz937t0zu`), an architecture/critique re-run (`wzkne1d98`), and two adversarial rounds
on the new `doc-lint` scorer (`wf_2314a5e3`, `wf_cf63fa17`). Every finding below was reproduced
empirically (a real run / test / cited code), not asserted.

Branch `feat/doc-lint-scorer` · PR #2 · contained fixes shipped in `2b55bc1` (doc-lint) and
`fe5e84e` (hardening). **924 tests green.**

## FIXED + shipped (this session)

| # | Sev | Finding | Fix (commit) | Verified |
|---|---|---|---|---|
| 1 | CRITICAL | `src/safe-rel.mjs` `resolveOutput` was realpath-blind — an in-scope symlink escaping `--output` passed the lexical guard, and every `--rel` scorer follows it (`readFileSync`/`await import`) → out-of-repo read + import-RCE | realpath-contain both ends (`fe5e84e`) | E2E: read-leak & io-assert RCE both `exit 2`, marker never written; legit module still 100 |
| 5 | MED | (= #1 root, blue-team duplicate) | `fe5e84e` | as #1 |
| 6 | MED | `scorers/doc-lint.mjs` `PATH_TOKEN`/`MD_LINK` O(n²) ReDoS on a long slash-run line | bounded quantifiers (`fe5e84e`) | 100KB 12.8s→151ms; token-identity preserved (README still 100) |
| 7 | MED | `src/gate.mjs` strict-`<` plateau boundary unpinned (a `<=` mutation survived the suite) | boundary test (`fe5e84e`) | mutation `<`→`<=` now fails the new test |
| LOW | LOW | `src/scorer-safety.mjs` `scorerStem` dropped a leading dotfile prefix to `''`, letting `.composite.mjs` dodge the denylist | strip leading dots (`fe5e84e`) | RED→GREEN |
| — | HIGH×2 | doc-lint adversarial rounds: symlink existence-oracle + percent-encoding false-positive (+ a literal-`%XX` regression from the first fix) | `refResolves` realpath + both-spellings decode (`2b55bc1`) | both exploits E2E-closed; README 100 |

## DEFERRED — #2 (the deep one), design decided, see memory `whetstone-io-scorer-import-capture-open.md`

| # | Sev | Finding | Status |
|---|---|---|---|
| 2 | **CRITICAL** | `io-assert`/`io-trace`/`io-effect`/`io-invariant` `await import` the artifact **in the scorer process** → top-level code monkeypatches the oracle (`assert.deepEqual`/`stdout.write`) → forges `score 100`, defeating primary·confirm·held-out·Forge-admit. `--frozen-intrinsics` insufficient. | **DESIGN DECIDED = Approach B (child_process + Node Permission Model)** via empirical prototype+red-team (`wf_2eea467b`). Open risk: `--permission` ESM-loader allow-list tuning. Next focused session. |
| 4 | HIGH | composite-MIN / confirm-veto / held-out can't detect a captured sub-scorer (a gamed io-* returns a genuine 100) | resolved-by-#2 |
| 11 | MED | scorer-safety / Forge trust-boundary classes io-* as "DATA-only safe" — wrong; the danger is *importing artifact code*, not shell-arg exec | resolved-by-#2 (+ comment fixes) |

## DEFERRED — other (surfaced for decision)

| # | Sev | Finding | Suggested fix |
|---|---|---|---|
| 3 | HIGH | `src/act-claude.mjs` editor prompt (stable tier) uses a **forgeable static critique fence** (`----- END CRITIQUE -----`) instead of the shipped `src/prompt-fence.mjs` nonce fence — prompt-injection breakout; the sibling backends (scope-act/llm-judge) already use the nonce fence | port `fenceUntrusted`; add a forgery-resistance test (breaks the 3 `/BEGIN CRITIQUE/` marker-presence assertions) |
| 8 | MED | `src/gate.mjs` (the literal "code owns the gate" file) is absent from the byte-identity invariant tripwire (`test/converge-invariant.test.mjs`), while its thin wrapper `loop.mjs` IS pinned | add `'src/gate.mjs'` (sha `b0cb2139…`) to the INVARIANT map — a DCA-gated policy decision (the "7 invariant files" set) |
| 9 | MED | `--parallel` runs editors **serially** (the editor is blocking `spawnSync`, which blocks the event loop), so `Promise.allSettled` gives zero wall-clock concurrency; the speedup bench's "ran CONCURRENTLY" claim is **false** | make the editor async (`child_process.spawn`) OR drop/correct the throughput claim; the batch-MERGE value (one gate re-measure for N objectives) is real and stays |
| 10 | MED | `CHILD_TIMEOUT_MS` `raceChild` `setTimeout` can't fire while a sibling `spawnSync` blocks the loop; `killChild` is never wired into the CLI (a timed-out child is dropped but its subprocess keeps spending) | tie the timeout to an async editor spawn + `AbortController`; wire a real `killChild`; until then correct the comments |

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
