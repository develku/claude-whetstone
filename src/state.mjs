// State is the durable, code-owned record of a run. The model never writes it.
// recordPass is a PURE immutable update (operator coding-style: new objects, no
// mutation); the file I/O helpers are the only side-effecting functions here.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

export const isoNow = () => new Date().toISOString()
export const zeroPad = (n, width = 3) => String(n).padStart(width, '0')

export function initState(cfg) {
  const ts = isoNow()
  return {
    goal: cfg.goal,
    artifact_path: cfg.artifactPath,
    observe_cmd: cfg.observeCmd ?? null,
    scorer_cmd: cfg.scorerCmd ?? null,
    target_score: cfg.targetScore ?? 90,
    min_delta: cfg.minDelta ?? 1,
    plateau_window: cfg.plateauWindow ?? 3,
    hard_cap: cfg.hardCap ?? 10,
    budget_usd: cfg.budgetUsd ?? null,
    model: cfg.model ?? null,
    pass: 0,
    last_critique: null,
    current_score: null,
    best_score: null,
    best_pass: null,
    spent_usd: 0,
    status: 'running',
    status_reason: null,
    started_at: ts,
    updated_at: ts,
    history: [],
  }
}

// Append one scored pass. pass index = current history length (0 = baseline).
export function recordPass(state, { score, critique = null, snapshot = null, reviewRef = null, costUsd = 0 }) {
  const pass = state.history.length
  const isBest = state.best_score == null || score > state.best_score
  return {
    ...state,
    pass,
    last_critique: critique,
    current_score: score,
    best_score: isBest ? score : state.best_score,
    best_pass: isBest ? pass : state.best_pass,
    spent_usd: state.spent_usd + costUsd,
    updated_at: isoNow(),
    history: [...state.history, { pass, score, critique_ref: reviewRef, snapshot, ts: isoNow() }],
  }
}

export function setStatus(state, status, reason) {
  return { ...state, status, status_reason: reason, updated_at: isoNow() }
}

// --- file I/O (the run directory is the durable record) ---

export function ensureLoopDir(loopDir) {
  for (const sub of ['', 'snapshots', 'reviews']) mkdirSync(join(loopDir, sub), { recursive: true })
}

export const statePath = (loopDir) => join(loopDir, 'state.json')
export const loadState = (loopDir) => JSON.parse(readFileSync(statePath(loopDir), 'utf8'))
export const saveState = (loopDir, state) => writeFileSync(statePath(loopDir), JSON.stringify(state, null, 2))

export function snapshotArtifact(loopDir, artifactPath, pass) {
  const rel = join('snapshots', `iter_${zeroPad(pass)}${extname(artifactPath)}`)
  copyFileSync(artifactPath, join(loopDir, rel))
  return rel
}

export function writeReview(loopDir, pass, review) {
  const rel = join('reviews', `review_${zeroPad(pass)}.json`)
  writeFileSync(join(loopDir, rel), JSON.stringify(review, null, 2))
  return rel
}

export const snapshotExists = (loopDir, rel) => existsSync(join(loopDir, rel))
