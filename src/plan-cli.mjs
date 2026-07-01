#!/usr/bin/env node
// whetstone-plan entry (spec §8): goal + repo + an operator scorer allowlist -> a generated objective
// manifest written OUTSIDE the scope + a sidecar report -> optional --and-converge (default OFF). The
// planner is a fenced OPERATOR: it produces an INPUT for the verbatim runConverge, never reasons about
// the gate. converge-cli.mjs stays byte-untouched (a SEPARATE entry). The manifest must live OUTSIDE
// --scope (the operator-owned meta-gate, model-uneditable) — refused at start AND re-validated from disk.
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve, sep, dirname, basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isMainModule } from './is-main.mjs'
import { planManifest } from './plan.mjs'
import { loadPlanAllowlist } from './plan-allowlist.mjs'
import { realPlanCall } from './plan-call.mjs'
import { convergeRefusal, loadManifest } from './converge-cli.mjs'
import { formatSpend } from './spend-format.mjs'

export function parsePlanCli(argv, defaults = {}) {
  const get = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const num = (n, d) => (get(n) != null ? Number(get(n)) : d)
  const list = (n) => (get(n) || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    goal: get('--goal'),
    scope: get('--scope'),
    out: get('--out'),
    scorerAllow: list('--scorer-allow'),
    floorCmd: get('--floor-cmd'),
    floorReadOnly: list('--floor-read-only'),
    globalBudgetUsd: num('--global-budget', defaults.globalBudgetUsd),
    globalBudgetTokens: num('--global-budget-tokens', defaults.globalBudgetTokens),
    objectiveCap: num('--objective-cap', defaults.objectiveCap ?? 6),
    minTarget: num('--min-target', defaults.minTarget ?? 70),
    maxObjectives: num('--max-objectives', defaults.maxObjectives ?? 12),
    plannerModel: get('--planner-model', defaults.plannerModel ?? 'opus'),
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    testDirs: get('--test-dirs') != null ? list('--test-dirs') : ['test', 'tests'],
    andConverge: argv.includes('--and-converge'),
    parallel: argv.includes('--parallel'),
  }
}

// The manifest is the operator-owned meta-gate; a manifest UNDER --scope is in the editor blast radius and
// model-editable. Refuse it (mirrors converge-cli.manifestInsideScope / forgeStoreInsideScope).
export function planOutInsideScope(cfg) {
  if (!cfg.scope || !cfg.out) return null
  const base = resolve(cfg.scope)
  const out = resolve(cfg.out)
  if (out === base || out.startsWith(base + sep))
    return '--out manifest must be OUTSIDE --scope (the editor blast radius) — it is the operator-owned meta-gate and must not be model-editable'
  return null
}

// git ls-files for the scope (the editable-surface denominator + the planner repo context). Default seam.
function gitLsFiles(scope) {
  const r = spawnSync('git', ['ls-files'], { cwd: scope, encoding: 'utf8' })
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
}

// The repo context fed (as FENCED data) to the planner: the file list + the README if one exists.
function buildRepoContext(scope, repoFiles) {
  let readme = ''
  for (const name of ['README.md', 'README', 'readme.md']) {
    try { readme = readFileSync(join(scope, name), 'utf8'); break } catch { /* none */ }
  }
  return `Repository files:\n${repoFiles.join('\n')}\n\nREADME:\n${readme}`
}

const sidecarReportPath = (out) => join(dirname(out), basename(out).replace(/\.json$/, '') + '.plan-report.json')

// runPlanCli(cfg, deps) -> exit code. deps: { planCall, lsFiles, converge, log, errlog } (all injected for
// $0 tests). converge is called ONLY when --and-converge is set (default OFF).
export async function runPlanCli(cfg, deps = {}) {
  const {
    planCall = realPlanCall, lsFiles = gitLsFiles, converge = null,
    log = (s) => process.stdout.write(s + '\n'), errlog = (s) => process.stderr.write(s + '\n'),
  } = deps

  if (!cfg.goal || !cfg.scope || !cfg.out || !cfg.floorCmd) {
    errlog('usage: whetstone-plan --goal "<g>" --scope <repo dir> --out <manifest.json OUTSIDE scope> --floor-cmd "<cmd>" --floor-read-only <files> [--scorer-allow <paths OUTSIDE scope>] [--global-budget-tokens N] [--objective-cap 6] [--min-target 70] [--max-objectives 12] [--planner-model opus] [--and-converge [--parallel]]')
    return 2
  }
  const outReason = planOutInsideScope(cfg)
  if (outReason) { errlog(`refusing to start: ${outReason}`); return 2 }
  if (!cfg.floorReadOnly.length) {
    errlog('refusing to start: --floor-read-only is required (the floor footprint files must be declared so an editor cannot rewrite what the floor measures)')
    return 2
  }

  const allowlist = loadPlanAllowlist(cfg.scorerAllow)
  const repoFiles = lsFiles(cfg.scope)
  const repoContext = buildRepoContext(cfg.scope, repoFiles)
  const planCfg = {
    goal: cfg.goal,
    scopeDir: cfg.scope,
    floor: { cmd: cfg.floorCmd, readOnly: cfg.floorReadOnly },
    objectiveCap: cfg.objectiveCap,
    globalBudgetUsd: cfg.globalBudgetUsd,
    globalBudgetTokens: cfg.globalBudgetTokens,
    repoContext,
    testDirs: cfg.testDirs,
    objectivesPath: cfg.out,
    minTarget: cfg.minTarget,
    maxObjectives: cfg.maxObjectives,
  }

  let result
  try {
    result = await planManifest(planCfg, {
      allowlist,
      repoFiles,
      planCall: (prompt, o) => planCall(prompt, { model: cfg.plannerModel, mcpConfig: cfg.mcpConfig, ...o }),
    })
  } catch (e) {
    errlog(`planner refused (exit ${e.exitCode ?? 2}): ${e.message}`)
    if (e.planRejected) errlog(`rejected proposals: ${JSON.stringify(e.planRejected)}`)
    return e.exitCode ?? 2
  }

  // Write the manifest OUTSIDE scope + the sidecar report, then RE-VALIDATE from disk (defense in depth:
  // the planner validated in-memory; convergence consumes the on-disk file).
  writeFileSync(cfg.out, JSON.stringify(result.manifest, null, 2))
  const reportPath = sidecarReportPath(cfg.out)
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2))
  const fromDisk = loadManifest(cfg.out)
  const diskReason = convergeRefusal({ scope: cfg.scope, objectivesPath: cfg.out, manifest: fromDisk })
  if (diskReason) {
    // A disk re-validation failure (e.g. a JSON-serialization artifact the in-memory pass missed) leaves a
    // refused manifest on disk; remove it so no stale/unrunnable manifest is left for the operator (M5).
    for (const p of [cfg.out, reportPath]) { try { unlinkSync(p) } catch { /* already gone */ } }
    errlog(`the written manifest failed convergeRefusal from disk (removed): ${diskReason}`)
    return 2
  }

  log(`manifest written: ${cfg.out}`)
  log(`report: ${reportPath}`)
  log(`coverage_score: ${result.report.coverage_score}/100 over ${result.report.editable_surface_size} editable files (objectives_sufficiency: ${result.report.objectives_sufficiency})`)
  log(`planner spend: ${formatSpend({ tokens: result.spentTokens, costUsd: result.spentUsd })}`)
  log('GATE-DID-NOT-PROVE — read these residuals before trusting the run:')
  for (const d of result.report.disclosures) log(`  - ${d}`)

  if (!cfg.andConverge) {
    log('manifest written (--and-converge OFF). Run whetstone-converge to converge, or re-run with --and-converge.')
    return 0
  }
  if (!converge) { errlog('--and-converge requested but no converge backend wired'); return 2 }
  // thread the report-only coverage_score into the converge cfg so the durable ledger records it (inc 0;
  // the gate never reads it). The backend also threads objectives_source='planner'.
  cfg.coverageScore = result.report.coverage_score
  const { verdict } = await converge(cfg, fromDisk)
  log(verdict.reason)
  return verdict.status === 'done' ? 0 : 1
}

// --and-converge backend: reuse converge-cli's exact tail (cleanTreeGuard -> lock -> runConverge[Parallel]).
// Dynamic imports keep this entry's static graph free of converge.mjs's CLI cycle (mirrors converge-cli).
async function convergeBackend(cfg, manifest) {
  const { cleanTreeGuard, scopeDeps } = await import('./scope-cli.mjs')
  const { runFromConfig } = await import('./driver.mjs')
  const { runConverge } = await import('./converge.mjs')
  const { runConvergeParallel } = await import('./converge-parallel.mjs')
  const { acquireRunLock } = await import('./converge-cli.mjs')
  const guard = cleanTreeGuard(cfg.scope)
  if (!guard.ok) throw new Error(`refusing to converge: ${guard.reason}`)
  const convergeDir = join(dirname(cfg.out), `.converge_${basename(cfg.out).replace(/\.json$/, '')}`)
  const runChild = (childCfg) => runFromConfig(childCfg, scopeDeps(childCfg))
  const convCfg = {
    scope: cfg.scope, objectivesPath: cfg.out, convergeDir,
    globalBudgetUsd: cfg.globalBudgetUsd, globalBudgetTokens: cfg.globalBudgetTokens, globalCap: 20,
    objectivesSource: 'planner', // inc-0 provenance thread: a planner-driven run records the honest source
    coverageScore: cfg.coverageScore ?? null, // report-only span recorded in the ledger (gate never reads it)
    parallel: cfg.parallel,
  }
  const release = acquireRunLock(convergeDir)
  try {
    return cfg.parallel
      ? await runConvergeParallel(convCfg, manifest, { runChild })
      : await runConverge(convCfg, manifest, { runChild })
  } finally {
    release()
  }
}

if (isMainModule(import.meta.url)) {
  const cfg = parsePlanCli(process.argv)
  const code = await runPlanCli(cfg, { converge: convergeBackend })
  process.exit(code)
}
