// src/forge/mutation-admit.mjs
// Mutation-backed admit: a policy WRAPPER over admitCheck (brick 1) that strengthens admission from "fails the
// ONE observed bad snapshot" to "kills an oracle-confirmed mutant NEIGHBOURHOOD" of the good artifact. This
// closes the pointwise-overfit hole (a check that fails the observed bad for a non-generalizing reason — e.g.
// `value()===0` on a fresh counter passes good and fails the constant-1 bad, yet misses an increment-no-op
// sibling whose fresh value is also 0). admit.mjs stays UNTOUCHED; this is injected through runForge's `admit`
// seam and ALWAYS calls the base gate first, returning it verbatim on reject — so mutationAdmit ⊑ baseAdmit
// (it only ever ADDS rejections; the overall gate can never become more permissive).
//
// Equivalent-mutant defense = ORACLE-filtered mutants (reusing 2a's --forge-oracle machinery), NOT
// candidate-I/O filtering. Only a mutant a trusted INDEPENDENT oracle REJECTS counts as a required-kill; a
// mutant the oracle accepts (equivalent) or errors on (non-parsing) is excluded. We never ask the candidate
// whether a mutant is bad (that would exclude exactly the sibling behaviour a weak check fails to observe).
//
// Codex-folded discipline (cross-model review): runCheck's {pass} is lossy, so classify() separates
// pass | reject | error | flaky. A candidate CRASH is NOT a kill (else a broken check earns crash-credit and
// still misses the real behavioural mutant). Usable oracles pass good REPRODUCIBLY. FILE-mode only.
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { admitCheck } from './admit.mjs'
import { mutate } from './mutate.mjs'

// Run a check `runs` times against one artifact and classify the outcome. A THROW (scorerRunCheck throws on a
// non-zero scorer exit — e.g. an unimportable/non-parsing mutant makes io-* die() exit 2) is `error`, cleanly
// separable from a `{pass:false}` clean `reject`. Disagreeing reads are `flaky`. Exported for direct test.
export async function classify(runCheck, cmd, artifact, runs = 2) {
  const verdicts = []
  for (let i = 0; i < Math.max(1, runs); i++) {
    let pass
    try { ({ pass } = await runCheck(cmd, artifact)) } catch (e) { return { outcome: 'error', error: String(e?.message ?? e) } }
    verdicts.push(!!pass)
  }
  if (verdicts.some((v) => v !== verdicts[0])) return { outcome: 'flaky' }
  return { outcome: verdicts[0] ? 'pass' : 'reject' }
}

// A candidate/oracle cmd that pins its artifact (scope `--rel`, or an explicit `--output` a fixed-path scorer
// reads first) would NOT actually evaluate the substituted mutant — so we must not (falsely) strengthen on it.
// (^|\s) so a flag at the very START of the cmd (no leading space) is still caught — the boundary is ENFORCED.
const carriesFixedArtifact = (cmd) => /(^|\s)--rel\b/.test(cmd) || /(^|\s)--output\b/.test(cmd)

// Default mutant materializer: read the good source, generate the neighbourhood, write each mutant as a SIBLING
// temp file in dirname(good) so relative imports still resolve, PRESERVING the original extension (so module
// resolution — .mjs/.cjs, package "type" — is unchanged). Returns the artifact paths + a cleanup thunk.
// (Basename-derived behaviour — import.meta.url sidecar lookups — is a documented limitation; Forge artifacts
// don't rely on it.) Injected so the wrapper logic is unit-testable with zero fs/scorer spend.
function defaultMaterializeMutants({ goodArtifact, maxMutants }) {
  const source = readFileSync(goodArtifact, 'utf8')
  const muts = mutate(source, { maxMutants })
  const dir = dirname(goodArtifact)
  const ext = extname(goodArtifact)
  const written = []
  const mutants = muts.map((m, i) => {
    const p = join(dir, `.forge-mutant-${process.pid}-${i}${ext}`)
    writeFileSync(p, m.source)
    written.push(p)
    return { operator: m.operator, artifact: p }
  })
  return { mutants, cleanup: () => { for (const p of written) rmSync(p, { force: true }) } }
}

export async function mutationAdmit({
  candidateCmd, goodArtifact, badArtifact, replayRuns = 2, runCheck,
  oracleCmds = [], mutationKillThreshold = 0.75, minConfirmedMutants = 2, maxMutants = 24,
  baseAdmit = admitCheck, materializeMutants = defaultMaterializeMutants,
}) {
  // 1. The base gate is the floor. Never admit anything admitCheck rejects (gate never more permissive).
  const base = await baseAdmit({ candidateCmd, goodArtifact, badArtifact, replayRuns, runCheck })
  if (!base.admit) return base

  // 2. FILE-mode only (enforced, not just documented).
  if (carriesFixedArtifact(candidateCmd) || oracleCmds.some(carriesFixedArtifact))
    return { ...base, mutation: { skipped: 'candidate/oracle carries --rel/--output — mutation admit is FILE-mode only' } }

  // 3. Mutation needs an independent oracle (reuses 2a). The library defensively degrades; the CLI refuses the
  //    flag without --forge-oracle (so the operator cannot silently get false confidence).
  if (!oracleCmds.length)
    return { ...base, mutation: { skipped: 'no oracle configured — mutation admit needs an independent oracle', confirmedMutants: 0 } }

  // 4. Usable oracle = passes good REPRODUCIBLY. A flaky/rejecting-good oracle is unusable (would mis-confirm).
  const usable = []
  for (const o of oracleCmds) if ((await classify(runCheck, o, goodArtifact, replayRuns)).outcome === 'pass') usable.push(o)
  if (!usable.length)
    return { ...base, mutation: { skipped: 'no usable oracle (none passes good reproducibly)', oraclesUsable: 0 } }

  const { mutants, cleanup } = materializeMutants({ goodArtifact, maxMutants })
  try {
    // 5. Oracle-filter: confirmed-bad iff some usable oracle CLEAN-rejects the mutant reproducibly. An oracle
    //    error (non-parsing mutant) or flaky verdict does NOT confirm — it is excluded.
    const confirmed = []
    let excluded = 0
    for (const m of mutants) {
      let isBad = false
      for (const o of usable) if ((await classify(runCheck, o, m.artifact, replayRuns)).outcome === 'reject') { isBad = true; break }
      if (isBad) confirmed.push(m); else excluded++
    }
    const mutation = { confirmedMutants: confirmed.length, killed: 0, crashed: 0, excluded, oraclesUsable: usable.length, threshold: mutationKillThreshold }
    if (confirmed.length < minConfirmedMutants)
      return { ...base, mutation: { ...mutation, note: `only ${confirmed.length} oracle-confirmed mutant(s) (< minConfirmedMutants=${minConfirmedMutants}) — neighbourhood too small to strengthen` } }

    // 6. Required-kill: a kill counts ONLY on a CLEAN candidate reject. A crash (error) and a flaky verdict are
    //    tracked separately and NEVER satisfy the threshold; a survived ('pass') candidate also lowers the ratio.
    let killed = 0
    let crashed = 0
    let flaky = 0
    for (const m of confirmed) {
      const oc = (await classify(runCheck, candidateCmd, m.artifact, replayRuns)).outcome
      if (oc === 'reject') killed++
      else if (oc === 'error') crashed++
      else if (oc === 'flaky') flaky++
    }
    mutation.killed = killed
    mutation.crashed = crashed
    mutation.flaky = flaky
    const ratio = killed / confirmed.length
    const admit = ratio >= mutationKillThreshold
    const reason = admit
      ? `mutation-backed admit: kills ${killed}/${confirmed.length} oracle-confirmed mutants (>= ${mutationKillThreshold}) — generalizes beyond the one observed bad`
      : `pointwise-overfit: kills only ${killed}/${confirmed.length} oracle-confirmed mutants (< ${mutationKillThreshold})${crashed ? `, ${crashed} crash(es) not counted as kills` : ''} — passes good and fails the observed bad but misses the mutant neighbourhood`
    return { admit, reason, mutation }
  } finally {
    cleanup()
  }
}
