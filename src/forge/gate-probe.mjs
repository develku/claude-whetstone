// src/forge/gate-probe.mjs
// AUD-10 — gate self-probe (adversarial hacker-fixer). After a run reaches done, mutate the ACCEPTED artifact
// and run the COMPOSED confirm gate against each mutant. A mutant the gate reproducibly PASSES is a "survivor"
// — a broken variant the gate can't catch. The driver routes survivors into the Forge to learn a hardened check.
//
// PAID and opt-in: each probed mutant is a (possibly paid) gate run and each survivor a paid Forge generation.
// So this is SEQUENTIAL with EARLY-STOP at survivorCap — a leaky gate bounds BOTH the gate runs and the
// downstream learning. Defaults are conservative (DCA 20260703T222155: sample 4, survivorCap 1). Only a
// reproducible `pass` is a survivor; reject/error/flaky mean the gate WORKED and are never routed.
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { mutate } from './mutate.mjs'
import { classify } from './mutation-admit.mjs'

// deterministic stride sample across the operator-ordered mutant list (spreads over the operators).
function sample(mutants, n) {
  if (mutants.length <= n) return mutants
  const stride = mutants.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(mutants[Math.floor(i * stride)])
  return out
}

export async function runGateSelfProbe({ artifactPath, composedConfirmCmd, runCheck, mutateFn = mutate, sampleSize = 4, survivorCap = 1, replayRuns = 2 }) {
  let source
  try { source = readFileSync(artifactPath, 'utf8') } catch (e) { return { skipped: `cannot read artifact: ${e.message}` } }
  const mutants = mutateFn(source)
  if (!mutants.length) return { skipped: 'no mutable sites (the mutation operators are JS-source-tuned)' }
  const chosen = sample(mutants, sampleSize)
  const dir = dirname(artifactPath)
  const ext = extname(artifactPath)
  const survivors = []
  let probed = 0
  for (let i = 0; i < chosen.length && survivors.length < survivorCap; i++) {
    probed++
    const mutantPath = join(dir, `.gate-probe-mutant-${process.pid}-${i}${ext}`) // dot-prefixed: ignored by blast-radius + dir listings
    writeFileSync(mutantPath, chosen[i].source)
    // A reproducible `pass` = the gate MISSED a broken mutant (a hole). reject/error/flaky = the gate caught it.
    const { outcome } = await classify(runCheck, composedConfirmCmd, mutantPath, replayRuns)
    if (outcome === 'pass') survivors.push({ operator: chosen[i].operator, path: mutantPath }) // kept on disk for the caller to route to learning
    else rmSync(mutantPath, { force: true })
  }
  // Survivor files stay on disk so the driver can hand each as the `bad` artifact to the Forge; the caller
  // MUST call cleanup() after routing.
  return { sampled: chosen.length, probed, survivors, cleanup: () => { for (const s of survivors) rmSync(s.path, { force: true }) } }
}
