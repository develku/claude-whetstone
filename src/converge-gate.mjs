// The REPO-LEVEL gate. Like gate.mjs, this is the one thing the MODEL must not own: it reads only the
// numbers the scorers produced and decides continue/stop in code, over a VECTOR of objectives instead of
// one. PURE, no I/O — that is what makes it testable and trusted. It COMPOSES gate.mjs's validScore and
// mirrors its precedence; it NEVER edits gate.mjs (one of the 7 invariant files).
//
// DONE is a boolean-AND of per-objective MET on the HELD-OUT signal (the confirm for a judge-class
// objective, never the gameable primary), NOT a MIN of raw scores — per-objective targets differ, so a
// global MIN>=min-target would falsely pass. Stability (≥2× re-measure), budget, and regression-rollback
// are the ORCHESTRATOR's job (converge.mjs), exactly as loop.mjs wraps the pure gateVerdict — keeping this
// function pure and $0-testable.
import { validScore } from './gate.mjs'

// The decision score: the held-out confirm for a judge-class objective (the primary is gameable, so a
// model-based judge must enter MET only via the independent confirm), the primary for a deterministic
// objective (its scorer IS ground truth — a test command can't be flattered the way a judge can).
export function objectiveScore(o) {
  return o.judgeClass ? o.confirmScore : o.primaryScore
}

export function objectiveMet(o) {
  const s = objectiveScore(o)
  return validScore(s) && s >= o.target
}

function runningMax(scores) {
  const out = []
  let m = -Infinity
  for (const s of scores) {
    m = Math.max(m, s)
    out.push(m)
  }
  return out
}

// The FULL-VECTOR monotonic regression guard (DCA refinement #1). Used by the orchestrator AFTER a
// re-measure to decide rollback; the gate itself never sees a regressing state (the orchestrator rolls it
// back first). Regresses iff: the deterministic floor failed; OR a previously-MET objective fell below its
// target; OR ANY objective (met or unmet) dropped more than min_delta below its pre-integration score —
// the last clause is what protects the in-progress (F2P) frontier from an objective-ordering exploit, and
// catches a met objective sliding 100->91 at target 90 that a bare "below target" predicate would miss.
export function globalRegressed(objectives, floorScore, minDelta) {
  if (floorScore === 0) return true
  for (const o of objectives) {
    const s = objectiveScore(o)
    if (o.met && (!validScore(s) || s < o.target)) return true
    if (o.pre_integration_score != null && validScore(s) && o.pre_integration_score - s > minDelta) return true
  }
  return false
}

// Precedence: floor-veto > error > done > capped > plateau > running. The floor is folded ABOVE all (the
// §6.3 "never a judge-only top gate" mandate). Returns { status, reason }.
export function globalVerdict(g) {
  const objs = g.objectives ?? []

  // 1. FLOOR VETO — a broken repo dominates every objective verdict (mirrors gradeFloor's short-circuit).
  if (g.floor && g.floor.last_score === 0) {
    return { status: 'blocked', reason: `deterministic floor failed (${g.floor.cmd}); no objective verdict can stand` }
  }

  // 2. ERROR — a malformed decision score is never allowed to read as success or progress.
  for (const o of objs) {
    const s = objectiveScore(o)
    if (!validScore(s)) {
      return { status: 'error', reason: `objective ${o.id} produced an invalid score: ${String(s)} (need a number in 0..100)` }
    }
  }

  const unmet = objs.filter((o) => !objectiveMet(o))

  // 3. DONE — every declared objective met AND the floor held. Boolean-AND of MET, NEVER MIN(scores).
  // (Regression-freeness and stability are guaranteed by the orchestrator before it asks the gate.)
  if (unmet.length === 0) {
    return {
      status: 'done',
      reason: `all ${objs.length} DECLARED objectives met (held-out confirms passed, floor held, no cross-file regression) — proves the manifest, NOT repo-goal sufficiency`,
    }
  }

  // 4. CAPPED — the global cycle ceiling reached with objectives still short (done beat this above).
  if (g.global_pass >= g.global_cap) {
    const worst = unmet.reduce((w, o) => (objectiveScore(o) < objectiveScore(w) ? o : w), unmet[0])
    return { status: 'capped', reason: `global cap of ${g.global_cap} cycles hit; ${unmet.length} objective(s) below target (worst: ${worst.id})` }
  }

  // 5. PLATEAU — the binding (worst-unmet) score stalled across the window (mirror gate.mjs's runningMax).
  const hist = g.binding_history ?? []
  const window = g.global_plateau_window ?? 3
  if (hist.length > window) {
    const best = runningMax(hist)
    const improvement = best.at(-1) - best.at(-1 - window)
    if (improvement < (g.global_min_progress ?? 1)) {
      return {
        status: 'plateau',
        reason: `binding objective improved by ${improvement.toFixed(2)} (< min_progress ${g.global_min_progress ?? 1}) over the last ${window} cycles`,
      }
    }
  }

  // 6. RUNNING
  return { status: 'running', reason: `${unmet.length} objective(s) below target; continuing` }
}
