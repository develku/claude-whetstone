export function restoreTarget(state) {
  if (state.regression_policy === 'keep-latest') return null
  if (state.best_pass == null || state.current_score >= state.best_score) return null
  return state.history[state.best_pass]?.snapshot ?? null
}
