#!/usr/bin/env node
// whetstone-scope MVP entry: the same code-owned loop as driver.mjs, pointed at a whole repo instead
// of one file. It reuses driver's parseCli, runFromConfig (escalation, confirm-veto, budget, resume,
// validation) and only swaps the four file-bound seams via deps: a git-backed context (scope-context),
// a multi-file editor with the read-only gate guard (scope-act), and git keep-best restore. The scope
// dir is carried in cfg.artifactPath (the "artifact" is the directory).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, basename, join, resolve as rpath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { runFromConfig, parseCli, loadConfig, editorEffort } from './driver.mjs'
import { scopeBuildContext } from './scope-context.mjs'
import { makeScopeAct } from './scope-act.mjs'
import { gitRestore } from './git-snapshot.mjs'
import { formatReport } from './summary.mjs'
import { makeDecomposeAct } from './decompose.mjs'
import { isUnsafeScorer } from './scorer-safety.mjs'
import { runScopeForgeHook } from './forge/scope-hook.mjs'
import { floorConfirmCmd } from '../scorers/floor.mjs'

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
  const fmf = get('--forge-max-files') // scope multi-file learn cap (hook default 8); parse '0' as 0, not undefined, so the guard catches it
  cfg.forgeMaxFiles = fmf !== undefined ? Number(fmf) : undefined
  // --floor wires the DETERMINISTIC FLOOR as the confirm: it activates the done-edge confirm even behind a
  // judge-only primary --scorer, and composes ABOVE any --confirm-scorer (which runs only if the floor
  // passes). Enforces "never ship a judge-only top gate" in scope mode.
  cfg.floor = get('--floor')
  if (cfg.floor) {
    const floorPath = rpath(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'floor.mjs')
    cfg.confirmScorerCmd = floorConfirmCmd({ floorPath, floorCmd: cfg.floor, confirmCmd: cfg.confirmScorerCmd })
  }
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
// floor joins composite: its --cmd is an operator-provided shell command, so a decompose finding that named
// it with a MODEL-chosen --cmd would reach a shell. Denied from both the AUTO set and operator extraPaths.
const SUBGATE_UNSAFE = new Set(['composite', 'floor'])
const SUBGATE_UNSAFE_PATHS = [join(SCORERS_DIR, 'composite.mjs'), join(SCORERS_DIR, 'floor.mjs')]

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

// The Verifier Forge IS supported on scope runs (per-file scope checks; src/forge/scope-hook.mjs, injected as
// deps.runForgeHook below). Trust boundary: the check store must live OUTSIDE --scope — the loop git-resets/
// cleans the scope, which would clobber a store inside it, and the editor could tamper with it. Refuse a
// --forge-store within --scope.
export function forgeStoreInsideScope(cfg) {
  if (!cfg.forge || !cfg.forgeStorePath || !cfg.scope) return false
  const base = rpath(cfg.scope)
  const store = rpath(cfg.forgeStorePath)
  return store === base || store.startsWith(base + sep)
}

// --forge on scope only fires on a recovered confirm-veto, so it needs both a held-out --confirm-scorer (the
// veto source) and a --forge-store (where learned checks live); refuse early rather than silently no-op.
export function forgeNeedsStoreAndConfirm(cfg) {
  return !!cfg.forge && (!cfg.forgeStorePath || !cfg.confirmScorerCmd)
}

// --forge-max-files, if set, must be a positive integer (it caps how many changed files the scope Forge learns
// for). Validate at the boundary rather than silently coercing: 0/negative/non-integer would be a user error
// that should surface, not fall back. Unset (undefined) is fine — the hook applies its default of 8.
export function forgeMaxFilesInvalid(cfg) {
  return cfg.forgeMaxFiles !== undefined && (!Number.isInteger(cfg.forgeMaxFiles) || cfg.forgeMaxFiles < 1)
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
    runForgeHook: (a) => runScopeForgeHook(a), // scope (repo) Forge: materialize SHAs + learn a per-file check
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

if (isMainModule(import.meta.url)) {
  const argv = process.argv
  const cfg = parseScopeCli(argv, loadConfig())
  if (!cfg.goal || !cfg.scope || !cfg.scorerCmd) {
    process.stderr.write('usage: scope-cli.mjs "<goal>" --scope <repo dir> --scorer "<project test/build cmd>" [--read-only test/,gate] [--confirm-scorer "<cmd>"] [--target 90] [--cap 10] [--budget X] [--budget-tokens N] [--stability-runs N] [--model sonnet] [--effort medium] [--no-escalate] [--mcp-config <path>] [--loop-dir <dir>] [--decompose] [--max-children 4] [--child-cap 3] [--scorer-allow <paths>] [--forge --forge-store <path OUTSIDE scope> --confirm-scorer "<cmd>"] [--forge-max-files 8] [--forge-oracle "<scorer cmd>" ...]\n')
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
  if (forgeNeedsStoreAndConfirm(cfg)) {
    process.stderr.write('refusing to start: --forge on --scope requires --forge-store <path OUTSIDE the scope> and --confirm-scorer "<held-out cmd>"\n')
    process.exit(2)
  }
  if (forgeStoreInsideScope(cfg)) {
    process.stderr.write('refusing to start: --forge-store must be OUTSIDE --scope (the loop git-resets the scope; a store inside it would be clobbered and the editor could tamper with it)\n')
    process.exit(2)
  }
  if (forgeMaxFilesInvalid(cfg)) {
    process.stderr.write('refusing to start: --forge-max-files must be a positive integer\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg, scopeDeps(cfg))
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
