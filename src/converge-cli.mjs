// whetstone-converge entry: drives N per-objective scope runs under ONE code-owned global gate
// (src/converge-gate.mjs globalVerdict). This file owns the operator-facing INPUT contract — loading and
// validating the objectives manifest and the refuse-to-start safety suite — mirroring scope-cli's
// guard-suite-then-run shape. The orchestrator (runConverge, src/converge.mjs) is wired in a later step.
//
// The manifest is the META-GATE: operator-authored, lives OUTSIDE --scope, never model-editable. Every
// unsafe shape is REFUSED at start (exit 2), never silently coerced — the gate's integrity starts here.
import { readFileSync, openSync, writeSync, closeSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isUnsafeScorer } from './scorer-safety.mjs'
// Path/footprint helpers live in a leaf module so converge / converge-cli / converge-state do not import
// each other in a cycle (which would deadlock the CLI entry's top-level await). Re-exported here so existing
// consumers/tests can keep importing them from converge-cli.
import { pathsIntersect, scriptTokens, isJudgeClass, globalReadOnly } from './converge-shared.mjs'
export { pathsIntersect, isJudgeClass, globalReadOnly } from './converge-shared.mjs'

const SCORERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')
// A command-executing scorer (composite/floor: its contract is "run my --cmd/--scorers argument" via a
// shell) must never be an objective scorer — the operator names the scorer cmd, but a finding/model path
// into it would reach a shell. Same denylist + shared canonicalization as scope-cli/the Forge.
const SUBGATE_UNSAFE = new Set(['composite', 'floor'])
const SUBGATE_UNSAFE_PATHS = [join(SCORERS_DIR, 'composite.mjs'), join(SCORERS_DIR, 'floor.mjs')]

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

// Inc 1 tournament: --candidates must be a positive integer (1 = no tournament). The winner's-curse antidote
// (selecting on the held-out truth rather than the gameable visible) needs a held-out signal to bite; that is
// already guaranteed for judge objectives by convergeJudgeObjectiveNeedsConfirm. Deterministic objectives have
// no soft gate to overfit, so a deterministic tournament is a safe visible-max — no extra requirement.
export function convergeCandidatesValid(cfg) {
  const k = cfg.candidates
  if (k == null) return null
  if (!Number.isInteger(k) || k < 1) return `--candidates must be a positive integer (got ${k}); 1 = no tournament`
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

// The floor's measurement footprint must be DECLARED read-only (DCA refinement #2 — the headline
// `npm test -> echo ok` floor-evasion path). We cannot enumerate what an arbitrary `floor.cmd` reads, so we
// enforce the operator CONTRACT: a floor with a command MUST declare a non-empty floor.readOnly listing the
// config/script files it depends on (package.json, jest.config.js, Makefile, conftest.py, ...). Those then
// join globalReadOnly and — via manifestEditScopeReadOnlyCollision — are forced outside every editScope, so
// an editor can never rewrite what the floor measures. (Completeness of that list stays the operator's
// responsibility, disclosed in the report; this guard makes the omission itself impossible.)
export function convergeFloorFootprintReadOnly(cfg) {
  const f = cfg.manifest?.floor
  if (!f?.cmd) return null // a missing floor.cmd is caught by validateManifest
  if (!Array.isArray(f.readOnly) || f.readOnly.length === 0)
    return 'floor.readOnly must be a non-empty array — declare every config/script file the floor cmd reads (e.g. package.json, jest.config.js, Makefile) so an editor cannot rewrite what the floor measures'
  return null
}

// Inc 3a: the operator-authored GLOBAL held-out truth gate. Each check must be well-formed AND its scorer SCRIPT
// must lie OUTSIDE every editScope (the editor must not be able to weaken/rewrite the truth it is judged against)
// AND must not be a command-executing scorer (composite/floor). Absent global_held_out -> null (opt-in).
export function convergeHeldOutTruthGuards(cfg) {
  const gho = cfg.manifest?.global_held_out
  if (gho == null) return null
  if (!Array.isArray(gho)) return 'global_held_out must be an array of {id, scorer, target}'
  const editScopes = (cfg.manifest?.objectives ?? []).map((o) => o.editScope).filter(Boolean)
  const ids = new Set()
  for (const c of gho) {
    if (typeof c.id !== 'string' || !c.id.trim()) return 'each global_held_out check requires a non-empty id'
    if (ids.has(c.id)) return `duplicate global_held_out id: ${c.id} (each held-out check needs a unique id — applyGlobalHeldOut maps by id)`
    ids.add(c.id)
    if (typeof c.scorer !== 'string' || !c.scorer.trim()) return `global held-out ${c.id ?? '?'} requires a scorer command`
    if (typeof c.target !== 'number' || !Number.isFinite(c.target) || c.target < 0 || c.target > 100) return `global held-out ${c.id} target must be a number 0..100`
    for (const t of scriptTokens(c.scorer)) {
      for (const es of editScopes)
        if (pathsIntersect(t, es)) return `global held-out ${c.id} scorer (${t}) is inside editScope ${es} — the held-out truth must lie OUTSIDE every editScope (the editor must not be able to weaken it)`
      if (isUnsafeScorer(t, SUBGATE_UNSAFE, SUBGATE_UNSAFE_PATHS)) return `global held-out ${c.id} scorer resolves to a command-executing scorer (composite/floor) — not allowed`
    }
  }
  return null
}

// Inc 3a: the global held-out truth gate is wired for the SEQUENTIAL path only; --parallel does not yet measure or
// gate on it, so allowing both would silently weaken the gate on the parallel path. Refuse the combination.
export function convergeParallelNoHeldOut(cfg) {
  if (cfg.parallel && (cfg.manifest?.global_held_out?.length ?? 0) > 0)
    return '--parallel is not yet wired for the global held-out truth gate — run sequentially (omit --parallel) when global_held_out is set'
  return null
}

export const CONVERGE_REFUSALS = [
  convergeNeedsGlobalBudget,
  convergeObjectivesNeedCap,
  convergeEditScopeOverlap,
  convergeJudgeObjectiveNeedsConfirm,
  manifestInsideScope,
  convergeUnsafeObjectiveScorer,
  convergeFloorFootprintReadOnly,
  manifestEditScopeReadOnlyCollision,
  convergeCandidatesValid,
  convergeHeldOutTruthGuards,
  convergeParallelNoHeldOut,
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
    // Inc 1 tournament: K independent candidates per objective step; the winner is picked on the held-out truth
    // signal (the winner's-curse antidote). 1 = unchanged single-candidate path.
    candidates: num('--candidates', defaults.candidates ?? 1),
    model: get('--model', defaults.model ?? 'sonnet'),
    effort: get('--effort', defaults.effort ?? 'medium'),
    escalateModel: get('--model-escalate', defaults.escalateModel ?? 'opus'),
    // undefined (not false) when the flag is absent, so buildObjectiveCfg's `cfg.noEscalate ?? true` default
    // applies: a converge child is its own objective unit and must not do a second opus escalation (matches
    // decompose, and the outer-cli path which omits the key). A literal `false` here defeated that default.
    noEscalate: argv.includes('--no-escalate') || undefined,
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    resume: argv.includes('--resume'),
    // Track B: BATCHED fan-out under the IDENTICAL gate — N disjoint objectives in ONE merged gated round (one
    // gate re-measure) vs sequential's N rounds. Sequential stays the DEFAULT; --parallel selects it. The gate
    // path is the same across both backends (runConvergeParallel reuses the verbatim gate). NOTE: editor
    // execution is SERIAL today (blocking spawnSync) — the win is fewer gate re-measures, not wall-clock speedup.
    parallel: argv.includes('--parallel'),
    maxParallel: num('--max-parallel', defaults.maxParallel ?? 2),
    maxBatchRegressions: num('--max-batch-regressions', defaults.maxBatchRegressions ?? 2),
    flakeCap: num('--flake-cap', defaults.flakeCap ?? 3),
  }
}

// A per-run ADVISORY lock (spec §5): two `whetstone-converge` invocations on the same convergeDir must REFUSE
// rather than double-write the ledger. O_EXCL ('wx') is the atomic create-or-fail. A crashed run leaves a
// STALE lock; rather than block resume forever, we read the recorded pid and STEAL the lock only when its
// owner is dead (process.kill(pid,0) → ESRCH). A live owner → refuse. Returns a release() that unlinks it.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } // EPERM = alive, not ours
}

export function acquireRunLock(convergeDir) {
  mkdirSync(convergeDir, { recursive: true })
  const lockPath = join(convergeDir, 'converge.lock')
  const claim = () => { const fd = openSync(lockPath, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd) }
  try {
    claim()
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    let owner = null
    try { owner = Number(readFileSync(lockPath, 'utf8').trim()) } catch { /* unreadable -> treat as stale */ }
    if (pidAlive(owner)) throw new Error(`another converge run holds ${lockPath} (pid ${owner}) — refusing to double-write this scope`)
    try { unlinkSync(lockPath) } catch { /* raced away */ }
    claim()
  }
  return () => { try { unlinkSync(lockPath) } catch { /* already gone */ } }
}

// --- CLI entry. Dynamic imports of converge.mjs / scope-cli.mjs / driver.mjs keep this file's TOP-LEVEL
// imports cycle-free (converge.mjs statically imports THIS module). The per-objective child IS the
// unmodified scope loop: runFromConfig(childCfg, scopeDeps(childCfg)) — the same seam decompose uses.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv
  const cfg = parseConvergeCli(argv)
  if (!cfg.scope || !cfg.objectivesPath) {
    process.stderr.write('usage: converge-cli.mjs --scope <repo dir> --objectives <manifest.json OUTSIDE the scope> [--converge-dir <dir>] [--global-budget-tokens N | --global-budget X] [--global-cap 20] [--global-stability-runs 2] [--objective-retries 1] [--candidates 1] [--parallel [--max-parallel 2] [--max-batch-regressions 2] [--flake-cap 3]] [--model sonnet] [--effort medium] [--no-escalate] [--mcp-config <path>]\n  resume: converge-cli.mjs --scope <dir> --objectives <manifest> --converge-dir <existing run dir> --resume [--parallel]\n')
    process.exit(2)
  }
  const { cleanTreeGuard, scopeDeps } = await import('./scope-cli.mjs')
  const { runFromConfig } = await import('./driver.mjs')
  const { runConverge, prepareGlobalResume } = await import('./converge.mjs')
  // The parallel backend lives in converge-parallel.mjs; loaded only when --parallel selects it (the gate path
  // is identical — runConvergeParallel reuses the verbatim reMeasureAll/globalVerdict).
  const { runConvergeParallel, prepareGlobalResumeParallel } = await import('./converge-parallel.mjs')

  const guard = cleanTreeGuard(cfg.scope)
  if (!guard.ok) {
    process.stderr.write(`refusing to start: ${guard.reason}\n`)
    process.exit(2)
  }
  // The objectives manifest is the meta-gate; it must live OUTSIDE the scope (checked here AND by the
  // refusal suite) so the editor cannot rewrite it.
  const runChild = (childCfg) => runFromConfig(childCfg, scopeDeps(childCfg))

  // A FRESH run validates the manifest BEFORE taking the lock (refuse fast, no lock churn); a resume reads the
  // ledger instead. Then a per-run advisory lock guards the convergeDir against a concurrent second invocation.
  let manifest = null
  if (!cfg.resume) {
    manifest = loadManifest(cfg.objectivesPath)
    const reason = convergeRefusal({ scope: cfg.scope, objectivesPath: cfg.objectivesPath, manifest, candidates: cfg.candidates, parallel: cfg.parallel })
    if (reason) {
      process.stderr.write(`refusing to start: ${reason}\n`)
      process.exit(2)
    }
  }

  let release
  try {
    release = acquireRunLock(cfg.convergeDir)
  } catch (e) {
    process.stderr.write(`refusing to start: ${e.message}\n`)
    process.exit(2)
  }

  let code = 2
  try {
    let result
    if (cfg.resume) {
      result = cfg.parallel ? await prepareGlobalResumeParallel(cfg, { runChild }) : await prepareGlobalResume(cfg, { runChild })
    } else {
      result = cfg.parallel ? await runConvergeParallel(cfg, manifest, { runChild }) : await runConverge(cfg, manifest, { runChild })
    }
    process.stdout.write(`\n${result.verdict.reason}\n`)
    code = result.verdict.status === 'done' ? 0 : 1
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    code = 2
  } finally {
    release() // process.exit() skips finally of the caller, so release BEFORE exiting
  }
  process.exit(code)
}
