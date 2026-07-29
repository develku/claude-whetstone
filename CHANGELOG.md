# Changelog

All notable changes to **claude-whetstone** are recorded here so the
[README](README.md) can stay a description of *what the tool does and why*,
not a running log. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dates are the landing commit's date; the short SHA points at the squash on `main`.

## [1.14.1] — 2026-07-29
### Fixed
- **`doc-lint` misread the docs it grades** — two regex defects in
  `scorers/doc-lint.mjs`, one of which corrupted a *sibling* scorer through the
  shared parse. (1) `FENCE` was unanchored, so a triple-backtick written **inline
  in prose** (e.g. the phrase "runs every fenced ```` ```js ```` example") opened a
  phantom fence; every later delimiter then paired wrongly, turning 153 lines of
  ordinary prose into "authoritative" ref territory while skipping the real fence
  that followed. (2) `PATH_TOKEN` began matching at `[A-Za-z0-9_]`, so it could
  never capture a leading `~` or `/`: `~/.config/whetstone/config.json` was clipped
  to a repo-relative-*looking* `config/whetstone/config.json`, so the home/absolute
  guard in `isCheckableRef` never received the character it filters on and a correct
  doc claim scored as a dangling ref. The same gap ate the leading dot on
  `.github/…` refs. Both delimiters are now line-anchored (`^` + `m`), and the
  `~/`-or-`/` prefix and leading `.` are captured rather than skipped.

  Measured on the recorded artifact `.loop/doc-depth/snapshots/iter_004.md` — file
  unchanged, scorer fixed: `doc-coverage` 92.73 → **96.36** (`--forge-retire` and
  `effort` were documented all along; the phantom fence hid them), `doc-lint`
  89.47 → **100** (36/36 claims valid), composite 89.47 → **96.36**. Refs actually
  verified went 18 → **35**: nearly half the doc's claims were never checked while
  the gate reported a confident number. The bad critique also told the model to
  "fix the path or remove the reference", whose only satisfiable action was
  deleting true documentation — a scorer bug that inverted the loop's objective.

  Root cause independently derived and the first diagnosis adversarially
  refuted-as-stated by a cross-model reviewer, which identified the unanchored
  `FENCE` as the activating defect and corrected four points: the 2026-07-04 run's
  terminal cause was the token budget, `doc-lint` was 96.77 at pass 0 (no ceiling
  from the start), target 98 was reachable, and `escalated:false` was correct with
  no plateau present.

  Known narrowing: an **indented** fence (inside a list item or blockquote) no
  longer opens a block. Nothing in-repo relies on it — suite green, SPEC and README
  both gate at 100.

## [1.14.0] — 2026-07-29
### Added
- **Nested-config preflight** — `nestedClaudeConfigWarning` (`src/preflight.mjs`),
  wired into both the single-file driver and the `scope` CLI, warns before a run
  when the target sits inside a live `.claude` config tree. The editor's cwd is
  the artifact's directory and Claude Code merges every `.claude` config found
  walking up, so such a run inherits that tree's whole hook stack, spends its turn
  on ceremony, edits nothing and ERRORs — measured at ~USD 2.08 / 1.04M tokens for
  zero edits. A pure path check (no filesystem access, so no false positives) and
  deliberately independent of the cross-repo permission check beside it: that burn
  happened with the target *inside* cwd and with permissions that were never broad,
  so neither of that check's conditions applied. Non-fatal, like its twin.
### Changed
- The launcher and SPEC now carry two judgments that previously lived only in the
  maintainer's local notes, so the plugin stands on its own: **when the loop is the
  wrong tool** (a judge anchors below 100 so `done` never fires, and plateau keys
  off a running max that judge noise keeps bumping, so a judged run stops on budget
  by construction — measured ~USD 12.34 over 13 passes versus ~USD 0.32–0.54 for
  deterministic runs converging in one), and **why a score is not a result** (what
  qualifies as an oracle the gate's author did not write, and why
  `--stability-runs`, `--gate-audit` and `--gate-self-probe` do not qualify).
  New `SPEC.md` §8; `commands/whet.md` gains the matching run-time guidance and a
  SAFETY entry for the nested-config hazard.

## [1.13.0] — 2026-07-07
### Added
- **Auth-failure preflight** — the act step classifies an auth-class `claude -p`
  failure (expired OAuth / invalid key / 401 / Keychain
  `errSecInteractionNotAllowed`) distinctly from a transient rate-limit and fails
  FAST + LOUD with a one-line self-heal remedy (`claude /login` | `claude
  setup-token` + `CLAUDE_CODE_OAUTH_TOKEN`, and the `ANTHROPIC_API_KEY`-overrides-
  subscription footgun) instead of burning 3 identical retries then throwing a
  cryptic "editor claude exited 1". A definitive non-401 structured status wins
  over incidental auth-phrase text, so a rate-limit still retries. (`5d56e62`)
### Changed
- The whole-repo **scope** loop, the **Forge** verifier-learner, and the
  **converge** control plane are promoted from "experimental/alpha, deliberately
  unsupported" to **beta — in active dogfooding**: supported and run for real,
  findings tracked in `docs/quality-loop/findings-register.md`. Still honestly
  NOT stable — `done` is provisional and the known holes (leaf-set *sufficiency*,
  indirect scorer-capture) stay disclosed. (`1af8ef2`)

## [1.12.0] — 2026-07-04
### Added
- **DOC-DEPTH-FLOOR** — a composed doc gate that closes `doc-lint`'s omission
  blind spot. `doc-coverage` (recall) walks a committed required-token set and
  scores the percentage *substantively* documented; `doc-exec` runs every fenced
  `js` example in the locked-down `iso-runner` child; both compose with `doc-lint`
  (precision) under `composite`, so a doc can't ship complete-looking-but-wrong,
  thin-but-accurate, or accurate-but-broken. (`8dfd2db`)

## [1.11.0] — 2026-07-03
### Added
- Opt-in `--gate-self-probe`: after a `done`, mutate the accepted artifact and
  run the composed confirm gate against each mutant; a mutant the gate *passes*
  is a hole, and the Forge learns a check that catches it (self-healing gate).
  Bounded (≤4 mutants, ≤1 survivor) and paid, so opt-in. (`8a64086`)

## [1.10.0] — 2026-07-03
### Added
- A converge objective that fails and is **retried** now receives a fenced,
  code-composed memo of what prior attempts tried and why they failed, so it
  changes strategy instead of repeating a dead approach. (`761392b`)

## [1.9.0] — 2026-07-03
### Changed
- Feedback-fidelity hardening: a keep-best rollback now re-points the editor's
  steering critique at the version actually on disk; the single-file loop
  **code-enforces** "edit ONLY the artifact" (sibling edits reverted,
  `--allow-sibling-edits` opts out); the Forge's exploit-regression archive grows
  from real confirm-vetoed snapshots; and opt-in `--gate-audit` re-scores mutants
  to report the primary scorer's kill-rate. (`de021dd`)

## [1.8.0] — 2026-07-03
### Added
- Easy-done Forge trigger (a 1-edit `done` with no wired confirm gate learns from
  the baseline→final pair) and fence-safe discard-memory (`TRIED-AREAS`). (`b810291`)

## [1.7.0] — 2026-07-03
### Added
- Editor transient-retry (rate-limit / API-overload passes retried with backoff)
  and a thin-scorer-suspicion warning on a suspiciously easy `done`. (`10d238c`)

## [1.6.0] — 2026-07-02
### Added
- Plateau escalation **ladder** (`sonnet → opus → fable`, one rung per proven
  stall) and judge-spend accounting in `spent_tokens` / `spent_usd`. (`ab163f6`)

## [1.5.1] — 2026-07-02
### Fixed
- The `llm-judge` scorer now retries a transient `claude` failure before
  reporting a scorer error, so one API blip can't kill a paid run. (`f11d06c`)

## [1.5.0] — 2026-07-02
### Added
- Fable 5 plateau-escalation offered at run start (opt-in top rung). (`b6a6dd1`)

## [1.4.1] — 2026-07-02
### Fixed
- Confirmation-spend handling and config-delta surfacing; documented the
  cross-repo permission preflight. (`7621612`)

## [1.4.0] — 2026-07-02
### Security
- Closed a model-authored RCE on the scope `--decompose` sub-gate boundary (the
  sub-gate now reuses the run's code-owned scorer, never one the editor authors);
  added the cross-repo permission preflight and de-flaked parallel overlap. (`5b0321a`)

## [1.3.0] — 2026-07-01
### Added
- Exposed `plateauWindow` and `minDelta` as config keys and CLI knobs. (`92b5c05`)

## [1.2.0] — 2026-07-01
### Added
- True wall-clock concurrency for `--parallel` fan-out (async spawn replaces the
  blocking editor). (`298790e`)

## [1.1.2] — 2026-07-01
### Changed
- `/whet` launcher UI: a readable run-plan summary card and a post-run trajectory
  chart. (`35d2327`)

## [1.1.1] — 2026-07-01
### Fixed
- Fail-loud scorer-output parsing (names cmd + exit + snippet instead of crashing
  on empty stdout) and symlink-robust main-module detection across all CLIs. (`6aa4e52`)

## [1.1.0] — 2026-06-29
### Security
- Security-hardening release: the behavioural `io-*` scorers isolate untrusted
  candidate code out-of-process, requiring **Node ≥ 23.5** for the Permission
  Model + module hooks. (`8360049`)

## [1.0.0] — 2026-06-29
### Added
- Initial release: the deterministic single-file loop-engineering driver under a
  code-owned gate, with an honest stable / experimental / alpha tiering. (`f30ee4c`)

[1.12.0]: https://github.com/develku/claude-whetstone/commit/8dfd2db
[1.11.0]: https://github.com/develku/claude-whetstone/commit/8a64086
[1.10.0]: https://github.com/develku/claude-whetstone/commit/761392b
[1.9.0]: https://github.com/develku/claude-whetstone/commit/de021dd
[1.8.0]: https://github.com/develku/claude-whetstone/commit/b810291
[1.7.0]: https://github.com/develku/claude-whetstone/commit/10d238c
[1.6.0]: https://github.com/develku/claude-whetstone/commit/ab163f6
[1.5.1]: https://github.com/develku/claude-whetstone/commit/f11d06c
[1.5.0]: https://github.com/develku/claude-whetstone/commit/b6a6dd1
[1.4.1]: https://github.com/develku/claude-whetstone/commit/7621612
[1.4.0]: https://github.com/develku/claude-whetstone/commit/5b0321a
[1.3.0]: https://github.com/develku/claude-whetstone/commit/92b5c05
[1.2.0]: https://github.com/develku/claude-whetstone/commit/298790e
[1.1.2]: https://github.com/develku/claude-whetstone/commit/35d2327
[1.1.1]: https://github.com/develku/claude-whetstone/commit/6aa4e52
[1.1.0]: https://github.com/develku/claude-whetstone/commit/8360049
[1.0.0]: https://github.com/develku/claude-whetstone/commit/f30ee4c
