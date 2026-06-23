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
  saveState,
  snapshotArtifact,
  writeReview,
  zeroPad,
} from './state.mjs'
import { runLoop } from './loop.mjs'
import { makeClaudeAct } from './act-claude.mjs'
import { validateConfig } from './validate.mjs'
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

export async function runFromConfig(cfg, deps = {}) {
  const loopDir = cfg.loopDir
  ensureLoopDir(loopDir)
  const state = initState(cfg)
  const errors = validateConfig(state)
  if (errors.length) throw new Error(errors.join('; '))
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

  const { state: final, verdict } = await runLoop({ state, evaluate, act, actEscalated, persist, restore, log: deps.log ?? defaultLog })
  saveState(loopDir, final)
  return { state: final, verdict }
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

// Robust entry-point check: pathToFileURL percent-encodes the path (spaces, etc.)
// so it matches import.meta.url even when the repo lives under a path with spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = parseCli(process.argv)
  if (!cfg.goal || !cfg.artifactPath || !cfg.scorerCmd) {
    process.stderr.write('usage: driver.mjs "<goal>" --artifact <path> --scorer "<cmd>" [--observe <cmd>] [--target 90] [--cap 10] [--budget 2.00] [--model sonnet] [--model-escalate opus | --no-escalate] [--mcp-config <path>] [--loop-dir <dir>]\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg)
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
