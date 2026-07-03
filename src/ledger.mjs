// A compact, code-owned memory of the run trajectory for the editor prompt: the bounded middle
// between amnesia (only the last critique) and the harmful full-history context that degrades long
// refinement loops (the "context ceiling"). Pure, derived ONLY from scores (numbers) — it carries
// no untrusted scorer free-text, so it is trusted context, unlike the fenced critique.
export function buildLedger(state) {
  // Numbers-only is a SECURITY contract, not just a style: this string lands in the UNFENCED
  // (trusted) region of the editor prompt, so every interpolated value — score, pass, AND
  // best_score — must be a finite number, or a tampered/shared resumed state.json could smuggle
  // text past the critique fence. Coerce, don't trust.
  const valid = state.history.filter((e) => Number.isFinite(e.score) && Number.isFinite(e.pass))
  if (valid.length < 2) return null
  const recent = valid.slice(-4).map((e) => `#${e.pass}=${e.score}`).join(' ')
  const delta = valid.at(-1).score - valid.at(-2).score
  const effect =
    delta > 0
      ? `last edit: +${delta} (improving — keep going)`
      : delta < 0
        ? `last edit: ${delta} (REGRESSED — try a different approach, do not repeat it)`
        : `last edit: no change (the gradient did not move — try a different approach)`
  const best = Number.isFinite(state.best_score) ? state.best_score : '?'
  let line = `Score trajectory: ${recent}. Best so far: ${best}. ${effect}.`
  // AUD-05: the pass just scored was reverted by keep-best — tell the editor the live file is the best
  // snapshot so it does not "fix" a regression that was already erased on disk. Fixed prose with
  // finite-number-only interpolation (best_pass / best_score), preserving the trusted-region contract.
  if (
    state.restored_at_pass === state.pass &&
    Number.isFinite(state.restored_at_pass) &&
    Number.isFinite(state.best_pass) &&
    Number.isFinite(state.best_score)
  ) {
    line += ` NOTE: the last edit was REVERTED by keep-best; the live file is the pass-${state.best_pass} best (score ${state.best_score}).`
  }
  return line
}
