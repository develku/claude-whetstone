export function validateConfig(state) {
  const errors = []
  if (state.target_score < 0 || state.target_score > 100) {
    errors.push('target_score must be between 0 and 100')
  }
  if (state.hard_cap < 1) {
    errors.push('hard_cap must be at least 1')
  }
  if (!state.scorer_cmd) {
    errors.push('scorer_cmd is required')
  }
  return errors
}
