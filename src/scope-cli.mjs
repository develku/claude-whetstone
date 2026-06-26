#!/usr/bin/env node
// whetstone-scope MVP entry: the same code-owned loop as driver.mjs, pointed at a whole repo instead
// of one file. It reuses driver's parseCli, runFromConfig (escalation, confirm-veto, budget, resume,
// validation) and only swaps the four file-bound seams via deps: a git-backed context (scope-context),
// a multi-file editor with the read-only gate guard (scope-act), and git keep-best restore. The scope
// dir is carried in cfg.artifactPath (the "artifact" is the directory).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, basename, join, resolve as rpath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { runFromConfig, parseCli, loadConfig, editorEffort } from './driver.mjs'
import { scopeBuildContext } from './scope-context.mjs'
import { makeScopeAct } from './scope-act.mjs'
import { gitRestore } from './git-snapshot.mjs'
import { formatReport } from './summary.mjs'
import { makeDecomposeAct } from './decompose.mjs'
import { isUnsafeScorer } from './scorer-safety.mjs'

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
  cfg.decompose = argv.includes('--decompose')
  cfg.maxChildren = get('--max-children') ? Number(get('--max-children')) : 4
  cfg.childCap = get('--child-cap') ? Number(get('--child-cap')) : 3
  cfg.scorerAllow = (get('--scorer-allow') || '').split(',').map((s) => s.trim()).filter(Boolean)
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

const SCORERS_DIR = rpath(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')

// composite executes raw manifest-file lines via shell:true, so a model-authored decompose finding that
// names it as a sub-gate would reach a shell. It is denied from BOTH the AUTO set and operator --scorer-allow
// extraPaths (the model picks the finding's scorer id; the operator only names paths). test-pass-rate is NOT
// denied here — it is a legitimate child sub-gate (a project test command), unlike in the Forge where the
// model proposes its --cmd. The denylist test (isUnsafeScorer) is normalization-robust + realpath-aware and
// is shared with the Forge denylist (src/forge/hook.mjs) so the two trust boundaries cannot drift.
const SUBGATE_UNSAFE = new Set(['composite'])
const SUBGATE_UNSAFE_PATHS = [join(SCORERS_DIR, 'composite.mjs')]

// The scorer-id allowlist a child sub-gate is resolved against: every shipped scorer (by basename) plus
// any operator-provided path via --scorer-allow. A finding can only ever name an id in this map [CR#4].
export function buildAllowlist(extraPaths = []) {
  const m = new Map()
  for (const f of readdirSync(SCORERS_DIR)) {
    const id = f.replace(/\.mjs$/, '')
    if (f.endsWith('.mjs') && !SUBGATE_UNSAFE.has(id)) m.set(id, join(SCORERS_DIR, f))
  }
  for (const p of extraPaths) {
    if (isUnsafeScorer(p, SUBGATE_UNSAFE, SUBGATE_UNSAFE_PATHS)) continue
    m.set(basename(p).replace(/\.[^.]+$/, ''), rpath(p))
  }
  return m
}

// The Verifier Forge sources its good/bad pair from FILE snapshots; on a scope run a snapshot is a git SHA
// (not a file path) and the artifact is a directory, so the Forge would silently no-op (or feed wrong
// content). parseScopeCli inherits --forge/--forge-store from parseCli, so reject it loudly here until
// scope-mode Forge ships (deferred). Single-file --forge via driver.mjs is unaffected.
export function forgeUnsupportedOnScope(cfg) {
  return !!cfg.forge
}

// --decompose without a held-out confirm scorer is refused: the done-edge must be verified from a
// pristine checkout (gitVerifyAt via confirm), or a decomposition could influence the primary score
// from a dirty tree. [CR#7]
export function decomposeNeedsConfirm(cfg) {
  return !!cfg.decompose && !cfg.confirmScorerCmd
}

// --decompose multiplies spend across children; require an explicit spend ceiling so an unattended
// fan-out can't run unbounded. At least one dial (USD or tokens) must be set.
export function decomposeNeedsBudget(cfg) {
  return !!cfg.decompose && cfg.budgetUsd == null && cfg.budgetTokens == null
}

// Wire the scope I/O seams as runFromConfig deps; everything else (gate, escalation, confirm, budget)
// is the unmodified driver. The escalated editor inherits the read-only guard and steps effort to a
// high floor, mirroring driver's editorEffort. When --decompose is set, the escalated slot becomes a
// decompose fan-out that spawns child loops per finding, then falls back to rescue on non-plateau.
export function scopeDeps(cfg) {
  const common = { scopeDir: cfg.scope, mcpConfig: cfg.mcpConfig, readOnly: cfg.readOnly, editScope: cfg.editScope }
  const deps = {
    buildContext: scopeBuildContext,
    act: makeScopeAct({ ...common, model: cfg.model, effort: cfg.effort }),
    restore: (sha) => gitRestore(cfg.scope, sha),
  }
  const rescueAct = cfg.noEscalate
    ? null
    : makeScopeAct({ ...common, model: cfg.escalateModel, effort: editorEffort({ effort: cfg.effort }, true) })
  if (cfg.decompose) {
    deps.actEscalated = makeDecomposeAct({
      repoDir: cfg.scope,
      parentLoopDir: cfg.loopDir,
      parentCfg: cfg,
      runChild: (childCfg) => runFromConfig(childCfg, scopeDeps(childCfg)),
      rescueAct: rescueAct ?? deps.act,
      allowlist: buildAllowlist(cfg.scorerAllow),
      maxChildren: cfg.maxChildren,
      childCap: cfg.childCap,
    })
  } else if (rescueAct) {
    deps.actEscalated = rescueAct
  }
  return deps
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv
  const cfg = parseScopeCli(argv, loadConfig())
  if (!cfg.goal || !cfg.scope || !cfg.scorerCmd) {
    process.stderr.write('usage: scope-cli.mjs "<goal>" --scope <repo dir> --scorer "<project test/build cmd>" [--read-only test/,gate] [--confirm-scorer "<cmd>"] [--target 90] [--cap 10] [--budget X] [--budget-tokens N] [--stability-runs N] [--model sonnet] [--effort medium] [--no-escalate] [--mcp-config <path>] [--loop-dir <dir>] [--decompose] [--max-children 4] [--child-cap 3] [--scorer-allow <paths>]\n')
    process.exit(2)
  }
  const guard = cleanTreeGuard(cfg.scope)
  if (!guard.ok) {
    process.stderr.write(`refusing to start: ${guard.reason}\n`)
    process.exit(2)
  }
  if (decomposeNeedsConfirm(cfg)) {
    process.stderr.write('refusing to start: --decompose requires --confirm-scorer (the held-out clean-checkout gate that verifies done from a pristine checkout)\n')
    process.exit(2)
  }
  if (decomposeNeedsBudget(cfg)) {
    process.stderr.write('refusing to start: --decompose requires a spend ceiling — set --budget and/or --budget-tokens (fan-out multiplies spend across children)\n')
    process.exit(2)
  }
  if (forgeUnsupportedOnScope(cfg)) {
    process.stderr.write('refusing to start: --forge is not supported on --scope runs (the Verifier Forge is single-file only; scope-mode Forge is deferred)\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg, scopeDeps(cfg))
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
