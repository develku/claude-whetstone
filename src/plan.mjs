// Track A orchestration (spec §3.2) — the planManifest pipeline. Turns a goal + repo + an operator scorer
// allowlist into an objective manifest that survives the VERBATIM convergeRefusal, then a report-only
// coverage estimate. The ONE paid model call is INJECTED (deps.planCall) so this whole module is
// $0-testable with a stub. The planner is a fenced OPERATOR, not a privileged path: it forks no gate and
// edits none of the 7 invariant files. Pure given the injected planCall (+ the injected repoFiles list).
//
//   goal+allowlist+repoContext -> planCall (UNTRUSTED reply) -> parsePlannerReply
//     -> per proposal: planSchemaValid (DROP) -> resolveObjective fence (DROP) -> resolved[]
//     -> planRefusal (the anti-gaming guards; any reason -> throw exit 2)
//     -> assemble manifest (model objectives + OPERATOR floor/cap/budget)
//     -> convergeRefusal VERBATIM (defense in depth; the planner manifest meets the same bar)
//     -> coverage (report-only) + the loud disclosures
import { resolveObjective } from './plan-resolve.mjs'
import { planSchemaValid, planRefusal, MIN_TARGET, MAX_OBJECTIVES } from './plan-refuse.mjs'
import { coverageDetail, PLAN_DISCLOSURES } from './plan-coverage.mjs'
import { buildPlannerPrompt, parsePlannerReply } from './plan-prompt.mjs'
import { convergeRefusal } from './converge-cli.mjs'
import { canonRel, globalReadOnly } from './converge-shared.mjs'

// One-line descriptions of the shipped data-only scorers, for the prompt menu. An operator custom scorer
// (unknown id) is labelled generically — the operator vouches for its adequacy (§11.4 disclosure).
const SCORER_DESCRIPTIONS = {
  contains: 'substring / text-presence assertions over the editor output (data-only)',
  'io-assert': 'JSON input=>expected case assertions over function output (data-only)',
  'io-trace': 'method-call trace assertions over recorded calls (data-only, stateful behaviour)',
  'io-invariant': 'invariants that must hold across shuffled / replayed inputs (data-only)',
  'io-effect': 'side-effect / sink trace assertions (data-only)',
}

// buildAllowlistMenu(allowlist) -> the trusted instruction block listing the ONLY legal scorerId values.
export function buildAllowlistMenu(allowlist) {
  return [...allowlist.keys()]
    .map((id) => `- ${id}: ${SCORER_DESCRIPTIONS[id] ?? '(operator-provided data-only scorer)'}`)
    .join('\n')
}

// The editable surface (§6 denominator): git ls-files MINUS globalReadOnly(manifest) MINUS the test dirs.
// Read-only/gate files and tests are not editable, so excluding them keeps the span honest. Disclosed.
export function computeEditableSurface(repoFiles, manifest, scopeDir, testDirs = []) {
  const exclude = [...globalReadOnly(manifest, scopeDir), ...testDirs].map(canonRel).filter(Boolean)
  const underAny = (f) => exclude.some((e) => f === e || f.startsWith(e + '/'))
  return [...new Set((repoFiles ?? []).map(canonRel))].filter((f) => f && !underAny(f))
}

// Build the manifest from the resolved (model) objectives + the OPERATOR-authored floor/cap/budget. The
// floor is NEVER model-generated. Shape is identical to an operator-authored manifest (initConvergeState
// reads it unchanged).
function assembleManifest({ goal, floor, objectives, objectiveCap, globalBudgetUsd, globalBudgetTokens }) {
  return {
    goal,
    floor: { cmd: floor.cmd, readOnly: floor.readOnly ?? [], ...(floor.andConfirm != null ? { andConfirm: floor.andConfirm } : {}) },
    objectives,
    ...(objectiveCap != null ? { objective_cap: objectiveCap } : {}),
    ...(globalBudgetUsd != null ? { global_budget_usd: globalBudgetUsd } : {}),
    ...(globalBudgetTokens != null ? { global_budget_tokens: globalBudgetTokens } : {}),
  }
}

async function callPlan(planCall, prompt, opts) {
  const r = await planCall(prompt, opts)
  if (typeof r === 'string') return { text: r, spentUsd: 0, spentTokens: 0 }
  return { text: r?.text ?? '', spentUsd: r?.spentUsd ?? 0, spentTokens: r?.spentTokens ?? 0 }
}

const refuse = (reason, rejected) => {
  const e = new Error(reason)
  e.exitCode = 2
  if (rejected) e.planRejected = rejected
  return e
}

// planManifest(cfg, deps) -> { manifest, report, spentUsd, spentTokens }. Throws (e.exitCode=2) on any
// planner refusal, a convergeRefusal rejection of the generated manifest, or an unparseable model reply.
export async function planManifest(cfg, deps) {
  const {
    goal, scopeDir, floor, objectiveCap = null, globalBudgetUsd = null, globalBudgetTokens = null,
    repoContext = '', testDirs = [], objectivesPath = null, minTarget = MIN_TARGET, maxObjectives = MAX_OBJECTIVES,
  } = cfg
  const { planCall, allowlist, repoFiles = [], planCallOpts = {} } = deps

  const prompt = buildPlannerPrompt(goal, repoContext, buildAllowlistMenu(allowlist))
  // The planner call and the reply parse are the UNTRUSTED boundary — a failure here is a planner failure,
  // not an engine error. Wrap both so the thrown error carries exitCode=2 (the CLI/API contract; M1).
  let text, spentUsd, spentTokens
  try {
    ;({ text, spentUsd, spentTokens } = await callPlan(planCall, prompt, planCallOpts))
  } catch (e) {
    throw refuse(`planner call failed: ${e.message}`)
  }
  let proposals
  try {
    proposals = parsePlannerReply(text) // throws on non-JSON / missing objectives -> planner failure
  } catch (e) {
    throw refuse(e.message)
  }

  const resolved = []
  const rejected = []
  for (const p of proposals) {
    if (!planSchemaValid(p)) { rejected.push({ id: p?.id, reason: 'schema' }); continue }
    const obj = resolveObjective(p, { scopeDir, allowlist })
    if (!obj) { rejected.push({ id: p.id, reason: 'fence' }); continue }
    resolved.push(obj)
  }

  const reason = planRefusal({ objectives: resolved, rejected, scopeDir, minTarget, maxObjectives })
  if (reason) throw refuse(reason, rejected)

  const manifest = assembleManifest({ goal, floor, objectives: resolved, objectiveCap, globalBudgetUsd, globalBudgetTokens })
  // objectivesPath defaults to null here: this is the IN-PROCESS call — the manifest is not yet written to
  // disk, so manifestInsideScope is a no-op (the path-vs-scope check is meaningless in-memory). plan-cli.mjs
  // (inc 8) enforces "--out is OUTSIDE --scope" at write time, and convergence re-validates from disk.
  const cReason = convergeRefusal({ scope: scopeDir, objectivesPath, manifest })
  if (cReason) throw refuse(`convergeRefusal rejected the generated manifest: ${cReason}`, rejected)

  const surface = computeEditableSurface(repoFiles, manifest, scopeDir, testDirs)
  const cov = coverageDetail(manifest, surface)
  return {
    manifest,
    report: {
      coverage_score: cov.score,
      editable_surface_size: cov.surfaceSize,
      covered_size: cov.coveredSize,
      objectives_sufficiency: 'unproven',
      rejected,
      disclosures: PLAN_DISCLOSURES,
    },
    spentUsd,
    spentTokens,
  }
}
