// Number.isFinite / Number.isInteger FIRST on every numeric bound. A non-numeric value
// (e.g. `--cap abc` -> NaN via Number()) slips through every `<`/`>` comparison (NaN < 1
// is false), which would silently disable a stop condition (the cap/budget) or corrupt the
// plateau math. COUNTED values (hard_cap, plateau_window — compared against the integer
// pass index / array length) must be integers; THRESHOLDS (target_score, min_delta,
// budget_usd — only compared) may be fractional.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function validateConfig(state) {
  const errors = []
  if (!Number.isFinite(state.target_score) || state.target_score < 0 || state.target_score > 100) {
    errors.push('target_score must be a number between 0 and 100')
  }
  if (!Number.isInteger(state.hard_cap) || state.hard_cap < 1) {
    errors.push('hard_cap must be an integer at least 1')
  }
  if (!Number.isFinite(state.min_delta) || state.min_delta < 0) {
    errors.push('min_delta must be a non-negative number')
  }
  if (!Number.isInteger(state.plateau_window) || state.plateau_window < 1) {
    errors.push('plateau_window must be an integer at least 1')
  }
  // budget is optional; validate only when one is set. `!= null` treats both null (the
  // initState default) and a missing key from an older state.json (undefined) as "no budget".
  if (state.budget_usd != null && (!Number.isFinite(state.budget_usd) || state.budget_usd <= 0)) {
    errors.push('budget_usd must be a positive number when set')
  }
  if (!state.scorer_cmd) {
    errors.push('scorer_cmd is required')
  }
  // effort is optional (a string flag, not a number); validate membership only when set.
  if (state.effort != null && !EFFORT_LEVELS.includes(state.effort)) {
    errors.push(`effort must be one of ${EFFORT_LEVELS.join('|')}`)
  }
  return errors
}
