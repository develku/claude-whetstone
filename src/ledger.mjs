// A compact, code-owned memory of the run trajectory for the editor prompt: the bounded middle
// between amnesia (only the last critique) and the harmful full-history context that degrades long
// refinement loops (the "context ceiling"). Pure, derived ONLY from scores (numbers) — it carries
// no untrusted scorer free-text, so it is trusted context, unlike the fenced critique.
export function buildLedger(state) {
  const valid = state.history.filter((e) => typeof e.score === 'number' && Number.isFinite(e.score))
  if (valid.length < 2) return null
  const recent = valid.slice(-4).map((e) => `#${e.pass}=${e.score}`).join(' ')
  const delta = valid.at(-1).score - valid.at(-2).score
  const effect =
    delta > 0
      ? `last edit: +${delta} (improving — keep going)`
      : delta < 0
        ? `last edit: ${delta} (REGRESSED — try a different approach, do not repeat it)`
        : `last edit: no change (the gradient did not move — try a different approach)`
  return `Score trajectory: ${recent}. Best so far: ${state.best_score}. ${effect}.`
}
