// src/gate-audit.mjs
// AUD-08 — primary-gate kill-rate audit (opt-in, post-done, ADVISORY). A weak primary scorer lets the loop
// converge confidently on a mediocre artifact; nothing measured how discriminating that scorer actually is.
// This mutates the final artifact, re-scores a small sample of mutants with the PRIMARY scorer, and reports how
// many the scorer KILLED (score < target) vs let SURVIVE (score >= target = the scorer failed to notice a broken
// variant). It NEVER changes the run's verdict — it is a number the operator reads after a done.
//
// Opt-in because each mutant is a full scorer run and the scorer may be paid (llm-judge). Bounded to sampleSize.
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { mutate } from './forge/mutate.mjs'

// Deterministic stride sample across the operator-ordered mutant list (spreads the sample over the 5 operators
// rather than taking the first N, which would over-weight the earliest operator).
function sample(mutants, n) {
  if (mutants.length <= n) return mutants
  const stride = mutants.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(mutants[Math.floor(i * stride)])
  return out
}

export async function runGateAudit({ artifactPath, targetScore, scoreOutput, mutateFn = mutate, sampleSize = 6 }) {
  let source
  try { source = readFileSync(artifactPath, 'utf8') } catch (e) { return { skipped: `cannot read artifact: ${e.message}` } }
  const mutants = mutateFn(source)
  if (!mutants.length) return { skipped: 'no mutable sites (the mutation operators are JS-source-tuned)' }
  const chosen = sample(mutants, sampleSize)
  const dir = dirname(artifactPath)
  const ext = extname(artifactPath)
  let killed = 0
  let survived = 0
  let errored = 0
  for (let i = 0; i < chosen.length; i++) {
    // dot-prefixed so the blast-radius walk (and any dir listing) ignores it; unique per pid+index.
    const mutantPath = join(dir, `.gate-audit-mutant-${process.pid}-${i}${ext}`)
    writeFileSync(mutantPath, chosen[i].source)
    try {
      const score = await scoreOutput(mutantPath)
      if (Number.isFinite(score) && score >= targetScore) survived++ // the scorer FAILED to kill a broken mutant
      else killed++
    } catch {
      errored++ // a scorer that crashes on the mutant earns no clean-kill credit (mutation-admit discipline)
    } finally {
      rmSync(mutantPath, { force: true })
    }
  }
  return { sampled: chosen.length, killed, survived, errored }
}
