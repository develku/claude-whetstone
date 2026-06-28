// Track A's planner-only refusal suite (spec §5) — runs AFTER the fence (plan-resolve), BEFORE the
// verbatim convergeRefusal. It holds the MODEL's output to a HIGHER bar than an operator's hand (a model
// is harder to trust). Pure: each guard returns a refusal reason string, or null. plan.mjs (inc 6) wires
// the fail-closed exit-2 behavior; this module only computes the verdicts.
//
// Two tiers of severity, deliberately different (spec §5):
//   - planSchemaValid is a DROP guard: a malformed proposal is model noise — drop it, keep the good ones
//     (mirrors the fence returning null). It validates target is a FINITE NUMBER, which MUST run before
//     planTargetFloor — otherwise a non-number target makes `NaN < floor` false and the gaming objective
//     slips the floor (the inc-1 power-review L1 finding).
//   - the substantive anti-gaming guards (target floor, judge, data-only, count, all-dropped) REFUSE the
//     WHOLE run (exit 2), NOT silent-skip — else a model learns gaming objectives just get filtered while
//     its good ones proceed. Refuse loudly so the operator sees the gaming attempt.
import { resolve, sep } from 'node:path'
import { canonRel, isJudgeClass } from './converge-shared.mjs'
import { isUnsafeScorer } from './scorer-safety.mjs'
import { PLAN_SHELL_SCORERS } from './plan-allowlist.mjs'

export const MIN_TARGET = 70 // a generated objective below this is treated as model gaming
export const MAX_OBJECTIVES = 12 // fan-out cost ceiling

// The fence emits shq-QUOTED scorer commands (`node '/path.mjs' '--arg'`), which defeat
// converge-shared.scriptTokens: a whitespace split breaks on a quoted path WITH SPACES (this repo's path
// has spaces) and the trailing quote (`...mjs'`) fails the extension match. This POSIX single-quote-aware
// splitter recovers the script-path tokens for the data-only re-assertion. It only needs to recover .mjs
// PATH tokens correctly (paths never contain a single quote); the backslash-escape edge case affects only
// ARGS with embedded quotes, which this check ignores.
function shellSplit(cmd) {
  const out = []
  let cur = '', inSingle = false, started = false
  for (const c of String(cmd)) {
    if (inSingle) { if (c === "'") inSingle = false; else cur += c }
    else if (c === "'") { inSingle = true; started = true }
    else if (c === ' ' || c === '\t') { if (started) { out.push(cur); cur = ''; started = false } }
    else { cur += c; started = true }
  }
  if (started) out.push(cur)
  return out
}
// In a fence-built command (`node <shq script> <shq args>...`) the EXECUTED script is ALWAYS slot 1.
// Restrict the data-only re-assertion to that slot: scanning every .mjs-looking token would false-positive
// on a data ARG that merely ends in .mjs and matches a shell-scorer stem (e.g. `contains --needle
// 'floor.mjs'`) — args are never executed, so flagging them would refuse a legitimate run (power-review M1).
const fenceScriptToken = (cmd) => {
  const t = shellSplit(cmd)[1] ?? ''
  return /\.(mjs|cjs|js|ts)$/.test(t) ? t : ''
}

const ALLOWED_PROPOSAL_KEYS = new Set(['id', 'goal', 'scorerId', 'args', 'editScope', 'target'])

// planSchemaValid(proposal) -> boolean: the RAW model proposal is well-formed. DROP it (do not refuse the
// run) when false. Rejects extra/injected keys, wrong types, empties, and a non-finite-number target.
export function planSchemaValid(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false
  for (const k of Object.keys(proposal)) if (!ALLOWED_PROPOSAL_KEYS.has(k)) return false // no extra/injected keys
  if (typeof proposal.id !== 'string' || !proposal.id.trim()) return false
  if (typeof proposal.goal !== 'string' || !proposal.goal.trim()) return false
  if (typeof proposal.scorerId !== 'string' || !proposal.scorerId.trim()) return false
  if (!Array.isArray(proposal.args) || !proposal.args.every((a) => typeof a === 'string')) return false
  if (typeof proposal.editScope !== 'string' || !proposal.editScope.trim()) return false
  if (typeof proposal.target !== 'number' || !Number.isFinite(proposal.target)) return false
  return true
}

// planTargetFloor(objectives, minTarget) -> reason|null: a trivially-low target is model gaming. A
// non-number target (which planSchemaValid should have dropped upstream) is treated as a refusal too,
// never silently passed via `NaN < floor` === false — belt-and-suspenders against a wiring regression.
export function planTargetFloor(objectives, minTarget = MIN_TARGET) {
  const bad = objectives
    .filter((o) => !(typeof o.target === 'number' && o.target >= minTarget))
    .map((o) => `${o.id}(${o.target})`)
  return bad.length
    ? `generated objectives below the target floor ${minTarget}: ${bad.join(', ')} — a sub-floor (or non-numeric) target is model gaming`
    : null
}

// planNoJudgeScorer(objectives) -> reason|null: a resolved judge-class scorer (the capture surface A5
// excludes). Defense in depth — the data-only allowlist already excludes llm-judge, but a custom operator
// scorer whose path contains 'llm-judge' would be caught here too.
export function planNoJudgeScorer(objectives) {
  const j = objectives.filter((o) => isJudgeClass(o)).map((o) => o.id)
  return j.length ? `judge-class objective scorer(s) not allowed (data-only MVP): ${j.join(', ')}` : null
}

// planDataOnlyScorer(objectives) -> reason|null: re-assert no shell-executing scorer survived the
// allowlist (the #1 risk). Should never fire — the allowlist already HARD-subtracts them — but a green
// re-assertion here is the auditable proof for the report.
export function planDataOnlyScorer(objectives) {
  for (const o of objectives) {
    const t = fenceScriptToken(o.scorer ?? '')
    if (t && isUnsafeScorer(t, PLAN_SHELL_SCORERS))
      return `objective ${o.id} resolved to a shell-executing scorer (${t}) — only data-only scorers are allowed; the allowlist should have subtracted it`
  }
  return null
}

// planObjectiveCount(objectives, max) -> reason|null: a fan-out blowup cost guard.
export function planObjectiveCount(objectives, max = MAX_OBJECTIVES) {
  return objectives.length > max
    ? `manifest has ${objectives.length} objectives, above the cap ${max} — fan-out cost guard (raise --max-objectives to allow more)`
    : null
}

// planAllDropped(objectives, rejected) -> reason|null: the fence + schema gate dropped EVERY proposal
// (a bad allowlist or an off-goal model). Fail-closed proof: exit 2 printing why each was rejected.
export function planAllDropped(objectives, rejected = []) {
  if (objectives.length > 0) return null
  const list = rejected.map((r) => `${r.id ?? '?'}:${r.reason}`).join(', ') || '(none recorded)'
  return `all proposed objectives were dropped — none survived the schema gate + fence; rejected: ${list}`
}

// planEditScopeInRepo(objectives, scopeDir) -> reason|null: the fence already enforced containment + the
// root reject; this re-asserts it as an auditable predicate so a future fence weakening is caught here.
export function planEditScopeInRepo(objectives, scopeDir) {
  const base = resolve(scopeDir)
  for (const o of objectives) {
    const rel = canonRel(o.editScope ?? '')
    const full = resolve(base, rel)
    if (rel === '' || full === base || !full.startsWith(base + sep))
      return `objective ${o.id} editScope (${o.editScope}) is not a non-root in-repo path — the fence should have dropped it`
  }
  return null
}

// planRefusal({ objectives, rejected, scopeDir, minTarget, maxObjectives }) -> reason|null. Runs the
// substantive guards in order on the already-resolved objectives (schema + fence drops happen upstream in
// plan.mjs). Mirrors convergeRefusal's first-reason-wins shape. all-dropped is reported first.
export function planRefusal({ objectives, rejected = [], scopeDir, minTarget = MIN_TARGET, maxObjectives = MAX_OBJECTIVES }) {
  return (
    planAllDropped(objectives, rejected) ||
    planObjectiveCount(objectives, maxObjectives) ||
    planEditScopeInRepo(objectives, scopeDir) ||
    planTargetFloor(objectives, minTarget) ||
    planNoJudgeScorer(objectives) ||
    planDataOnlyScorer(objectives) ||
    null
  )
}
