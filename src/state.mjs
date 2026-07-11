// State is the durable, code-owned record of a run. The model never writes it.
// recordPass is a PURE immutable update (operator coding-style: new objects, no
// mutation); the file I/O helpers are the only side-effecting functions here.
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { redactSecrets } from './redact.mjs'

export const isoNow = () => new Date().toISOString()
export const zeroPad = (n, width = 3) => String(n).padStart(width, '0')

export function initState(cfg) {
  const ts = isoNow()
  return {
    goal: cfg.goal,
    // Resolve to absolute up front: the editor runs in dirname(artifact_path) and snapshot/restore/
    // evaluate copy it, so a relative path would resolve against whatever cwd a later --resume runs
    // from — reading/writing the wrong file. Resolved once here, the whole run is cwd-stable.
    artifact_path: cfg.artifactPath ? resolve(cfg.artifactPath) : cfg.artifactPath,
    observe_cmd: cfg.observeCmd ?? null,
    scorer_cmd: cfg.scorerCmd ?? null,
    confirm_scorer_cmd: cfg.confirmScorerCmd ?? null,
    target_score: cfg.targetScore ?? 90,
    min_delta: cfg.minDelta ?? 1,
    plateau_window: cfg.plateauWindow ?? 3,
    hard_cap: cfg.hardCap ?? 10,
    // Done-edge confidence dial: re-measure the primary scorer N times when the gate says done, accept
    // only if the WEAKEST reading clears target. 1 = off (single reading = the historical behavior).
    stability_runs: cfg.stabilityRuns ?? 1,
    budget_usd: cfg.budgetUsd ?? null,
    budget_tokens: cfg.budgetTokens ?? null,
    model: cfg.model ?? null,
    effort: cfg.effort ?? 'medium',
    pass: 0,
    last_critique: null,
    // The critique of the best pass so far. On a keep-best rollback the loop re-points last_critique
    // at this, so the next edit is steered by the version now on disk — not the reverted (dead) one
    // (AUD-05). null (not undefined) even when the best pass had no critique text, so the restore
    // guard can tell "known-no-critique" (fall back to neutral) from "legacy state.json" (keep old).
    best_critique: null,
    current_score: null,
    best_score: null,
    best_pass: null,
    confirm_vetoed_at_pass: null,
    // RECORD-ONLY provenance (like confirm_vetoed_at_pass): the pass whose edit keep-best reverted.
    restored_at_pass: null,
    spent_usd: 0,
    spent_tokens: 0,
    status: 'running',
    status_reason: null,
    started_at: ts,
    updated_at: ts,
    history: [],
    // Fence-safe discard-memory (v1.8.0): per-area sighting registry from scorer findings — see
    // src/area-registry.mjs. Read with `?? []` (pre-feature state.json files lack it).
    area_ledger: [],
    // AUD-09: a converge retry child receives a code-composed summary of THIS objective's prior failed
    // attempts (buildObjectiveCfg -> cfg.retryMemo); the scope prompt fences it. null for single-file runs.
    retry_memo: cfg.retryMemo ?? null,
  }
}

// Append one scored pass. pass index = current history length (0 = baseline).
export function recordPass(state, { score, critique = null, snapshot = null, reviewRef = null, costUsd = 0, tokens = 0 }) {
  const pass = state.history.length
  const isBest = state.best_score == null || score > state.best_score
  return {
    ...state,
    pass,
    last_critique: critique,
    // Track the best pass's critique alongside best_score/best_pass (AUD-05). `critique` defaults to
    // null, so a new best with no critique text stores null — never undefined (the restore guard relies
    // on undefined meaning ONLY "legacy state.json without this field").
    best_critique: isBest ? critique : state.best_critique,
    current_score: score,
    best_score: isBest ? score : state.best_score,
    best_pass: isBest ? pass : state.best_pass,
    spent_usd: state.spent_usd + costUsd,
    // ?? 0: a state.json written before token budgeting has no spent_tokens — read it as 0, not NaN.
    spent_tokens: (state.spent_tokens ?? 0) + tokens,
    updated_at: isoNow(),
    history: [...state.history, { pass, score, critique_ref: reviewRef, snapshot, ts: isoNow() }],
  }
}

// The summed spend of one scored pass: the editor's (act) spend PLUS the scorer's own (an llm-judge
// scorer pays a second model call each pass, reported as review.usage). The ONE shared helper both
// persist twins (driver.buildContext + scopeBuildContext) call, so single-file and scope/converge
// budget accounting can't drift — one boundary, one summing rule. Number()||0 so a scorer without the
// optional usage field (every deterministic scorer) charges 0, never NaN.
export function passSpend(ev) {
  return {
    costUsd: (ev?.costUsd ?? 0) + (Number(ev?.review?.usage?.costUsd) || 0),
    tokens: (ev?.tokens ?? 0) + (Number(ev?.review?.usage?.tokens) || 0),
  }
}

// --- file I/O (the run directory is the durable record) ---

export function ensureLoopDir(loopDir) {
  for (const sub of ['', 'snapshots', 'reviews']) mkdirSync(join(loopDir, sub), { recursive: true })
  // Self-ignoring: the run dir holds state.json/reviews that may carry secrets, and whet.md tells
  // operators to pass an absolute/custom --loop-dir the repo .gitignore won't match. Drop a
  // local .gitignore so the run dir is never accidentally committed wherever it lands.
  writeFileSync(join(loopDir, '.gitignore'), '*\n')
}

export const statePath = (loopDir) => join(loopDir, 'state.json')
export const loadState = (loopDir) => JSON.parse(readFileSync(statePath(loopDir), 'utf8'))
// Crash-safe write: state.json is --resume's only durable input, so write to a temp file and
// rename over it (atomic on the same filesystem). A kill mid-write leaves the prior state.json
// intact instead of a torn/truncated file that resume would reject as corrupt. Redacted too, so
// the redaction boundary is the whole run dir (reviews/ AND state.json), not one file within it.
export const saveState = (loopDir, state) => {
  const tmp = statePath(loopDir) + '.tmp'
  writeFileSync(tmp, redactSecrets(JSON.stringify(state, null, 2)))
  renameSync(tmp, statePath(loopDir))
}

// A snapshot ref restored over the live artifact is internal on a fresh run, but on --resume it
// comes from state.json (which may be tampered/shared). Refuse any ref that resolves outside the
// run dir (absolute or `..` traversal) so a poisoned ref can't read an arbitrary file into the
// artifact. resolve() treats an absolute `snap` as absolute, so both escape shapes are caught.
export function safeSnapshotPath(loopDir, snap) {
  const base = resolve(loopDir)
  const full = resolve(base, snap)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`snapshot ref escapes the run dir: ${snap}`)
  }
  // The lexical guard above is realpath-blind: an in-dir SYMLINK whose target is OUTSIDE the run dir passes
  // it, yet the consumers FOLLOW the link — driver.mjs copyFileSync's it over the artifact and forge/hook
  // reads it, an out-of-dir file-read primitive from a tampered/shared state.json. Re-check containment on
  // the REAL paths. A not-yet-materialized ref (realpathSync throws) has no symlink to follow — the lexical
  // guard already held. Mirrors src/safe-rel.mjs resolveOutput.
  let realFull
  try {
    realFull = realpathSync(full)
  } catch {
    return full
  }
  const realBase = realpathSync(base) // base must exist since `full` (under it) resolved
  if (realFull !== realBase && !realFull.startsWith(realBase + sep)) {
    throw new Error(`snapshot ref escapes the run dir via symlink: ${snap}`)
  }
  return full
}

export function snapshotArtifact(loopDir, artifactPath, pass) {
  const rel = join('snapshots', `iter_${zeroPad(pass)}${extname(artifactPath)}`)
  copyFileSync(artifactPath, join(loopDir, rel))
  return rel
}

export function writeReview(loopDir, pass, review) {
  const rel = join('reviews', `review_${zeroPad(pass)}.json`)
  writeFileSync(join(loopDir, rel), redactSecrets(JSON.stringify(review, null, 2)))
  return rel
}
