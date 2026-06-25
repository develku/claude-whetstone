// The git-backed buildContext twin for the scope (repo) loop, injected into runPrepared via
// deps.buildContext. Only two things differ from driver.buildContext: evaluate runs the PROJECT
// scorer in cwd=scopeDir (so its test/build command executes inside the repo being raised), and
// persist commits the pass with gitSnapshot — the commit SHA IS history[].snapshot, which is both
// the keep-best ref and a self-commit/audit trail. The scope dir is carried in state.artifact_path
// (the "artifact" is the directory); everything else — escalation, confirm-veto, budget — is reused.
import { spawnSync } from 'node:child_process'
import { writeReview, recordPass, saveState, zeroPad } from './state.mjs'
import { gitSnapshot, gitVerifyAt } from './git-snapshot.mjs'
import { shq } from './shq.mjs'

const CHILD_TIMEOUT_MS = 5 * 60 * 1000

// Run the project scorer in cwd=scopeDir — same {score,critique,findings}+exit-code contract as the
// single-file path; the scored "output" is the scope dir itself.
function runScopeScorer(scorerCmd, { scopeDir, loopDir, pass }) {
  const full = `${scorerCmd} --output ${shq(scopeDir)} --loop-dir ${shq(loopDir)} --pass ${zeroPad(pass)}`
  const res = spawnSync(full, { shell: true, cwd: scopeDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`scorer failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return JSON.parse(res.stdout)
}

export function scopeBuildContext(loopDir) {
  const evaluate = async (s) => {
    const review = runScopeScorer(s.scorer_cmd, { scopeDir: s.artifact_path, loopDir, pass: s.history.length })
    return { score: review.score, critique: review.critique, review }
  }
  const persist = (s, ev) => {
    const pass = s.history.length
    const snapshot = gitSnapshot(s.artifact_path, `pass ${zeroPad(pass)}`)
    const reviewRef = writeReview(loopDir, pass, ev.review ?? { score: ev.score, critique: ev.critique })
    const next = recordPass(s, { score: ev.score, critique: ev.critique, snapshot, reviewRef, costUsd: ev.costUsd ?? 0, tokens: ev.tokens ?? 0 })
    saveState(loopDir, next)
    return next
  }
  // Done-edge confirm (v1 Forge graft): run the held-out scorer against a PRISTINE checkout of the pass
  // just committed, not the live working tree — so the finish is verified on exactly the committed state
  // the editor can't have left stray cruft in. Falls back to in-place only before the first snapshot.
  const confirm = async (s) => {
    const ref = s.history[s.history.length - 1]?.snapshot
    const score = (dir) => runScopeScorer(s.confirm_scorer_cmd, { scopeDir: dir, loopDir, pass: s.history.length })
    const review = ref ? gitVerifyAt(s.artifact_path, ref, score) : score(s.artifact_path)
    return { score: review.score, critique: review.critique }
  }
  return { evaluate, persist, confirm }
}
