// converge-diagnostics.mjs — the PURE structural-feedback detector (Inc 2 of the dynamic-control-plane plan).
//
// It reads a converge run's OBSERVABLE history (binding_history + the per-objective vector + the rounds ledger)
// and classifies it into a `structuralSignal` — the kind of feedback that means "the DECOMPOSITION is wrong, not
// just this pass". The outer loop (Inc 3, DEFERRED + DCA-gated) would consume this to decide whether to escalate
// for a REPLAN; for now it is surfaced only as an advisory field on the final state.
//
// DIAGNOSTIC ONLY — it never changes a verdict. globalVerdict (converge-gate.mjs) remains the SOLE gate authority;
// a structural signal is a hint for a human / replan seat, never a stop/done decision. Held strictly to the
// existing ledger shape so it composes around the gate step (no edits to runOneObjective / the 7 invariant files).
// Leaf module (node stdlib only, in fact none needed) — importable without cycles.

// Stall: the binding (worst-unmet) score gained < minProgress over the last `window` cycles, as a RAW
// first-vs-last delta. This is an INDEPENDENT, advisory heuristic — it intentionally differs from globalVerdict's
// plateau, which measures improvement over a monotonic running-max; on a non-monotonic history (a dip then a
// recovery) the two can disagree. The gate (globalVerdict) stays authoritative; this only feeds the advisory
// structural signal, so the divergence changes no gating decision.
export function plateaued(bindingHistory, window, minProgress) {
  if (!Array.isArray(bindingHistory) || bindingHistory.length < window + 1) return false
  const recent = bindingHistory.slice(-(window + 1))
  return recent[recent.length - 1] - recent[0] < minProgress
}

// Zero traction: every one of the last `window` binding readings sits at/below zeroTraction — the loop cannot move
// the worst objective AT ALL (combined with a plateau this is "impossible as decomposed").
export function noTraction(bindingHistory, window, zeroTraction = 0) {
  if (!Array.isArray(bindingHistory) || bindingHistory.length < window) return false
  return bindingHistory.slice(-window).every((s) => s <= zeroTraction)
}

// Objectives that PASS their visible gate but FAIL the held-out confirm (judge-class: primary>=target but
// confirm<target). The editor satisfied the gameable signal, not the truth — the strongest, most directly
// observable "objective/decomposition is wrong" tell.
export function heldOutFailingObjectives(objectives) {
  return (objectives ?? []).filter((o) =>
    o.judgeClass && typeof o.primaryScore === 'number' && o.primaryScore >= o.target &&
    (o.confirmScore == null || o.confirmScore < o.target))
}

// Distinct objectives that rolled back within the last `window` rounds (a rollback = an integration that
// regressed a sibling or failed the floor). The ledger does NOT name the regressed sibling, so >=2 distinct
// rollers within the window is a HEURISTIC "mutual interference" tell — advisory, not proof.
export function recentRollbackObjectives(rounds, window) {
  const recent = (rounds ?? []).slice(-window)
  return [...new Set(recent.filter((r) => r.rolledBack).map((r) => r.objectiveId))]
}

// The classifier. Priority is by reliability + actionability: a held-out failure is DIRECTLY observed; a
// contradiction (mutual rollback) and an impossibility (plateau + zero traction) are DERIVED; a plain plateau is
// the generic stall. Returns { signal, detail } with signal === null when the run is making healthy progress.
export function detectStructuralSignal(state, opts = {}) {
  const window = opts.window ?? state.global_plateau_window ?? 3
  const minProgress = opts.minProgress ?? state.global_min_progress ?? 1
  const zeroTraction = opts.zeroTraction ?? 0
  const objectives = state.objectives ?? []

  // 1) held-out failure — directly observed: a judge objective passing visible while failing held-out; an Inc-1
  //    tournament winner's-curse reject in a recent round; OR (Inc 3a) every objective met yet a GLOBAL held-out
  //    truth check unmet = the decomposition is insufficient for the goal.
  const recentRounds = (state.rounds ?? []).slice(-window)
  const guardFired = recentRounds.some((r) => r.structural_signal === 'held_out_no_progress')
  const heldOutFail = heldOutFailingObjectives(objectives)
  const unmetObj = objectives.filter((o) => o.status !== 'met' && o.status !== 'skipped')
  const globalTruthUnmet = (state.global_held_out ?? []).filter((c) => !(typeof c.score === 'number' && c.score >= c.target))
  const decompInsufficient = unmetObj.length === 0 && globalTruthUnmet.length > 0
  if (guardFired || heldOutFail.length || decompInsufficient) {
    const detail = decompInsufficient
      ? `all objectives met but global held-out truth unmet (${globalTruthUnmet.map((c) => c.id).join(', ')}) — decomposition insufficient`
      : (heldOutFail.length ? `objective(s) ${heldOutFail.map((o) => o.id).join(', ')} pass visible but fail held-out` : 'tournament winner-curse guard rejected a round (no held-out progress)')
    return { signal: 'held_out_fail', detail }
  }

  // 2) contradiction — derived heuristic: >=2 distinct objectives keep undoing each other within the window.
  const rollers = recentRollbackObjectives(state.rounds, window)
  if (rollers.length >= 2) {
    return { signal: 'contradiction', detail: `objectives ${rollers.join(', ')} keep rolling back within the last ${window} rounds (mutual interference suspected)` }
  }

  // 3) impossibility — derived: a plateau with zero traction (the worst objective never moves off ~0).
  const stalled = plateaued(state.binding_history, window, minProgress)
  if (stalled && noTraction(state.binding_history, window, zeroTraction)) {
    return { signal: 'impossibility', detail: `binding stalled at <=${zeroTraction} over ${window} cycles — target unreachable as decomposed` }
  }

  // 4) plateau — the generic stall (still has some traction, just no recent progress).
  if (stalled) {
    return { signal: 'plateau', detail: `binding gained <${minProgress} over the last ${window} cycles` }
  }

  return { signal: null, detail: 'healthy progress' }
}
