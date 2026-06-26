// src/forge/run.mjs
// Verifier Forge brick 4a — the cycle: from a good/gamed artifact pair, GENERATE candidate checks (brick 3),
// ADMIT each (brick 1), and STORE the admitted (brick 2). Pure given injected generate/admit/store ops, so
// the whole produce path is unit-testable with zero model/scorer/disk spend. The trigger (a recovered veto)
// and the real wiring live in src/forge/hook.mjs; consumption of stored checks by the gate is brick 4b.
export async function runForge({
  goal, goodArtifact, badArtifact, critique = '', scorerCatalog, allowlist, storePath,
  generate, admit, loadStore, saveStore, addCheck,
  replayRuns = 2, target = 100, maxCandidates = 5,
}) {
  const gen = await generate({ goal, goodArtifact, badArtifact, critique, scorerCatalog, allowlist, maxCandidates })
  const admitted = []
  const rejected = [...gen.rejected]
  for (const c of gen.candidates) {
    const v = await admit({ candidateCmd: c.cmd, goodArtifact, badArtifact, replayRuns })
    if (v.admit) admitted.push({ cmd: c.cmd, target, reason: v.reason })
    else rejected.push({ scorerId: c.scorerId, reason: v.reason })
  }
  if (admitted.length) {
    let store = loadStore(storePath)
    for (const a of admitted) store = addCheck(store, a)
    saveStore(storePath, store)
  }
  return { admitted, rejected, candidates: gen.candidates, costUsd: gen.costUsd ?? 0, tokens: gen.tokens ?? 0 }
}
