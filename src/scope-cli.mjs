#!/usr/bin/env node
// whetstone-scope MVP entry: the same code-owned loop as driver.mjs, pointed at a whole repo instead
// of one file. It reuses driver's parseCli, runFromConfig (escalation, confirm-veto, budget, resume,
// validation) and only swaps the four file-bound seams via deps: a git-backed context (scope-context),
// a multi-file editor with the read-only gate guard (scope-act), and git keep-best restore. The scope
// dir is carried in cfg.artifactPath (the "artifact" is the directory).
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runFromConfig, parseCli, loadConfig, editorEffort } from './driver.mjs'
import { scopeBuildContext } from './scope-context.mjs'
import { makeScopeAct } from './scope-act.mjs'
import { gitRestore } from './git-snapshot.mjs'
import { formatReport } from './summary.mjs'

// driver's parseCli plus --scope (becomes the artifact) and --read-only (comma list of gate paths
// the editor may not touch — the tests/scorer it is graded by).
export function parseScopeCli(argv, defaults = {}) {
  const cfg = parseCli(argv, defaults)
  const get = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const scope = get('--scope')
  cfg.scope = scope
  cfg.artifactPath = scope // the scope dir IS the artifact the loop carries
  cfg.readOnly = (get('--read-only') || '').split(',').map((s) => s.trim()).filter(Boolean)
  return cfg
}

// RISK #2 — the loop commits and `git reset --hard`s the scope. Refuse to start unless it is a git repo
// with a CLEAN working tree: an unattended reset on a dirty tree would clobber the operator's
// uncommitted work. Run the loop on a clean checkout or a dedicated branch.
export function cleanTreeGuard(scopeDir) {
  const isRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: scopeDir, encoding: 'utf8' })
  if (isRepo.status !== 0) return { ok: false, reason: `--scope ${scopeDir} is not a git repository` }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: scopeDir, encoding: 'utf8' })
  if ((status.stdout || '').trim().length > 0) {
    return { ok: false, reason: `--scope ${scopeDir} has uncommitted changes — commit or stash them first (the loop runs git reset --hard and would clobber them)` }
  }
  return { ok: true }
}

// Wire the scope I/O seams as runFromConfig deps; everything else (gate, escalation, confirm, budget)
// is the unmodified driver. The escalated editor inherits the read-only guard and steps effort to a
// high floor, mirroring driver's editorEffort.
export function scopeDeps(cfg) {
  const common = { scopeDir: cfg.scope, mcpConfig: cfg.mcpConfig, readOnly: cfg.readOnly }
  const deps = {
    buildContext: scopeBuildContext,
    act: makeScopeAct({ ...common, model: cfg.model, effort: cfg.effort }),
    restore: (sha) => gitRestore(cfg.scope, sha),
  }
  if (!cfg.noEscalate) {
    deps.actEscalated = makeScopeAct({ ...common, model: cfg.escalateModel, effort: editorEffort({ effort: cfg.effort }, true) })
  }
  return deps
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv
  const cfg = parseScopeCli(argv, loadConfig())
  if (!cfg.goal || !cfg.scope || !cfg.scorerCmd) {
    process.stderr.write('usage: scope-cli.mjs "<goal>" --scope <repo dir> --scorer "<project test/build cmd>" [--read-only test/,gate] [--confirm-scorer "<cmd>"] [--target 90] [--cap 10] [--budget X] [--budget-tokens N] [--model sonnet] [--effort medium] [--no-escalate] [--mcp-config <path>] [--loop-dir <dir>]\n')
    process.exit(2)
  }
  const guard = cleanTreeGuard(cfg.scope)
  if (!guard.ok) {
    process.stderr.write(`refusing to start: ${guard.reason}\n`)
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg, scopeDeps(cfg))
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
