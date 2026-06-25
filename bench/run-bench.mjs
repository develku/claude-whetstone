// bench/run-bench.mjs
// The benchmark orchestrator. `sweep` is the pure-ish core: it walks fixture x arm x trial, charges
// each run against a hard total budget (aborting the tail rather than overspending — and counting what
// it dropped, never a silent truncation), and folds the outcomes through aggregate(). The real per-run
// I/O (`runArm`) and the CLI are added in later tasks; `sweep` takes runArm injected so it is unit-
// testable with a fake.
import { aggregate } from './aggregate.mjs'

export const ARMS = ['fence-on', 'fence-off']

export async function sweep(fixtures, { trials = 3, runArm, totalBudget = Infinity, log = () => {} } = {}) {
  const records = []
  let spent = 0
  let dropped = 0
  for (const fx of fixtures) {
    for (const arm of ARMS) {
      for (let t = 0; t < trials; t++) {
        if (spent >= totalBudget) { dropped++; continue }
        const { bucket, spentUsd = 0 } = await runArm(fx, arm, { trial: t })
        spent += spentUsd
        records.push({ fixture: fx.id, arm, trial: t, bucket })
      }
    }
  }
  if (dropped > 0) log(`budget ${totalBudget} reached after $${spent.toFixed(2)} — dropped ${dropped} planned run(s)`)
  return { records, aggregate: aggregate(records), spent, dropped }
}
