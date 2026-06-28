// The Track C ORCHESTRATOR: drives N per-objective scope runs under ONE code-owned global gate
// (converge-gate.mjs globalVerdict). Each objective runs as an unmodified per-objective loop
// (runFromConfig + scopeDeps) in an ISOLATED worktree off the gc-safe last-good ref; its net tree is
// SQUASH-integrated (editScope-positive: only allowed paths carried) into exactly ONE commit on last-good;
// then a STRICT GLOBAL RE-MEASURE re-scores every objective + the floor against that candidate commit, and
// the global gate decides advance-or-rollback. Stability (≥2× re-measure) and budget wrap the gate exactly
// as loop.mjs wraps gateVerdict. Composes the 7 invariant files; edits none.
//
// reMeasureAll + squashIntegrate + globalVerdict + the last-good-ref logic are EXPORTED so a future Track-B
// converge-parallel.mjs reuses the IDENTICAL gate path (the report's highest-risk integration seam): the
// sequential candidate-producer is the only B-replaceable part.
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitMaterialize, gitCleanup, gitHead, isSha } from './git-snapshot.mjs'
import { pathsIntersect } from './converge-cli.mjs'
import { shq } from './shq.mjs'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// Hard wall-clock cap on every re-measure child (mirrors driver's CHILD_TIMEOUT_MS) so a hung scorer/floor
// can't wedge an unattended converge run.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000
const FLOOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'floor.mjs')

// A committed path is INTEGRATED only if it is inside the objective's editScope (the positive allowlist)
// AND not a gate/measurement file (the global read-only denylist beats the allowlist). This is the whole
// editScope-positive control — enforced at integration via selective squash, not by editing scope-act.
export function editScopeAllowed(path, editScope, globalRO = []) {
  if (!pathsIntersect(path, editScope)) return false
  return !globalRO.some((ro) => pathsIntersect(path, ro))
}

// name+status of every file that differs between two commits. --no-renames so a rename reads as delete+add
// (avoids R-status handling); the status is the FIRST char (A/M/D).
function diffNameStatus(scopeDir, fromSha, toSha) {
  const out = git(scopeDir, ['diff', '--no-renames', '--name-status', fromSha, toSha])
  if (!out) return []
  return out.split('\n').map((l) => {
    const tab = l.indexOf('\t')
    return { status: l[0], path: l.slice(tab + 1) }
  })
}

// Reduce a child's net tree (lastGoodSha -> childHeadSha) to EXACTLY ONE squash commit on lastGoodSha,
// carrying ONLY the paths isAllowed() admits (editScope-positive; gate files excluded). The candidate's
// PARENT is lastGoodSha by construction (codex: parent-equality is stronger than merely-descendant). A
// child whose only changes are out-of-scope (or all-empty) yields zero allowed change -> NO advance
// (mirrors decompose's gitTreeChanged honesty). Built in a throwaway worktree so the live tree/branch is
// untouched until the gate accepts the candidate.
export function squashIntegrate(scopeDir, lastGoodSha, childHeadSha, isAllowed, label = 'integrate') {
  if (!isSha(lastGoodSha) || !isSha(childHeadSha)) throw new Error('squashIntegrate requires commit SHAs')
  const changed = diffNameStatus(scopeDir, lastGoodSha, childHeadSha)
  const allowed = changed.filter((c) => isAllowed(c.path))
  const reverted = changed.filter((c) => !isAllowed(c.path)).map((c) => c.path)
  if (!allowed.length) return { advanced: false, sha: lastGoodSha, reverted, integrated: [] }
  const wt = gitMaterialize(scopeDir, lastGoodSha)
  try {
    for (const c of allowed) {
      if (c.status === 'D') git(wt, ['rm', '-q', '--', c.path])
      else git(wt, ['checkout', childHeadSha, '--', c.path])
    }
    git(wt, ['add', '-A'])
    git(wt, ['commit', '--quiet', '-m', `whetstone-converge: ${label}`])
    return { advanced: true, sha: gitHead(wt), reverted, integrated: allowed.map((c) => c.path) }
  } finally {
    gitCleanup(scopeDir, wt)
  }
}

// --- the STRICT GLOBAL RE-MEASURE: score the floor + every objective against a pristine candidate commit ---

// Run the deterministic floor via the shipped floor.mjs (cwd = a pristine worktree of the candidate). The
// floor's pass/fail is encoded in floor.mjs's JSON score (0 = the floor command failed), NOT in an exit
// code. NOT routed through floorConfirmCmd (that builds a confirm-shaped --and/--output command).
function defaultRunFloor(floorCmd, cwd) {
  const res = spawnSync('node', [FLOOR_PATH, '--cmd', floorCmd], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`floor failed to spawn (${res.error.code || res.error.message})`)
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`floor.mjs produced no JSON (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}`)
  }
}

// Run a project scorer (cwd = a pristine worktree of the candidate). Same {score,critique} + CLI contract as
// the scope path (--output/--loop-dir/--pass), scoring the committed SHA's tree.
function defaultRunScorer(scorerCmd, cwd) {
  const full = `${scorerCmd} --output ${shq(cwd)} --loop-dir ${shq(cwd)} --pass 000`
  const res = spawnSync(full, { shell: true, cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`scorer failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`)
  return JSON.parse(res.stdout)
}

// Floor with a one-shot REPLICA GATE: a fail on attempt 1 is re-run once in a FRESH worktree (transient
// build/network/port flake immunity); only a reproduced fail scores 0. Each attempt is a pristine worktree.
function measureFloor(scopeDir, candidateSha, floorCmd, materialize, cleanup, runFloor) {
  const once = () => {
    const wt = materialize(scopeDir, candidateSha)
    try {
      return runFloor(floorCmd, wt)
    } finally {
      cleanup(scopeDir, wt)
    }
  }
  const r1 = once()
  if (r1.score === 100) return { score: 100, critique: r1.critique ?? '', replicas: 1 }
  const r2 = once()
  if (r2.score === 100) return { score: 100, critique: r2.critique ?? '', replicas: 2 }
  return { score: 0, critique: r2.critique ?? r1.critique ?? 'deterministic floor failed', replicas: 2 }
}

// reMeasureAll: the strict global re-measure against a pristine candidate commit. Runs the FLOOR FIRST and
// SHORT-CIRCUITS on a (reproduced) floor failure — the expensive objective scorers are never paid for on a
// broken repo. Then scores every objective in its OWN fresh worktree (so project-test scorers writing
// __pycache__/.cache to cwd cannot cross-contaminate); a judge objective additionally runs its HELD-OUT
// confirm (the value globalVerdict reads for MET). deps inject materialize/cleanup/runFloor/runScorer so the
// control logic is testable without real worktrees or spend. Track B reuses this VERBATIM on a merged
// candidateSha — the gate path is identical regardless of how the candidate was produced.
export function reMeasureAll(scopeDir, candidateSha, objectives, floor, deps = {}) {
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const runFloor = deps.runFloor ?? defaultRunFloor
  const runScorer = deps.runScorer ?? defaultRunScorer

  const floorRes = measureFloor(scopeDir, candidateSha, floor.cmd, materialize, cleanup, runFloor)
  if (floorRes.score === 0) return { floor: floorRes, vector: null, blocked: true }

  const vector = objectives.map((o) => {
    const wt = materialize(scopeDir, candidateSha)
    try {
      const primary = runScorer(o.scorer, wt)
      let confirmScore = null
      let critique = primary.critique ?? ''
      if (o.judgeClass) {
        const c = runScorer(o.confirmScorer, wt)
        confirmScore = c.score
        critique = c.critique ?? critique
      }
      return { id: o.id, primaryScore: primary.score, confirmScore, critique }
    } finally {
      cleanup(scopeDir, wt)
    }
  })
  return { floor: floorRes, vector, blocked: false }
}
