// whetstone-converge entry: drives N per-objective scope runs under ONE code-owned global gate
// (src/converge-gate.mjs globalVerdict). This file owns the operator-facing INPUT contract — loading and
// validating the objectives manifest and the refuse-to-start safety suite — mirroring scope-cli's
// guard-suite-then-run shape. The orchestrator (runConverge, src/converge.mjs) is wired in a later step.
//
// The manifest is the META-GATE: operator-authored, lives OUTSIDE --scope, never model-editable. Every
// unsafe shape is REFUSED at start (exit 2), never silently coerced — the gate's integrity starts here.
import { readFileSync } from 'node:fs'
import { resolve, relative, dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUnsafeScorer } from './scorer-safety.mjs'

const SCORERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')
// A command-executing scorer (composite/floor: its contract is "run my --cmd/--scorers argument" via a
// shell) must never be an objective scorer — the operator names the scorer cmd, but a finding/model path
// into it would reach a shell. Same denylist + shared canonicalization as scope-cli/the Forge.
const SUBGATE_UNSAFE = new Set(['composite', 'floor'])
const SUBGATE_UNSAFE_PATHS = [join(SCORERS_DIR, 'composite.mjs'), join(SCORERS_DIR, 'floor.mjs')]

// --- path helpers (canonical repo-relative; the `base + sep` boundary kills the src/a vs src/app trap) ---

function canonRel(p) {
  let s = normalize(String(p).trim()).replace(/\/+$/, '')
  if (s.startsWith('./')) s = s.slice(2)
  return s === '.' ? '' : s
}

// Two repo-relative paths intersect iff equal, or one is an ancestor DIRECTORY of the other. '' (the repo
// root) intersects everything. Ancestry uses the trailing separator so 'src/a' does NOT contain 'src/app'.
export function pathsIntersect(a, b) {
  const x = canonRel(a)
  const y = canonRel(b)
  if (x === '' || y === '') return true
  if (x === y) return true
  return x.startsWith(y + '/') || y.startsWith(x + '/')
}

// Script-like tokens of a scorer command (operator-authored, space-separated).
function scriptTokens(cmd) {
  return String(cmd ?? '').split(/\s+/).filter((t) => /\.(mjs|cjs|js|ts)$/.test(t))
}

// Project-LOCAL scorer scripts: script tokens that resolve INSIDE --scope (relative to the scope, where the
// scorer runs). These must be read-only or the editor could game its own scorer by editing the script. An
// absolute whetstone scorer (outside scope) is NOT model-reachable and is not added.
function scorerScriptPaths(cmd, scope) {
  const base = resolve(scope)
  const out = []
  for (const t of scriptTokens(cmd)) {
    const abs = resolve(base, t)
    if (abs === base || abs.startsWith(base + sep)) out.push(relative(base, abs))
  }
  return out
}

// A judge-class objective is operator-flagged OR has a scorer/confirm that resolves to llm-judge.
export function isJudgeClass(o) {
  if (o.judgeClass === true) return true
  return /llm-judge/.test(`${o.scorer ?? ''} ${o.confirmScorer ?? ''}`)
}

// The union read-only set: every objective's own readOnly, the floor's declared footprint, and every
// project-local scorer/confirm SCRIPT. The denylist enforced (by the orchestrator) AFTER the editScope
// allowlist — so a footprint file inside an editScope is still reverted. manifestEditScopeReadOnlyCollision
// additionally forces these OUT of every editScope.
export function globalReadOnly(manifest, scope) {
  const set = new Set()
  for (const ro of manifest?.floor?.readOnly ?? []) set.add(canonRel(ro))
  for (const o of manifest?.objectives ?? []) {
    for (const ro of o.readOnly ?? []) set.add(canonRel(ro))
    for (const s of scorerScriptPaths(o.scorer ?? '', scope)) set.add(canonRel(s))
    if (o.confirmScorer) for (const s of scorerScriptPaths(o.confirmScorer, scope)) set.add(canonRel(s))
  }
  return [...set].filter(Boolean)
}

// --- structural validation (absorbs convergeNeedsFloor + convergeObjectivesNeedEditScope as required fields) ---

export function validateManifest(m) {
  const e = []
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest must be a JSON object']
  if (typeof m.goal !== 'string' || !m.goal.trim()) e.push('goal must be a non-empty string')
  if (!m.floor || typeof m.floor !== 'object' || typeof m.floor.cmd !== 'string' || !m.floor.cmd.trim())
    e.push('floor.cmd must be a non-empty string (the deterministic floor is mandatory)')
  if (m.floor && m.floor.readOnly != null && !Array.isArray(m.floor.readOnly)) e.push('floor.readOnly must be an array of paths')
  if (m.global_budget_usd != null && (!Number.isFinite(m.global_budget_usd) || m.global_budget_usd <= 0)) e.push('global_budget_usd must be a positive number')
  if (m.global_budget_tokens != null && (!Number.isInteger(m.global_budget_tokens) || m.global_budget_tokens <= 0)) e.push('global_budget_tokens must be a positive integer')
  if (m.objective_cap != null && (!Number.isInteger(m.objective_cap) || m.objective_cap < 1)) e.push('objective_cap must be a positive integer')
  if (!Array.isArray(m.objectives) || m.objectives.length === 0) {
    e.push('objectives must be a non-empty array')
    return e
  }
  const ids = new Set()
  m.objectives.forEach((o, i) => {
    const w = `objectives[${i}]`
    if (typeof o.id !== 'string' || !o.id.trim()) e.push(`${w}.id must be a non-empty string`)
    else if (ids.has(o.id)) e.push(`duplicate objective id: ${o.id}`)
    else ids.add(o.id)
    const tag = o.id ?? i
    if (typeof o.goal !== 'string' || !o.goal.trim()) e.push(`objective ${tag} goal must be a non-empty string`)
    if (typeof o.scorer !== 'string' || !o.scorer.trim()) e.push(`objective ${tag} scorer must be a non-empty string`)
    if (typeof o.target !== 'number' || !Number.isFinite(o.target) || o.target < 0 || o.target > 100) e.push(`objective ${tag} target must be a number 0..100`)
    if (typeof o.editScope !== 'string' || !o.editScope.trim()) e.push(`objective ${tag} editScope must be a non-empty string (mandatory — the positive edit allowlist)`)
    if (o.cap != null && (!Number.isInteger(o.cap) || o.cap < 1)) e.push(`objective ${tag} cap must be a positive integer`)
  })
  return e
}

// --- refusal guards (cross-cutting safety; each returns a reason string to refuse, or null) ---

// Budget pooling (report failure mode a): a multi-objective fan-out multiplies spend, so a global budget
// is mandatory. The per-unit cap (below) bounds each objective; this bounds the pool.
export function convergeNeedsGlobalBudget(cfg) {
  const m = cfg.manifest
  if ((m.objectives?.length ?? 0) >= 2 && m.global_budget_usd == null && m.global_budget_tokens == null)
    return 'a manifest with >=2 objectives requires a global budget — set global_budget_usd and/or global_budget_tokens (fan-out across objectives multiplies spend)'
  return null
}

// A per-unit cap is mandatory because budgets are checked POST-pass (loop.mjs) — without a cap an objective
// could overshoot. Each objective must resolve a cap (its own, or the manifest objective_cap default).
export function convergeObjectivesNeedCap(cfg) {
  const m = cfg.manifest
  for (const o of m.objectives ?? [])
    if (o.cap == null && m.objective_cap == null)
      return `objective ${o.id} has no cap and the manifest sets no objective_cap default — a per-unit cap is mandatory (budgets are post-pass)`
  return null
}

// editScopes must be pairwise DISJOINT (DCA refinement #3): without this, "A edits B's source" is possible
// (two overlapping scopes), and the positive-allowlist isolation claim is unsound. A declared shared-source
// overlap is a later (sharedSource) track.
export function convergeEditScopeOverlap(cfg) {
  const objs = cfg.manifest.objectives ?? []
  for (let i = 0; i < objs.length; i++)
    for (let j = i + 1; j < objs.length; j++)
      if (objs[i].editScope != null && objs[j].editScope != null && pathsIntersect(objs[i].editScope, objs[j].editScope))
        return `objectives ${objs[i].id} and ${objs[j].id} have overlapping editScopes (${objs[i].editScope} <-> ${objs[j].editScope}) — editScopes must be pairwise disjoint (overlap lets one objective edit another's source)`
  return null
}

// A judge-class objective enters global MET only via its HELD-OUT confirm (the primary is gameable), so a
// judge objective without a confirmScorer cannot enter met safely — refuse it.
export function convergeJudgeObjectiveNeedsConfirm(cfg) {
  for (const o of cfg.manifest.objectives ?? [])
    if (isJudgeClass(o) && !o.confirmScorer)
      return `objective ${o.id} is judge-class (model-based scorer) but declares no confirmScorer — a judge objective's global met-entry requires a held-out confirm (the primary is gameable)`
  return null
}

// The manifest is the operator-owned meta-gate; a manifest UNDER --scope would be in the editor's blast
// radius and model-editable. Refuse it (mirrors forgeStoreInsideScope).
export function manifestInsideScope(cfg) {
  if (!cfg.scope || !cfg.objectivesPath) return null
  const base = resolve(cfg.scope)
  const mp = resolve(cfg.objectivesPath)
  if (mp === base || mp.startsWith(base + sep))
    return '--objectives manifest must be OUTSIDE --scope (the editor blast radius) — it is the operator-owned meta-gate and must not be model-editable'
  return null
}

// An objective scorer must not be a command-executing scorer (composite/floor) — a model-reachable path
// into one would hit a shell. Reuses the shared scorer-safety denylist (normalize + realpath).
export function convergeUnsafeObjectiveScorer(cfg) {
  for (const o of cfg.manifest?.objectives ?? [])
    for (const [label, cmd] of [['scorer', o.scorer], ['confirmScorer', o.confirmScorer]]) {
      if (!cmd) continue
      for (const t of scriptTokens(cmd))
        if (isUnsafeScorer(t, SUBGATE_UNSAFE, SUBGATE_UNSAFE_PATHS))
          return `objective ${o.id} ${label} resolves to a command-executing scorer (composite/floor) — not allowed as an objective scorer (a model-chosen --cmd would reach a shell)`
    }
  return null
}

// Gate/measurement files (scorer scripts, floor footprint, declared read-only paths) must lie OUTSIDE every
// editScope (DCA refinement #2/#3): this is how the floor-footprint protection is delivered — package.json/
// jest.config in floor.readOnly can never sit inside an editScope, so an editor cannot rewrite what the
// floor measures. Footprint COMPLETENESS stays the operator's contract (disclosed in the report).
export function manifestEditScopeReadOnlyCollision(cfg) {
  const ro = globalReadOnly(cfg.manifest, cfg.scope ?? '.')
  for (const o of cfg.manifest?.objectives ?? []) {
    if (o.editScope == null) continue
    for (const r of ro)
      if (pathsIntersect(o.editScope, r))
        return `objective ${o.id} editScope (${o.editScope}) intersects a measurement/gate file (${r}) — gate files (scorer scripts, floor footprint, read-only paths) must lie OUTSIDE every editScope`
  }
  return null
}

export const CONVERGE_REFUSALS = [
  convergeNeedsGlobalBudget,
  convergeObjectivesNeedCap,
  convergeEditScopeOverlap,
  convergeJudgeObjectiveNeedsConfirm,
  manifestInsideScope,
  convergeUnsafeObjectiveScorer,
  manifestEditScopeReadOnlyCollision,
]

// The full refuse-to-start check: structural validation first (the manifest must be well-formed before any
// semantic guard reads it), then each safety guard. Returns the FIRST reason, or null to proceed.
export function convergeRefusal(cfg) {
  const errs = validateManifest(cfg.manifest)
  if (errs.length) return `invalid manifest: ${errs.join('; ')}`
  for (const g of CONVERGE_REFUSALS) {
    const r = g(cfg)
    if (r) return r
  }
  return null
}

// --- CLI input parsing (the orchestrator wiring lands with runConverge in a later step) ---

export function loadManifest(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`cannot read --objectives manifest at ${path}: ${e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`malformed --objectives manifest at ${path}: ${e.message}`)
  }
}

export function parseConvergeCli(argv, defaults = {}) {
  const get = (n, d) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  const num = (n, d) => (get(n) != null ? Number(get(n)) : d)
  return {
    scope: get('--scope'),
    objectivesPath: get('--objectives'),
    convergeDir: get('--converge-dir', `.converge/run_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`),
    globalBudgetUsd: num('--global-budget', defaults.globalBudgetUsd),
    globalBudgetTokens: num('--global-budget-tokens', defaults.globalBudgetTokens),
    globalCap: num('--global-cap', defaults.globalCap ?? 20),
    globalPlateauWindow: num('--global-plateau-window', defaults.globalPlateauWindow ?? 3),
    globalMinProgress: num('--global-min-progress', defaults.globalMinProgress ?? 1),
    globalStabilityRuns: num('--global-stability-runs', defaults.globalStabilityRuns ?? 2),
    objectiveRetries: num('--objective-retries', defaults.objectiveRetries ?? 1),
    minDelta: num('--min-delta', defaults.minDelta ?? 1),
    model: get('--model', defaults.model ?? 'sonnet'),
    effort: get('--effort', defaults.effort ?? 'medium'),
    escalateModel: get('--model-escalate', defaults.escalateModel ?? 'opus'),
    noEscalate: argv.includes('--no-escalate'),
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    resume: argv.includes('--resume'),
  }
}
