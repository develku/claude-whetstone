// src/forge/admit.mjs
// The Verifier Forge admission meta-gate: code owns whether a CANDIDATE verifier-check (a scorer command)
// may join the trusted verifier set. Admitted only if it DISCRIMINATES (passes a known-good artifact, fails
// a known-bad one) and its verdict is REPRODUCIBLE. The model may PROPOSE checks; a trivial always-pass
// check (which would lower the bar) or a flaky check is rejected here — the meta-stop. runCheck is injected
// so the decision logic is pure and unit-testable.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shq } from '../shq.mjs'

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

// Default runCheck adapter: run the candidate as a whetstone scorer against an artifact and map its
// score to a boolean (score >= target -> pass), reusing the scorer contract used by the loop. A non-zero
// scorer exit throws (a broken check is not silently treated as a verdict). A temp loop dir we create is
// cleaned up after the run (the Forge calls this in admission loops — no /tmp accumulation).
export function scorerRunCheck(candidateCmd, artifact, { target = 100, loopDir } = {}) {
  const ours = loopDir == null
  const dir = ours ? mkdtempSync(join(tmpdir(), 'forge-check-')) : loopDir
  try {
    const full = `${candidateCmd} --output ${shq(artifact)} --loop-dir ${shq(dir)} --pass 000`
    const res = spawnSync(full, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000, killSignal: 'SIGKILL' })
    if (res.status !== 0) throw new Error(`candidate check exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`)
    return { pass: JSON.parse(res.stdout).score >= target }
  } finally {
    if (ours) rmSync(dir, { recursive: true, force: true })
  }
}
