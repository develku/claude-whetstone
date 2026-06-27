// src/forge/prune.mjs
// Auto-flaky retirement — the verifier-lifecycle's automated DEATH step (admit · store · consume · retire,
// now self-healing). A stored check that gives a NON-REPRODUCIBLE verdict on the SAME artifact is noise: a
// gate must be deterministic, so a flaky check would randomly veto honest runs forever. This finds such flaky
// ACTIVE checks (replayed against a known-good artifact) and tombstones them.
//
// SAFE boundary (the brick-4b rationale): it retires ONLY the unstable. A check that STABLY FAILS the good
// artifact is NOT pruned — that is ambiguous (it may be catching gaming the base gate missed), so it stays an
// operator decision (--forge-retire). "Disagrees with the base gate" is the check's JOB, never a retire trigger.
import { loadStore as defaultLoadStore, saveStore as defaultSaveStore, retireCheck as defaultRetireCheck } from './store.mjs'

// Replay a check `runs` times against one artifact; unstable iff the verdicts disagree. (Mirrors admit.mjs.)
async function replay(runCheck, cmd, artifact, runs) {
  const verdicts = []
  for (let i = 0; i < Math.max(1, runs); i++) {
    const { pass } = await runCheck(cmd, artifact)
    verdicts.push(!!pass)
  }
  return { unstable: verdicts.some((v) => v !== verdicts[0]) }
}

// Active (non-retired) checks of `kind` whose verdict is unstable on goodArtifact → the records to tombstone.
// Pure given the injected runCheck. Only the FLAKY are returned (a stable pass OR a stable fail is kept).
export async function flakyActiveChecks(store, { goodArtifact, runCheck, replayRuns = 2, kind = 'file' }) {
  const retired = new Set((store.retired ?? []).map((r) => r.key))
  const flaky = []
  for (const c of store.checks) {
    if (retired.has(c.key) || (c.kind ?? 'file') !== kind) continue
    const { unstable } = await replay(runCheck, c.cmd, goodArtifact, replayRuns)
    if (unstable) flaky.push({ key: c.key, cmd: c.cmd, reason: 'auto-retired: non-reproducible (flaky) verdict on a known-good artifact' })
  }
  return flaky
}

// I/O wiring: load the store, tombstone any flaky active check of `kind`, save iff something was retired.
// Returns the retired cmds (for logging). store ops injected (default to the real ones) for testing.
export async function pruneFlaky({
  storePath, goodArtifact, kind = 'file', runCheck, replayRuns = 2,
  loadStore = defaultLoadStore, saveStore = defaultSaveStore, retireCheck = defaultRetireCheck,
}) {
  let store = loadStore(storePath)
  const flaky = await flakyActiveChecks(store, { goodArtifact, runCheck, replayRuns, kind })
  if (!flaky.length) return []
  for (const f of flaky) store = retireCheck(store, f.key, f.reason)
  saveStore(storePath, store)
  return flaky.map((f) => f.cmd)
}
