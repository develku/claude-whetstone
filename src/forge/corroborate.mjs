// src/forge/corroborate.mjs
// Verifier Forge frontier 2a — differential corroboration. Before the Forge LEARNS a check from a veto, it
// asks INDEPENDENT operator-trusted oracle(s) whether the good/bad labelling actually holds (good is honest,
// bad is gamed). The Forge faithfully distils whatever the single confirm scorer believes — so if that one
// oracle is WRONG (vetoes a legitimately-correct artifact), the Forge fossilizes the mistake forever. A
// second independent oracle that DISAGREES marks the veto as suspect, and the Forge declines to learn.
//
// Honest scope: this REDUCES single-oracle single-point-of-failure and surfaces conflicts; it does NOT escape
// needing some trusted measure (you now trust ensemble AGREEMENT), and it does nothing for correlated errors
// (every oracle wrong the same way). With no oracle configured it degrades to today's single-oracle behavior.
//
// Agreement rule = UNANIMITY: any STABLE oracle's dissent => decline. The asymmetry justifies it — a
// false-decline costs one cheap recoverable check; a false-learn fossilizes a wrong veto permanently. But a
// FLAKY oracle (its own verdict not reproducible) is EXCLUDED from the quorum, NOT counted as a dissent —
// otherwise one noisy oracle would become a permanent learning kill-switch (strictly worse than the ceiling
// this fixes). Corroboration is judged over the STABLE oracles only.
//
// IMPORTANT invariant: oracleCmds are OPERATOR-authored full scorer commands (--forge-oracle, same trust class
// as --confirm-scorer) and run VERBATIM via the injected runCheck. They intentionally DO NOT pass through
// forgeAllowlist / the SHELL_SCORERS denylist (which gate MODEL-proposed checks) — do not "harden" them through it.

// Run a check `runs` times against one artifact; report the (consistent) verdict, or unstable if they
// disagree. Copied from admit.mjs (the Forge layers stay import-independent — stdlib only).
async function replay(runCheck, cmd, artifact, runs) {
  const verdicts = []
  for (let i = 0; i < Math.max(1, runs); i++) {
    const { pass } = await runCheck(cmd, artifact)
    verdicts.push(!!pass)
  }
  return { pass: verdicts[0], unstable: verdicts.some((v) => v !== verdicts[0]) }
}

export async function corroborateLabels({ goodArtifact, badArtifact, oracleCmds = [], replayRuns = 2, runCheck }) {
  const conflicts = [] // STABLE oracles that dissent — these decline learning (unanimity)
  const excluded = [] // FLAKY oracles set aside — surfaced but non-blocking
  for (const oracleCmd of oracleCmds) {
    const good = await replay(runCheck, oracleCmd, goodArtifact, replayRuns)
    const bad = await replay(runCheck, oracleCmd, badArtifact, replayRuns)
    if (good.unstable || bad.unstable) {
      const which = [good.unstable && 'good', bad.unstable && 'bad'].filter(Boolean).join(' and ')
      excluded.push({ oracleCmd, reason: `oracle verdict not reproducible (${which} unstable) — excluded from corroboration` })
    } else if (!good.pass) {
      conflicts.push({ oracleCmd, reason: 'independent oracle REJECTS the good artifact — the primary veto is disputed (good may be honest)' })
    } else if (bad.pass) {
      conflicts.push({ oracleCmd, reason: 'independent oracle ACCEPTS the bad artifact — the primary veto is disputed (bad may not be gamed)' })
    }
  }
  return { corroborated: conflicts.length === 0, conflicts, excluded, checked: oracleCmds.length }
}
