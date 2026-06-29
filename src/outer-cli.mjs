#!/usr/bin/env node
// whetstone-outer (capstone CLI): run the INNER converge; on a replan-WORTHY stall (decomposition insufficient),
// emit a re-decomposition PROPOSAL for human review. NEVER auto-applies the proposal — acceptance is the human
// re-running whetstone-converge on it. Composes the verbatim converge backend + the Inc 3b proposer via
// runOuterLoop. Not a package bin (alpha, like converge/plan/replan).
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runOuterLoop } from './outer.mjs'
import { planManifest } from './plan.mjs'
import { proposeReplan } from './replan.mjs'
import { loadPlanAllowlist } from './plan-allowlist.mjs'
import { realPlanCall } from './plan-call.mjs'
import { loadManifest } from './converge-cli.mjs'
import { formatSpend } from './spend-format.mjs'

export function parseOuterCli(argv, defaults = {}) {
  const get = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const num = (n, d) => (get(n) != null ? Number(get(n)) : d)
  const list = (n) => (get(n) || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    scope: get('--scope'),
    objectives: get('--objectives'), // the manifest for the inner converge
    proposalOut: get('--propose-out'), // where a replan proposal is written (OUTSIDE scope)
    convergeDir: get('--converge-dir', `.converge/run_${defaults.stamp ?? 'outer'}`),
    proposeOnStall: !argv.includes('--no-propose'), // default ON: surface a proposal on a worthy stall
    globalBudgetUsd: num('--global-budget', defaults.globalBudgetUsd),
    globalBudgetTokens: num('--global-budget-tokens', defaults.globalBudgetTokens),
    scorerAllow: list('--scorer-allow'),
    minTarget: num('--min-target', defaults.minTarget ?? 70),
    maxObjectives: num('--max-objectives', defaults.maxObjectives ?? 12),
    plannerModel: get('--planner-model', defaults.plannerModel ?? 'opus'),
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    testDirs: get('--test-dirs') != null ? list('--test-dirs') : ['test', 'tests'],
  }
}

// The proposal path is the operator-owned meta-gate; a path UNDER --scope is model-editable. Refuse it.
export function outerProposalOutsideScope(cfg) {
  if (!cfg.scope || !cfg.proposalOut) return null
  const base = resolve(cfg.scope)
  const out = resolve(cfg.proposalOut)
  if (out === base || out.startsWith(base + sep))
    return '--propose-out must be OUTSIDE --scope (the editor blast radius) — it is the operator-owned meta-gate'
  return null
}

function gitLsFiles(scope) {
  const r = spawnSync('git', ['ls-files'], { cwd: scope, encoding: 'utf8' })
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
}
function buildRepoContext(scope, repoFiles) {
  let readme = ''
  for (const name of ['README.md', 'README', 'readme.md']) { try { readme = readFileSync(join(scope, name), 'utf8'); break } catch { /* none */ } }
  return `Repository files:\n${repoFiles.join('\n')}\n\nREADME:\n${readme}`
}

// the verbatim converge backend (mirrors plan-cli's): dynamic imports keep this entry's static graph cycle-free.
async function convergeBackend(cfg, manifest) {
  const { cleanTreeGuard, scopeDeps } = await import('./scope-cli.mjs')
  const { runFromConfig } = await import('./driver.mjs')
  const { runConverge } = await import('./converge.mjs')
  const { acquireRunLock } = await import('./converge-cli.mjs')
  const guard = cleanTreeGuard(cfg.scope)
  if (!guard.ok) throw new Error(`refusing to converge: ${guard.reason}`)
  const runChild = (childCfg) => runFromConfig(childCfg, scopeDeps(childCfg))
  const convCfg = {
    scope: cfg.scope, objectivesPath: cfg.objectives, convergeDir: cfg.convergeDir,
    globalBudgetUsd: cfg.globalBudgetUsd, globalBudgetTokens: cfg.globalBudgetTokens, globalCap: 20,
  }
  const release = acquireRunLock(cfg.convergeDir)
  try { return await runConverge(convCfg, manifest, { runChild }) } finally { release() }
}

// runOuterCli(cfg, deps) -> exit code. deps inject runConverge / planManifest / planCall / lsFiles / log / errlog
// for $0 tests. The proposal (if any) is WRITTEN; converge is NEVER run on it (human accepts by re-running).
export async function runOuterCli(cfg, deps = {}) {
  const {
    runConverge = convergeBackend, planManifest: plan = planManifest, planCall = realPlanCall, lsFiles = gitLsFiles,
    log = (s) => process.stdout.write(s + '\n'), errlog = (s) => process.stderr.write(s + '\n'),
  } = deps

  if (!cfg.scope || !cfg.objectives) { errlog('usage: whetstone-outer --scope <repo> --objectives <manifest> [--propose-out <proposal.json OUTSIDE scope>] [--no-propose] [--scorer-allow <paths>] [--planner-model opus]'); return 2 }
  if (cfg.proposeOnStall && !cfg.proposalOut) { errlog('--propose-out is required unless --no-propose (a replan proposal must be written OUTSIDE the scope)'); return 2 }
  const outReason = outerProposalOutsideScope(cfg)
  if (outReason) { errlog(`refusing to start: ${outReason}`); return 2 }

  let manifest
  try { manifest = loadManifest(cfg.objectives) } catch (e) { errlog(e.message); return 2 }

  const allowlist = loadPlanAllowlist(cfg.scorerAllow)
  const repoFiles = lsFiles(cfg.scope)
  const r = await runOuterLoop(
    { manifest, scopeDir: cfg.scope, proposeOnStall: cfg.proposeOnStall, proposalOut: cfg.proposalOut, convergeDir: cfg.convergeDir, objectives: cfg.objectives, globalBudgetUsd: cfg.globalBudgetUsd, globalBudgetTokens: cfg.globalBudgetTokens, repoContext: buildRepoContext(cfg.scope, repoFiles), testDirs: cfg.testDirs, minTarget: cfg.minTarget, maxObjectives: cfg.maxObjectives },
    {
      runConverge,
      proposeReplan,
      planManifest: plan,
      planCall: (prompt, o) => planCall(prompt, { model: cfg.plannerModel, mcpConfig: cfg.mcpConfig, ...o }),
      allowlist, repoFiles,
      writeProposal: (path, m) => writeFileSync(path, JSON.stringify(m, null, 2)),
      log,
    },
  )

  log(`inner converge: ${r.verdict.status} — ${r.verdict.reason}`)
  if (r.proposal) {
    log(`spend (replan proposer): ${formatSpend({ tokens: r.proposal.report?.spentTokens ?? 0, costUsd: r.proposal.report?.spentUsd ?? 0 })}`)
    log(`REPLAN PROPOSAL written: ${r.proposal.path}`)
    log('HUMAN REVIEW REQUIRED — NOT applied. To ACCEPT, run:')
    log(`  whetstone-converge --scope ${cfg.scope} --objectives ${r.proposal.path}`)
  } else {
    log(`outer: ${r.reason}`)
  }
  return r.verdict.status === 'done' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = parseOuterCli(process.argv, { stamp: new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) })
  const code = await runOuterCli(cfg)
  process.exit(code)
}
