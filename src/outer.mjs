// outer.mjs — the OUTER LOOP (capstone): connect the structural-feedback detector (Inc 2) to the re-decomposition
// proposer (Inc 3b). It runs the INNER converge; on a replan-WORTHY stall it emits a re-decomposition PROPOSAL for
// human review. It NEVER accepts/runs the proposal — acceptance is the human re-running converge on it (the second
// permanently-human atom). Pure composition; deps inject runConverge / proposeReplan / writeProposal for $0 tests.
//
// This realizes the operator's "the loop must deal with feedback dynamically" requirement: inner loop edits under
// the measured gate; when the gate says the DECOMPOSITION (not just this pass) is wrong, the outer loop surfaces a
// fix for the human — without ever moving the immutable truth bar or auto-applying a self-generated replan.

// Only a wrong-DECOMPOSITION signal warrants a replan. A plateau / budget / cap stall is a depth/cost limit, not a
// decomposition fault, so it does NOT trigger a re-decomposition proposal.
const REPLAN_WORTHY = new Set(['impossibility', 'contradiction', 'held_out_fail'])
export function replanWorthy(signal) {
  return REPLAN_WORTHY.has(signal)
}

// runOuterLoop(cfg, deps) -> { state, verdict, proposal: {manifest, path, report} | null, reason }. deps:
// runConverge (the inner gate) + proposeReplan (the Inc 3b proposer) + writeProposal + log + the planner deps that
// proposeReplan forwards (planManifest / planCall / allowlist / repoFiles). Runs the inner loop ONCE; on a
// replan-worthy stall it PROPOSES (writes the file) and stops for the human — it does not loop autonomously.
export async function runOuterLoop(cfg, deps) {
  const { manifest, scopeDir, proposeOnStall = false, proposalOut, repoContext, testDirs, minTarget, maxObjectives } = cfg
  const log = deps.log ?? (() => {})

  const { state, verdict } = await deps.runConverge(cfg, manifest)
  if (verdict.status === 'done') { log('outer: inner run converged — no replan needed'); return { state, verdict, proposal: null, reason: 'converged' } }

  const signal = state?.structural_signal ?? null
  if (!proposeOnStall) return { state, verdict, proposal: null, reason: `stalled (${verdict.status}${signal ? `, ${signal}` : ''}) — replan proposal disabled` }
  if (!replanWorthy(signal)) return { state, verdict, proposal: null, reason: signal ? `stalled (${signal}) — not a decomposition fault; no replan` : `stalled (${verdict.status}) — no structural signal; no replan` }

  const proposed = await deps.proposeReplan(
    { priorManifest: manifest, scopeDir, structuralSignal: signal, repoContext, testDirs, objectivesPath: proposalOut, minTarget, maxObjectives },
    deps,
  )
  ;(deps.writeProposal ?? (() => {}))(proposalOut, proposed.manifest)
  log(`outer: replan proposal for '${signal}' written to ${proposalOut} — HUMAN REVIEW required (NOT applied)`)
  return { state, verdict, proposal: { manifest: proposed.manifest, path: proposalOut, report: proposed.report }, reason: `stalled (${signal}) — replan proposal written for human review` }
}
