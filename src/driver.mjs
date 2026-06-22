#!/usr/bin/env node
// The driver wires the real side effects (scorer process, artifact snapshots,
// state.json, the Claude act step) into the pure loop. buildContext takes an
// injectable `act` so the whole pipeline is testable without spending money.
import { spawnSync } from 'node:child_process'
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
  saveState(loopDir, state)

  const { evaluate, persist } = buildContext(loopDir)
  const act = deps.act ?? makeClaudeAct({ artifactPath: state.artifact_path, model: state.model, mcpConfig: cfg.mcpConfig })

  const { state: final, verdict } = await runLoop({ state, evaluate, act, persist, log: deps.log ?? defaultLog })
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
    model: get('--model', null),
    mcpConfig: get('--mcp-config', null),
    loopDir: get('--loop-dir', `.loop/run_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = parseCli(process.argv)
  if (!cfg.goal || !cfg.artifactPath || !cfg.scorerCmd) {
    process.stderr.write('usage: driver.mjs "<goal>" --artifact <path> --scorer "<cmd>" [--observe <cmd>] [--target 90] [--cap 10] [--budget 2.00] [--model ...] [--mcp-config <path>] [--loop-dir <dir>]\n')
    process.exit(2)
  }
  const { state, verdict } = await runFromConfig(cfg)
  process.stdout.write(`\n${verdict.status.toUpperCase()}: ${verdict.reason}\n`)
  process.stdout.write(`best score ${state.best_score} at pass ${state.best_pass} · ${state.history.length} passes · spent $${state.spent_usd.toFixed(4)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
