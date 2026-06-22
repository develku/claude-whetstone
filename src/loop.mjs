// The control flow of loop engineering. CODE runs this; the model only supplies
// edits (via `act`) and the scorer only supplies a number (via `evaluate`).
// Side effects (spawning Claude, running the scorer, writing files) are injected
// so this orchestrator stays pure-ish and unit-testable with stubs — no spend.
import { gateVerdict } from './gate.mjs'

const noopReason = 'pass produced no artifact change (permission block? max-turns starvation?)'

// deps:
//   evaluate(state) -> { score, critique }       observe the real output + score it
//   act(state)      -> { changed, costUsd }      model edits the artifact using the last critique
//   persist(state, { score, critique, costUsd }) -> newState   snapshot + review + recordPass + save
//   log(event)                                   progress sink
export async function runLoop({ state, evaluate, act, persist, log = () => {} }) {
  // Baseline: score the initial artifact before any edit (iter_000).
  let s = persist(state, await evaluate(state))
  let v = gateVerdict(s)
  log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })

  while (v.status === 'running') {
    const a = await act(s)
    if (!a.changed) {
      v = { status: 'error', reason: noopReason }
      s = { ...s, status: 'error', status_reason: noopReason }
      break
    }
    s = persist(s, { ...(await evaluate(s)), costUsd: a.costUsd ?? 0 })

    if (s.budget_usd != null && s.spent_usd > s.budget_usd) {
      v = { status: 'capped', reason: `budget $${s.budget_usd} exceeded (spent $${s.spent_usd.toFixed(2)})` }
      s = { ...s, status: 'capped', status_reason: v.reason }
      break
    }

    v = gateVerdict(s)
    log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })
  }

  if (s.status === 'running') s = { ...s, status: v.status, status_reason: v.reason }
  return { state: s, verdict: v }
}
