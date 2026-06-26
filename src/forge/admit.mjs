// src/forge/admit.mjs
// The Verifier Forge admission meta-gate: code owns whether a CANDIDATE verifier-check (a scorer command)
// may join the trusted verifier set. Admitted only if it DISCRIMINATES (passes a known-good artifact, fails
// a known-bad one) and its verdict is REPRODUCIBLE. The model may PROPOSE checks; a trivial always-pass
// check (which would lower the bar) or a flaky check is rejected here — the meta-stop. runCheck is injected
// so the decision logic is pure and unit-testable.

// Run a check `runs` times against one artifact; report the (consistent) verdict, or unstable if they disagree.
async function replay(runCheck, cmd, artifact, runs) {
  const verdicts = []
  for (let i = 0; i < Math.max(1, runs); i++) {
    const { pass } = await runCheck(cmd, artifact)
    verdicts.push(!!pass)
  }
  return { pass: verdicts[0], unstable: verdicts.some((v) => v !== verdicts[0]) }
}

export async function admitCheck({ candidateCmd, goodArtifact, badArtifact, replayRuns = 2, runCheck }) {
  const good = await replay(runCheck, candidateCmd, goodArtifact, replayRuns)
  if (good.unstable) return { admit: false, reason: 'verdict on the known-good artifact is not reproducible — the check is flaky' }
  if (!good.pass) return { admit: false, reason: 'rejects a known-good artifact — false-positive-prone, would block honest fixes' }
  const bad = await replay(runCheck, candidateCmd, badArtifact, replayRuns)
  if (bad.unstable) return { admit: false, reason: 'verdict on the known-bad artifact is not reproducible — the check is flaky' }
  if (bad.pass) return { admit: false, reason: 'passes a known-bad artifact — trivial / non-discriminating, catches nothing' }
  return { admit: true, reason: `discriminates (passes good, fails bad) reproducibly over ${replayRuns} runs` }
}
