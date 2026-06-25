# Exploit Taxonomy

A durable, self-validating catalogue of the ways a scorer/verifier can be **gamed**, and whetstone's
defense against each. The first brick of the **"code owns the verifier LIFECYCLE, not just the stop"**
direction: the read-only fence makes the model unable to edit the gate it is graded by — but that only
relocates trust from the model to the scorer. *A fenced weak verifier is still weak.* The product that
makes the verifier **strong** is the lifecycle around it — and this taxonomy is its foundation: the map
of what a verifier must withstand.

## What this is

- [`manifest.mjs`](./manifest.mjs) — the data. `export const TAXONOMY` is a frozen array of 8 exploit
  classes, each bound to the **defense** (code) and the **proof** (an existing test). A future Verifier
  Forge / gate-quarantine `import { TAXONOMY }` and walks it as the archive of exploits a self-authored
  gate must survive.
- [`../../test/taxonomy.test.mjs`](../../test/taxonomy.test.mjs) — the **self-validating lock**. It
  fails CI if any defense file or its proving test disappears (it checks the proof test still contains a
  named substring), enforces the "exactly one known gap" invariant, and pins that gap with a live
  gap-demo. Deleting a defense silently no longer passes review.

## The 8 classes

| # | id | defense | proof | status |
|---|---|---|---|---|
| 1 | `test-weakening` | read-only fence hard-reverts test edits before scoring (`src/scope-act.mjs`) | `test/bench-runarm.test.mjs` | 🟢 |
| 2 | `hardcode-to-visible` | held-out confirm scorer re-scores from a pristine checkout (`src/scope-context.mjs`) | `test/driver.test.mjs`, `test/loop.test.mjs` | 🟢 |
| 3 | `scorer-crash` | scorer errors (exit 2) on a masked crash — exit≠0 with zero failures (`scorers/test-pass-rate.mjs`) | `test/scorer.test.mjs` | 🟢 |
| 4 | `scorer-timeout` | wall-clock timeout + SIGKILL on every scorer subprocess (`src/scope-context.mjs`) | `test/composite.test.mjs` | 🟢 |
| 5 | `flaky-score` | **none** — `gateVerdict` reads only the latest score | gap-demo in `test/taxonomy.test.mjs` | 🔴 |
| 6 | `critique-injection` | critique fenced as "data, not instructions" in the editor prompt (`src/scope-act.mjs`) | `test/editor-prompt.test.mjs` | 🟢 |
| 7 | `composite-min-gaming` | composite combines sub-scores by `Math.min` — weakest gates done (`scorers/composite.mjs`) | `test/composite.test.mjs` | 🟢 |
| 8 | `dirty-tree-clobber` | `cleanTreeGuard` refuses a dirty/non-git scope before the loop (`src/scope-cli.mjs`) | `test/scope-cli.test.mjs` | 🟢 |

7 of 8 classes already had a passing defense test when this taxonomy was written; the suite **binds**
those proofs rather than rewriting them. The one 🔴 is a genuine, currently-undefended gap.

## The one gap — `flaky-score`

`gateVerdict` (`src/gate.mjs`) stops at the first pass whose **latest** score reaches target; it has no
repeated-run, variance, or lower-confidence-bound check. A scorer whose score oscillates — flaky tests,
randomness, ordering — can reach `done` on a transient spike without a genuine fix. The gap-demo in
`test/taxonomy.test.mjs` pins this: `history [40, 40, 100] → done`.

The fix is the next character — a **Confidence Gate**: repeat/quorum the scorer and gate on a
lower-confidence bound instead of a single reading. Closing the gap must flip the gap-demo and update
the manifest entry to 🟢 with its proof.

## Roadmap this enables

- **Confidence Gate** — close the `flaky-score` 🔴 (the gap-demo is its motivating test).
- **Realistic e2e demos** (additive, backward-compatible) — wire `--confirm-scorer` against the
  `hardcode-to-fixture` fixture for a full hardcode→held-out demonstration; make the loop-level
  `CHILD_TIMEOUT_MS` env-tunable for a fast loop-level timeout test.
- **Verifier Forge / gate-quarantine** — consume `TAXONOMY` so a model-proposed gate is admitted only
  after surviving every catalogued exploit (code owns the *meta*-stop).

## Run

```bash
node --test test/taxonomy.test.mjs
node -e "import('./bench/taxonomy/manifest.mjs').then(m => console.log(m.TAXONOMY.length, m.TAXONOMY.filter(e=>e.status==='RED').map(e=>e.id)))"
# -> 8 [ 'flaky-score' ]
```
