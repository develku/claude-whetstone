# Changelog

All notable changes to **claude-whetstone** are recorded here so the
[README](README.md) can stay a description of *what the tool does and why*,
not a running log. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dates are the landing commit's date; the short SHA points at the squash on `main`.

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
