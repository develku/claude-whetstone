# Example — converge with a global held-out truth gate (alpha)

`converge-with-truth-gate.json` is a worked `whetstone-converge` manifest that demonstrates the
**global held-out truth gate** — the alpha safety feature that backstops *decomposition capture*
(every objective met, yet the real goal unmet).

## The shape

- **`objectives`** — the *mutable* decomposition (the "HOW"): per-module unit work the editor optimizes.
  Here, two disjoint regions: `src/export` (a deterministic unit-test objective) and `src/import` (a
  judge-class objective, so it carries a `confirmScorer` = its own held-out confirm).
- **`global_held_out`** — the *immutable* truth (the "WHAT"): an operator-authored, top-level acceptance
  check that is **separate** from the per-objective confirms. Here it is the end-to-end suite.

## Why it matters

A run can drive both per-objective scorers to target (each module's unit tests pass) while the
**end-to-end truth still fails** — the decomposition was insufficient for the goal. With the truth gate,
`converge` does **not** report `done` in that case: it ends `capped` ("decomposition insufficient") and the
structural-feedback detector emits `held_out_fail`, which `whetstone-outer` can turn into a re-decomposition
**proposal for human review** (never auto-applied).

The truth is **run-immutable**: its scorers, targets, and membership are hash-pinned at run start, must lie
**outside every `editScope`** (the editor cannot rewrite what judges it), and a replan may revise the
decomposition but never weaken or drop a truth check.

## Run it

```bash
# the manifest must live OUTSIDE the edited --scope (it is the operator-owned meta-gate)
node src/converge-cli.mjs --scope /path/to/repo --objectives examples/converge-with-truth-gate.json

# or run the outer loop: on a decomposition-fault stall it writes a replan proposal for you to review
node src/outer-cli.mjs --scope /path/to/repo --objectives examples/converge-with-truth-gate.json \
  --propose-out /tmp/replan-proposal.json
```

> Adjust the scorer `--cmd`s, `editScope`s, and `rubrics/` paths to your repo. This file is a *shape*
> reference, not a turnkey run — the scorers reference commands/paths your project must provide.
> Alpha surface: see the README "[The dynamic control plane (alpha)](../README.md#whats-stable-in-v1)".
