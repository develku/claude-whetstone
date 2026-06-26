// src/forge/run.mjs
// Verifier Forge brick 4a — the cycle: from a good/gamed artifact pair, GENERATE candidate checks (brick 3),
// ADMIT each (brick 1), and STORE the admitted (brick 2). Pure given injected generate/admit/store ops, so
// the whole produce path is unit-testable with zero model/scorer/disk spend. The trigger (a recovered veto)
// and the real wiring live in src/forge/hook.mjs; consumption of stored checks by the gate is brick 4b.
//
// Frontier 2a — differential corroboration (optional, injected): before paying for generate, ask independent
// operator-trusted oracles whether the good/bad labelling holds; if a stable oracle disputes it, decline to
// learn from a suspect veto. The decline arm returns the FULL shape (empty/zero defaults) so every existing
// consumer (driver.mjs, bench harnesses) keeps working — conflicts/excluded/corroborated are purely additive.
import { checkKey as defaultCheckKey } from './store.mjs'

export async function runForge({
  goal, goodArtifact, badArtifact, critique = '', scorerCatalog, allowlist, storePath,
  generate, admit, loadStore, saveStore, addCheck, checkKey = defaultCheckKey,
  corroborate, oracleCmds = [],
  replayRuns = 2, target = 100, maxCandidates = 5,
}) {
  let excluded = []
  if (corroborate) {
    const corr = await corroborate({ goodArtifact, badArtifact, oracleCmds, replayRuns })
    excluded = corr.excluded ?? []
    if (!corr.corroborated) {
      return { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: corr.conflicts, excluded, corroborated: false }
    }
  }
  const gen = await generate({ goal, goodArtifact, badArtifact, critique, scorerCatalog, allowlist, maxCandidates })
  let store = loadStore(storePath)
  const retiredKeys = new Set((store.retired ?? []).map((t) => t.key))
  const admitted = []
  const rejected = [...gen.rejected]
  for (const c of gen.candidates) {
    const v = await admit({ candidateCmd: c.cmd, goodArtifact, badArtifact, replayRuns })
    if (!v.admit) { rejected.push({ scorerId: c.scorerId, reason: v.reason }); continue }
    // A check the operator deliberately RETIRED would be folded out of the gate anyway (listActiveChecks),
    // so re-admitting it is inert — report it as rejected (accurate accounting), not a fresh admission.
    if (retiredKeys.has(checkKey({ cmd: c.cmd, target }))) {
      rejected.push({ scorerId: c.scorerId, reason: 'previously retired by the operator — not re-admitted' })
      continue
    }
    admitted.push({ cmd: c.cmd, target, reason: v.reason })
  }
  if (admitted.length) {
    for (const a of admitted) store = addCheck(store, a)
    saveStore(storePath, store)
  }
  return { admitted, rejected, candidates: gen.candidates, costUsd: gen.costUsd ?? 0, tokens: gen.tokens ?? 0, conflicts: [], excluded, corroborated: true }
}
