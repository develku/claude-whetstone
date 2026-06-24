// The v2 planner tier: the ONLY genuinely new decision logic. At a coarse-signal plateau the
// escalated-slot closure fans out one short child whetstone run per code-owned finding, each with a
// narrower scorer-emitted gate, then the unchanged parent loop re-measures the whole repo. runLoop /
// gateVerdict / recordPass are untouched; runChild + rescueAct are injected (no driver/scope-cli import).
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { gateVerdict } from './gate.mjs'

const key = (f) => String(f?.area ?? '')

// Decompose fires ONLY at a genuine plateau below target. The escalated slot is "sticky" (runLoop sets
// currentAct = actEscalated permanently), so without this self-check the closure would fan out on EVERY
// later pass and on the no-op escalation path with stale findings — the worst cost bug. [CR#1]
export function coarseSignalPlateau(state) {
  return gateVerdict(state).status === 'plateau' && state.best_score < state.target_score
}

// Findings are code-owned: read them from the last review file on disk, never from a model-supplied
// state field. Returns [] when there is no scored history, no review ref, or an unreadable/torn file.
export function readLatestFindings(parentLoopDir, state) {
  const ref = state.history?.at(-1)?.critique_ref
  if (!ref) return []
  try {
    const review = JSON.parse(readFileSync(join(parentLoopDir, ref), 'utf8'))
    return Array.isArray(review.findings) ? review.findings : []
  } catch {
    return []
  }
}
