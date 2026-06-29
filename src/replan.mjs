// replan.mjs — Inc 3b of the dynamic-control-plane plan: automate the re-decomposition PROPOSAL on a stall.
//
// When a converge run stalls with a structural signal (Inc 2: impossibility / contradiction / held_out_fail), the
// loop's CURRENT decomposition is insufficient. proposeReplan regenerates a DIFFERENT decomposition via the Track A
// planner (planManifest) and returns it as a PROPOSAL for human review. Two safety invariants from the cross-model
// DCA (~/.claude/dca/20260629T141245_inc3-outer-loop-replan-safety.md, Option B):
//   1. PROPOSER-ONLY / HUMAN-ONLY acceptance — proposeReplan NEVER runs converge. It returns a manifest; a human
//      reviews it and re-runs converge if they accept (the second permanently-human atom).
//   2. The immutable GLOBAL held-out truth is CARRIED VERBATIM — a replan revises the decomposition ("HOW"), never
//      the truth bar ("WHAT"). replanTruthPreserved asserts the held-out hash is unchanged; the full convergeRefusal
//      suite re-validates the proposed manifest (so the new editScopes still cannot touch the truth scorer).
import { convergeRefusal } from './converge-cli.mjs'
import { heldOutTruthHash } from './converge-state.mjs'

// Enrich the goal with the stall signal so the planner re-decomposes DIFFERENTLY (not a re-roll of the same plan).
// The global held-out truth is NOT leaked into the prompt (it is held-out); only the goal + why it stalled.
export function replanGoal(goal, signal, detail = '') {
  return `${goal}\n\n[REPLAN] The prior decomposition stalled: ${signal}${detail ? ` (${detail})` : ''}. Propose a DIFFERENT decomposition into measurable objectives whose union achieves the goal. The global held-out truth is fixed and judged independently.`
}

// Carry the OPERATOR-authored, immutable parts of the prior manifest (goal, floor, caps/budgets, and the global
// held-out truth) VERBATIM; swap ONLY the objectives for the regenerated decomposition. Pure.
export function assembleReplanManifest(priorManifest, newObjectives) {
  return {
    goal: priorManifest.goal,
    floor: priorManifest.floor,
    ...(priorManifest.objective_cap != null ? { objective_cap: priorManifest.objective_cap } : {}),
    ...(priorManifest.global_budget_usd != null ? { global_budget_usd: priorManifest.global_budget_usd } : {}),
    ...(priorManifest.global_budget_tokens != null ? { global_budget_tokens: priorManifest.global_budget_tokens } : {}),
    objectives: newObjectives,
    ...(priorManifest.global_held_out != null ? { global_held_out: priorManifest.global_held_out } : {}),
  }
}

// The truth bar is immutable across a replan: the held-out hash (content + membership) must be identical. Pure.
export function replanTruthPreserved(priorManifest, proposedManifest) {
  return heldOutTruthHash(priorManifest.global_held_out ?? []) === heldOutTruthHash(proposedManifest.global_held_out ?? [])
}

// proposeReplan(cfg, deps) -> { manifest, report, spentUsd, spentTokens, accepted:false }. Generates a re-decomposition
// PROPOSAL; NEVER runs converge. Throws (e.exitCode=2 via planManifest, or here) on a planner refusal, a
// convergeRefusal rejection of the proposed manifest, or a truth-preservation violation.
export async function proposeReplan(cfg, deps) {
  const {
    priorManifest, scopeDir, structuralSignal, signalDetail = '',
    repoContext = '', testDirs = [], objectivesPath = null, minTarget, maxObjectives,
  } = cfg
  const plan = deps.planManifest // injectable (default wired by the CLI to the real planManifest)
  if (typeof plan !== 'function') throw new Error('proposeReplan requires deps.planManifest')

  const planResult = await plan(
    {
      goal: replanGoal(priorManifest.goal, structuralSignal, signalDetail),
      scopeDir,
      floor: priorManifest.floor, // the floor is operator-authored, NEVER model-generated — carried through
      objectiveCap: priorManifest.objective_cap ?? null,
      globalBudgetUsd: priorManifest.global_budget_usd ?? null,
      globalBudgetTokens: priorManifest.global_budget_tokens ?? null,
      repoContext, testDirs, objectivesPath: null, minTarget, maxObjectives,
    },
    deps,
  )

  const manifest = assembleReplanManifest(priorManifest, planResult.manifest.objectives)

  // Re-validate the FULL proposal (now carrying the global held-out truth) — the new editScopes must still pass
  // every refusal guard, including convergeHeldOutTruthGuards (truth scorer outside every editScope).
  const cReason = convergeRefusal({ scope: scopeDir, objectivesPath, manifest })
  if (cReason) { const e = new Error(`convergeRefusal rejected the proposed replan: ${cReason}`); e.exitCode = 2; throw e }

  // Defense-in-depth: the assembled proposal must preserve the immutable truth bar (carry is verbatim, so this
  // holds by construction — the guard catches any future refactor that lets the proposer touch the truth).
  if (!replanTruthPreserved(priorManifest, manifest)) { const e = new Error('proposed replan would change the immutable global held-out truth — refused'); e.exitCode = 2; throw e }

  return { manifest, report: { ...planResult.report, replan_signal: structuralSignal }, spentUsd: planResult.spentUsd, spentTokens: planResult.spentTokens, accepted: false }
}
