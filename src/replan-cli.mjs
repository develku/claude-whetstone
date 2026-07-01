#!/usr/bin/env node
// whetstone-replan entry (Inc 3b): on a STALLED converge run, regenerate a DIFFERENT decomposition and write it
// as a PROPOSAL for human review — the immutable global held-out truth is carried verbatim, and this NEVER runs
// converge (acceptance is the human re-running whetstone-converge on the proposal). Mirrors plan-cli's shape; the
// proposer is a fenced operator, not a privileged path. Not a package bin (alpha, like converge/plan).
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve, sep, dirname, basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isMainModule } from './is-main.mjs'
import { planManifest as realPlanManifest } from './plan.mjs'
import { proposeReplan, replanTruthPreserved } from './replan.mjs'
import { loadPlanAllowlist } from './plan-allowlist.mjs'
import { realPlanCall } from './plan-call.mjs'
import { convergeRefusal, loadManifest } from './converge-cli.mjs'
import { loadConvergeState } from './converge-state.mjs'
import { formatSpend } from './spend-format.mjs'

export function parseReplanCli(argv, defaults = {}) {
  const get = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const num = (n, d) => (get(n) != null ? Number(get(n)) : d)
  const list = (n) => (get(n) || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    scope: get('--scope'),
    objectives: get('--objectives'), // the PRIOR (stalled) manifest
    out: get('--out'), // the proposed re-decomposition (OUTSIDE scope)
    convergeDir: get('--converge-dir'), // a stalled run dir — its converge-state.json carries structural_signal
    signal: get('--signal'), // explicit override of the structural signal
    signalDetail: get('--signal-detail', ''),
    scorerAllow: list('--scorer-allow'),
    minTarget: num('--min-target', defaults.minTarget ?? 70),
    maxObjectives: num('--max-objectives', defaults.maxObjectives ?? 12),
    plannerModel: get('--planner-model', defaults.plannerModel ?? 'opus'),
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    testDirs: get('--test-dirs') != null ? list('--test-dirs') : ['test', 'tests'],
  }
}

// The proposed manifest is the operator-owned meta-gate; a path UNDER --scope is model-editable. Refuse it.
export function replanOutInsideScope(cfg) {
  if (!cfg.scope || !cfg.out) return null
  const base = resolve(cfg.scope)
  const out = resolve(cfg.out)
  if (out === base || out.startsWith(base + sep))
    return '--out manifest must be OUTSIDE --scope (the editor blast radius) — it is the operator-owned meta-gate and must not be model-editable'
  return null
}

function gitLsFiles(scope) {
  const r = spawnSync('git', ['ls-files'], { cwd: scope, encoding: 'utf8' })
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
}
function buildRepoContext(scope, repoFiles) {
  let readme = ''
  for (const name of ['README.md', 'README', 'readme.md']) {
    try { readme = readFileSync(join(scope, name), 'utf8'); break } catch { /* none */ }
  }
  return `Repository files:\n${repoFiles.join('\n')}\n\nREADME:\n${readme}`
}
const sidecarReportPath = (out) => join(dirname(out), basename(out).replace(/\.json$/, '') + '.replan-report.json')

// runReplanCli(cfg, deps) -> exit code. deps inject planManifest / planCall / lsFiles / readState / log / errlog
// for $0 tests. NEVER runs converge — the proposal awaits human acceptance.
export async function runReplanCli(cfg, deps = {}) {
  const {
    planManifest = realPlanManifest, planCall = realPlanCall, lsFiles = gitLsFiles,
    readState = (dir) => loadConvergeState(dir),
    log = (s) => process.stdout.write(s + '\n'), errlog = (s) => process.stderr.write(s + '\n'),
  } = deps

  if (!cfg.scope || !cfg.objectives || !cfg.out) {
    errlog('usage: whetstone-replan --scope <repo dir> --objectives <PRIOR manifest> --out <proposal.json OUTSIDE scope> (--converge-dir <stalled run> | --signal <impossibility|contradiction|held_out_fail|plateau>) [--scorer-allow <paths>] [--planner-model opus] [--min-target 70] [--max-objectives 12]')
    return 2
  }
  const outReason = replanOutInsideScope(cfg)
  if (outReason) { errlog(`refusing to start: ${outReason}`); return 2 }

  let prior
  try { prior = loadManifest(cfg.objectives) } catch (e) { errlog(e.message); return 2 }

  let signal = cfg.signal
  if (!signal && cfg.convergeDir) { try { signal = readState(cfg.convergeDir)?.structural_signal } catch { /* unreadable */ } }
  if (!signal) { errlog('a structural signal is required: pass --signal <…> or --converge-dir <stalled run dir whose converge-state.json carries structural_signal>'); return 2 }
  // The detector emits a CLOSED set; an out-of-set value means a corrupt/tampered converge-state (the fence would
  // still contain it as DATA, but refusing is cleaner than re-decomposing off a garbage signal).
  const KNOWN_SIGNALS = new Set(['impossibility', 'contradiction', 'held_out_fail', 'plateau'])
  if (!KNOWN_SIGNALS.has(signal)) { errlog(`unrecognized structural signal '${signal}' (expected one of: ${[...KNOWN_SIGNALS].join(', ')}) — refusing to build a replan from a corrupt/tampered signal`); return 2 }

  const allowlist = loadPlanAllowlist(cfg.scorerAllow)
  const repoFiles = lsFiles(cfg.scope)
  const repoContext = buildRepoContext(cfg.scope, repoFiles)

  let result
  try {
    result = await proposeReplan(
      { priorManifest: prior, scopeDir: cfg.scope, structuralSignal: signal, signalDetail: cfg.signalDetail, repoContext, testDirs: cfg.testDirs, objectivesPath: cfg.out, minTarget: cfg.minTarget, maxObjectives: cfg.maxObjectives },
      { planManifest, planCall: (prompt, o) => planCall(prompt, { model: cfg.plannerModel, mcpConfig: cfg.mcpConfig, ...o }), allowlist, repoFiles },
    )
  } catch (e) {
    errlog(`replan refused (exit ${e.exitCode ?? 2}): ${e.message}`)
    if (e.planRejected) errlog(`rejected proposals: ${JSON.stringify(e.planRejected)}`)
    return e.exitCode ?? 2
  }

  writeFileSync(cfg.out, JSON.stringify(result.manifest, null, 2))
  const reportPath = sidecarReportPath(cfg.out)
  writeFileSync(reportPath, JSON.stringify(result.report, null, 2))
  const fromDisk = loadManifest(cfg.out)
  const diskReason = convergeRefusal({ scope: cfg.scope, objectivesPath: cfg.out, manifest: fromDisk })
  if (diskReason) {
    for (const p of [cfg.out, reportPath]) { try { unlinkSync(p) } catch { /* gone */ } }
    errlog(`the written proposal failed convergeRefusal from disk (removed): ${diskReason}`)
    return 2
  }
  // Chain of custody: the truth bar on disk must still match what was assembled (round-trip cannot weaken it).
  if (!replanTruthPreserved(result.manifest, fromDisk)) {
    for (const p of [cfg.out, reportPath]) { try { unlinkSync(p) } catch { /* gone */ } }
    errlog('the written proposal does not preserve the global held-out truth on disk (removed)')
    return 2
  }

  log(`REPLAN PROPOSAL written: ${cfg.out} (signal: ${signal})`)
  log(`report: ${reportPath}`)
  log(`planner spend: ${formatSpend({ tokens: result.spentTokens, costUsd: result.spentUsd })}`)
  log('HUMAN REVIEW REQUIRED — the proposal was NOT applied (the global held-out truth is carried verbatim). To ACCEPT, run:')
  log(`  whetstone-converge --scope ${cfg.scope} --objectives ${cfg.out}`)
  log('GATE-DID-NOT-PROVE — read these residuals before trusting the run:')
  for (const d of result.report.disclosures ?? []) log(`  - ${d}`)
  return 0
}

if (isMainModule(import.meta.url)) {
  const code = await runReplanCli(parseReplanCli(process.argv))
  process.exit(code)
}
