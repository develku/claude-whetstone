// The gate is the one thing the MODEL must not own. It reads only numbers the
// scorer produced and decides continue/stop in code, so the loop cannot vote
// itself done. Pure function, no I/O — that is what makes it testable and trusted.

// Exported so the confirm leg (loop.mjs) can hold its score to the same 0..100 invariant the gate
// enforces on the primary score — a confirm scorer's output never passes through the gate itself.
export function validScore(s) {
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 100
}

function runningMax(scores) {
  const out = []
  let m = -Infinity
  for (const s of scores) {
    m = Math.max(m, s)
    out.push(m)
  }
  return out
}

// Precedence is deliberate: error > done > capped > plateau > running.
// - error first: a malformed score is never allowed to read as success or progress.
// - done before capped: hitting the target on the final allowed pass is a win, not a cap.
// - plateau before running: a stalled loop stops early instead of burning the cap.
export function gateVerdict(state) {
  const { target_score, hard_cap, min_delta, plateau_window, pass, history } = state
  const scores = history.map((h) => h.score)
  const latest = scores.at(-1)

  if (!validScore(latest)) {
    return { status: 'error', reason: `scorer returned an invalid score: ${String(latest)} (need a number in 0..100)` }
  }
  if (latest >= target_score) {
    return { status: 'done', reason: `score ${latest} reached target ${target_score} at pass ${pass}` }
  }
  if (pass >= hard_cap) {
    return { status: 'capped', reason: `hard cap of ${hard_cap} passes hit; best below target ${target_score}` }
  }

  const best = runningMax(scores)
  if (best.length > plateau_window) {
    const improvement = best.at(-1) - best.at(-1 - plateau_window)
    if (improvement < min_delta) {
      return {
        status: 'plateau',
        reason: `best score improved by ${improvement.toFixed(2)} (< min_delta ${min_delta}) over the last ${plateau_window} passes`,
      }
    }
  }

  return { status: 'running', reason: `score ${latest} below target ${target_score}; continuing` }
}
