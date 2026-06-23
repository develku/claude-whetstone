// The pure half of --resume. Given a loaded state and the overrides the operator
// explicitly passed, produce the state to continue from — or refuse with an actionable
// reason. The GATE is the single source of truth for "can this run still progress?":
// rather than re-deriving the capped/done/plateau rules here, we apply the overrides
// and ask gateVerdict. If it does not say 'running', resuming would be a no-op, so we
// refuse. This keeps the one piece of judgment (continue/stop) owned by code, in one place.
import { gateVerdict } from './gate.mjs'
import { isoNow } from './state.mjs'

// Only these keys may be overridden on resume; everything else (history, best_score,
// spent_usd, snapshots) is carried forward untouched.
const OVERRIDABLE = ['hard_cap', 'budget_usd', 'target_score', 'model']

const HINTS = {
  done: 'the run already reached its target',
  capped: 'raise --cap (or --budget) above the current run',
  plateau: 'the editor is stuck — try a stronger --model or lower --target',
  error: 'the run ended in error; inspect state.json before resuming',
}

export function prepareResume(loadedState, overrides = {}) {
  const applied = {}
  for (const key of OVERRIDABLE) {
    if (overrides[key] !== undefined) applied[key] = overrides[key]
  }
  const next = {
    ...loadedState,
    ...applied,
    status: 'running',
    status_reason: null,
    escalated: false, // restart the editor ladder from the cheap model
    escalated_at_pass: null,
    updated_at: isoNow(),
  }

  const v = gateVerdict(next)
  if (v.status !== 'running') {
    const hint = HINTS[v.status]
    return { error: `cannot resume (${v.status}): ${v.reason}${hint ? ` — ${hint}` : ''}` }
  }
  // The budget cap is enforced in the loop, not the gate, so the gate cannot see it.
  // Guard it here too — otherwise resuming a budget-exhausted run would spend one paid
  // act() pass before re-capping. Raise --budget above what was already spent.
  if (next.budget_usd != null && next.spent_usd > next.budget_usd) {
    const spent = next.spent_usd.toFixed(2)
    return {
      error: `cannot resume (capped): budget $${next.budget_usd} already spent ($${spent}) — raise --budget above ${spent}`,
    }
  }
  return { state: next }
}
