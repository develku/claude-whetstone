#!/usr/bin/env node
// The driver wires the real side effects (scorer process, artifact snapshots,
// state.json, the Claude act step) into the pure loop. buildContext takes an
// injectable `act` so the whole pipeline is testable without spending money.
import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  initState,
  recordPass,
  ensureLoopDir,
  loadState,
  saveState,
  snapshotArtifact,
  writeReview,
  zeroPad,
} from './state.mjs'
import { runLoop } from './loop.mjs'
import { makeClaudeAct } from './act-claude.mjs'
import { validateConfig } from './validate.mjs'
import { prepareResume } from './resume.mjs'
import { formatReport } from './summary.mjs'

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

function runScorer(scorerCmd, { output, loopDir, pass }) {
  const full = `${scorerCmd} --output ${shq(output)} --loop-dir ${shq(loopDir)} --pass ${zeroPad(pass)}`
  const res = spawnSync(full, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return JSON.parse(res.stdout)
}

function runObserve(observeCmd, loopDir) {
  const res = spawnSync(observeCmd, { shell: true, encoding: 'utf8', cwd: loopDir, maxBuffer: 32 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`observe exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return (res.stdout || '').trim()
}

export function buildContext(loopDir) {
  const evaluate = async (s) => {
    const pass = s.history.length
    const output = s.observe_cmd ? runObserve(s.observe_cmd, loopDir) : s.artifact_path
    const review = runScorer(s.scorer_cmd, { output, loopDir, pass })
    return { score: review.score, critique: review.critique, review }
  }
  const persist = (s, ev) => {
    const pass = s.history.length
    const snapshot = snapshotArtifact(loopDir, s.artifact_path, pass)
    const reviewRef = writeReview(loopDir, pass, ev.review ?? { score: ev.score, critique: ev.critique })
    const next = recordPass(s, { score: ev.score, critique: ev.critique, snapshot, reviewRef, costUsd: ev.costUsd ?? 0 })
    saveState(loopDir, next)
    return next
  }
  return { evaluate, persist }
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

  const { evaluate, persist } = buildContext(loopDir)
  // Cheap editor every pass; stronger editor only after a plateau (escalation).
  const act = deps.act ?? makeClaudeAct({ artifactPath: state.artifact_path, model: state.model, mcpConfig: cfg.mcpConfig })
  const escalateModel = cfg.noEscalate ? null : cfg.escalateModel ?? 'opus'
  const actEscalated =
    deps.actEscalated ??
    (escalateModel ? makeClaudeAct({ artifactPath: state.artifact_path, model: escalateModel, mcpConfig: cfg.mcpConfig }) : null)

  // keep-best: restore a prior snapshot back over the live artifact when a pass regressed
  const restore = deps.restore ?? ((snap) => copyFileSync(join(loopDir, snap), state.artifact_path))

  const { state: final, verdict } = await runLoop({
    state,
    evaluate,
    act,
    actEscalated,
    persist,
    restore,
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

function parseCli(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : def
  }
  const goal = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) > 1)
  return {
    goal: goal ?? get('--goal'),
    artifactPath: get('--artifact'),
    scorerCmd: get('--scorer'),
    observeCmd: get('--observe', null),
    targetScore: get('--target') ? Number(get('--target')) : undefined,
    hardCap: get('--cap') ? Number(get('--cap')) : undefined,
    budgetUsd: get('--budget') ? Number(get('--budget')) : undefined,
    model: get('--model', 'sonnet'),
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
  const target = get('--target')
  const model = get('--model')
  if (cap !== undefined) o.hard_cap = Number(cap)
  if (budget !== undefined) o.budget_usd = Number(budget)
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
      process.stderr.write('usage: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--target T] [--model M] [--model-escalate opus | --no-escalate] [--mcp-config <path>]\n')
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
    process.stderr.write('usage: driver.mjs "<goal>" --artifact <path> --scorer "<cmd>" [--observe <cmd>] [--target 90] [--cap 10] [--budget 2.00] [--model sonnet] [--model-escalate opus | --no-escalate] [--mcp-config <path>] [--loop-dir <dir>]\n  resume: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--target T] [--model M]\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg)
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
