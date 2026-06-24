#!/usr/bin/env node
// The driver wires the real side effects (scorer process, artifact snapshots,
// state.json, the Claude act step) into the pure loop. buildContext takes an
// injectable `act` so the whole pipeline is testable without spending money.
import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  initState,
  recordPass,
  ensureLoopDir,
  loadState,
  saveState,
  safeSnapshotPath,
  snapshotArtifact,
  writeReview,
  zeroPad,
} from './state.mjs'
import { runLoop } from './loop.mjs'
import { makeClaudeAct } from './act-claude.mjs'
import { validateConfig, EFFORT_LEVELS } from './validate.mjs'
import { prepareResume } from './resume.mjs'
import { formatReport } from './summary.mjs'

// Shell-quote a value for the scorer/observe command line (these run with shell:true). Single
// quotes neutralize spaces and metacharacters; an embedded ' is closed, escaped, and reopened.
// Exported for test — this repo itself lives under a path with spaces, so quoting is load-bearing.
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

// Hard wall-clock cap on the scorer/observe children so a hung command (flaky endpoint, a
// never-returning render/server step) can't wedge an unattended loop forever.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000

// The rescue (escalated) editor runs at a higher effort than the cheap forward passes — strength
// goes up on BOTH dials (model + effort) in one decisive jump, only when the loop proves it's stuck.
// 'high', not 'max': editing is the easy half, so reserve max for the judge / a deep-stall override.
const RESCUE_EFFORT = 'high'

// Resolve the editor's effort: forward passes use the operator's --effort; the rescue editor uses
// RESCUE_EFFORT as a FLOOR — never a downgrade. If the operator already runs --effort high|xhigh|max,
// the rescue keeps theirs, so escalation always raises (or holds) effort, never lowers it.
export function editorEffort(state, escalated) {
  if (!escalated) return state.effort
  const i = Math.max(EFFORT_LEVELS.indexOf(state.effort), EFFORT_LEVELS.indexOf(RESCUE_EFFORT))
  return EFFORT_LEVELS[i] ?? RESCUE_EFFORT
}

function runScorer(scorerCmd, { output, loopDir, pass }) {
  const full = `${scorerCmd} --output ${shq(output)} --loop-dir ${shq(loopDir)} --pass ${zeroPad(pass)}`
  const res = spawnSync(full, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`scorer failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return JSON.parse(res.stdout)
}

function runObserve(observeCmd, loopDir) {
  const res = spawnSync(observeCmd, { shell: true, encoding: 'utf8', cwd: loopDir, maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`observe failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`observe exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return (res.stdout || '').trim()
}

export function buildContext(loopDir) {
  const evaluate = async (s) => {
    const pass = s.history.length
    // observe runs in cwd=loopDir but the scorer runs in the driver cwd, so resolve a relative
    // observe-emitted path against loopDir — else the scorer reads it against the wrong dir (ENOENT).
    const output = s.observe_cmd ? resolve(loopDir, runObserve(s.observe_cmd, loopDir)) : s.artifact_path
    const review = runScorer(s.scorer_cmd, { output, loopDir, pass })
    return { score: review.score, critique: review.critique, review }
  }
  const persist = (s, ev) => {
    const pass = s.history.length
    const snapshot = snapshotArtifact(loopDir, s.artifact_path, pass)
    const reviewRef = writeReview(loopDir, pass, ev.review ?? { score: ev.score, critique: ev.critique })
    const next = recordPass(s, { score: ev.score, critique: ev.critique, snapshot, reviewRef, costUsd: ev.costUsd ?? 0, tokens: ev.tokens ?? 0 })
    saveState(loopDir, next)
    return next
  }
  // done-branch confirmation: re-score the same output with an INDEPENDENT scorer, run by the loop
  // only when the gate would declare done. Mirrors evaluate's output resolution (observe or artifact).
  const confirm = async (s) => {
    // observe runs in cwd=loopDir but the scorer runs in the driver cwd, so resolve a relative
    // observe-emitted path against loopDir — else the scorer reads it against the wrong dir (ENOENT).
    const output = s.observe_cmd ? resolve(loopDir, runObserve(s.observe_cmd, loopDir)) : s.artifact_path
    const review = runScorer(s.confirm_scorer_cmd, { output, loopDir, pass: s.history.length })
    return { score: review.score, critique: review.critique }
  }
  return { evaluate, persist, confirm }
}

const defaultLog = (e) =>
  process.stderr.write(`pass ${e.pass} · score ${e.score} · best ${e.best} · ${e.status} — ${e.reason}\n`)

// Wire the loop's real side effects around an already-prepared state. Shared by a fresh run
// and by --resume; the only difference is whether the loop scores a baseline first.
async function runPrepared(cfg, state, deps, { skipBaseline = false } = {}) {
  // Validate here — the one choke point both a fresh run and --resume pass through — so an
  // invalid override (e.g. a non-numeric --cap that became NaN) can't slip past via resume.
  const errors = validateConfig(state)
  if (errors.length) throw new Error(errors.join('; '))
  const loopDir = cfg.loopDir
  saveState(loopDir, state)

  const { evaluate, persist, confirm } = buildContext(loopDir)
  // Cheap editor every pass; stronger editor only after a plateau (escalation).
  // make is the editor factory (injectable so a test can observe the effort/model each editor is
  // built with — the real makeClaudeAct's effort is otherwise unobservable behind a claude spawn).
  const make = deps.makeAct ?? makeClaudeAct
  const act = deps.act ?? make({ artifactPath: state.artifact_path, model: state.model, mcpConfig: cfg.mcpConfig, effort: editorEffort(state, false) })
  const escalateModel = cfg.noEscalate ? null : cfg.escalateModel ?? 'opus'
  const actEscalated =
    deps.actEscalated ??
    (escalateModel ? make({ artifactPath: state.artifact_path, model: escalateModel, mcpConfig: cfg.mcpConfig, effort: editorEffort(state, true) }) : null)

  // keep-best: restore a prior snapshot back over the live artifact when a pass regressed.
  // safeSnapshotPath refuses a ref that escapes the run dir (a poisoned snapshot ref on resume).
  const restore = deps.restore ?? ((snap) => copyFileSync(safeSnapshotPath(loopDir, snap), state.artifact_path))

  const { state: final, verdict } = await runLoop({
    state,
    evaluate,
    act,
    actEscalated,
    persist,
    restore,
    confirm: deps.confirm ?? (state.confirm_scorer_cmd ? confirm : null),
    save: deps.save ?? ((st) => saveState(loopDir, st)), // durable confirm-veto marker (see confirmDone)
    skipBaseline,
    log: deps.log ?? defaultLog,
  })
  saveState(loopDir, final)
  return { state: final, verdict }
}

export async function runFromConfig(cfg, deps = {}) {
  ensureLoopDir(cfg.loopDir)
  const state = initState(cfg)
  return runPrepared(cfg, state, deps) // runPrepared validates the config before any side effect
}

// --resume: continue a previously-stopped run from its state.json. Load the durable state,
// apply only the overrides the operator explicitly passed (cap/budget/target/model), and let
// the GATE decide whether resuming can make progress (prepareResume). The run then continues
// WITHOUT re-scoring a baseline — the live artifact is already the best snapshot.
export async function resumeFromConfig(cfg, deps = {}) {
  // Resume reads an EXISTING run, so load BEFORE creating anything — a typo'd --loop-dir must
  // fail with an actionable message (not a raw ENOENT/JSON error) and leave no orphan dir behind.
  let loaded
  try {
    loaded = loadState(cfg.loopDir)
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`cannot resume: no run found at ${cfg.loopDir} (no state.json) — check --loop-dir`)
    throw new Error(`cannot resume: state.json at ${cfg.loopDir} is corrupt (${e.message})`)
  }
  ensureLoopDir(cfg.loopDir) // run confirmed; ensure snapshots/ + reviews/ exist for persist
  const { state, error } = prepareResume(loaded, cfg.overrides ?? {})
  if (error) throw new Error(error)
  return runPrepared(cfg, state, deps, { skipBaseline: true })
}

export function parseCli(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : def
  }
  // The goal is the FIRST positional only (argv[2]). Scanning for any non-`--` token would pick
  // up a flag's value (e.g. --artifact x.txt) as the goal when the positional is omitted, slipping
  // past the usage guard and running with a garbage goal in every paid edit prompt.
  const positional = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined
  return {
    goal: positional ?? get('--goal'),
    artifactPath: get('--artifact'),
    scorerCmd: get('--scorer'),
    confirmScorerCmd: get('--confirm-scorer', null),
    observeCmd: get('--observe', null),
    targetScore: get('--target') ? Number(get('--target')) : undefined,
    hardCap: get('--cap') ? Number(get('--cap')) : undefined,
    budgetUsd: get('--budget') ? Number(get('--budget')) : undefined,
    budgetTokens: get('--budget-tokens') ? Number(get('--budget-tokens')) : undefined,
    model: get('--model', 'sonnet'),
    effort: get('--effort', 'medium'),
    escalateModel: get('--model-escalate', 'opus'),
    noEscalate: argv.includes('--no-escalate'),
    mcpConfig: get('--mcp-config', null),
    loopDir: get('--loop-dir', `.loop/run_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`),
  }
}

// On resume, only the flags the operator actually typed become overrides — anything absent
// keeps the value carried in the loaded state.json (NO defaults, unlike a fresh run).
function parseResumeOverrides(argv) {
  const get = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const o = {}
  const cap = get('--cap')
  const budget = get('--budget')
  const budgetTokens = get('--budget-tokens')
  const target = get('--target')
  const model = get('--model')
  if (cap !== undefined) o.hard_cap = Number(cap)
  if (budget !== undefined) o.budget_usd = Number(budget)
  if (budgetTokens !== undefined) o.budget_tokens = Number(budgetTokens)
  if (target !== undefined) o.target_score = Number(target)
  if (model !== undefined) o.model = model
  return o
}

// Robust entry-point check: pathToFileURL percent-encodes the path (spaces, etc.)
// so it matches import.meta.url even when the repo lives under a path with spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  if (argv.includes('--resume')) {
    const loopDir = flag('--loop-dir')
    if (!loopDir) {
      process.stderr.write('usage: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--budget-tokens N] [--target T] [--model M] [--model-escalate opus | --no-escalate] [--mcp-config <path>]\n')
      process.exit(2)
    }
    try {
      const { state, verdict } = await resumeFromConfig({
        loopDir,
        overrides: parseResumeOverrides(argv),
        mcpConfig: flag('--mcp-config') ?? null,
        escalateModel: flag('--model-escalate') ?? 'opus',
        noEscalate: argv.includes('--no-escalate'),
      })
      process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
      process.exit(verdict.status === 'done' ? 0 : 1)
    } catch (e) {
      process.stderr.write(`${e.message}\n`)
      process.exit(2)
    }
  }

  const cfg = parseCli(argv)
  if (!cfg.goal || !cfg.artifactPath || !cfg.scorerCmd) {
    process.stderr.write('usage: driver.mjs "<goal>" --artifact <path> --scorer "<cmd>" [--confirm-scorer "<cmd>"] [--observe <cmd>] [--target 90] [--cap 10] [--budget 2.00] [--budget-tokens N] [--model sonnet] [--effort medium] [--model-escalate opus | --no-escalate] [--mcp-config <path>] [--loop-dir <dir>]\n  resume: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--budget-tokens N] [--target T] [--model M]\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg)
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
