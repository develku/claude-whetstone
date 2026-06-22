// The control flow of loop engineering. CODE runs this; the model only supplies
// edits (via `act`) and the scorer only supplies a number (via `evaluate`).
// Side effects (spawning Claude, running the scorer, writing files) are injected
// so this orchestrator stays pure-ish and unit-testable with stubs — no spend.
import { gateVerdict } from './gate.mjs'
import { restoreTarget } from './regression.mjs'

const noopReason = 'pass produced no artifact change (permission block? max-turns starvation?)'

// deps:
//   evaluate(state) -> { score, critique }       observe the real output + score it
//   act(state)      -> { changed, costUsd }      cheap editor: model edits the artifact using the last critique
//   actEscalated(state) -> { changed, costUsd }  OPTIONAL stronger editor, used ONLY after a plateau (spend Opus only when the cheap model is provably stuck)
//   persist(state, { score, critique, costUsd }) -> newState   snapshot + review + recordPass + save
//   escalationGrace                              passes the escalated editor gets before plateau is re-judged (default = plateau_window)
//   log(event)                                   progress sink
export async function runLoop({ state, evaluate, act, persist, log = () => {}, actEscalated = null, escalationGrace = null, restore = null }) {
  let currentAct = act
  let escalated = false
  let graceUntilPass = -1 // while pass < this, a plateau is ignored (give the escalated editor a fresh window)

  // Baseline: score the initial artifact before any edit (iter_000).
  let s = persist(state, await evaluate(state))
  let v = gateVerdict(s)
  log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })

  while (v.status === 'running') {
    const a = await currentAct(s)
    if (!a.changed) {
      // A no-op means the current editor gave up — that is exactly when to escalate,
      // not to error. Only error once the stronger editor has also been tried.
      if (actEscalated && !escalated) {
        escalated = true
        currentAct = actEscalated
        graceUntilPass = s.pass + (escalationGrace ?? s.plateau_window)
        s = { ...s, escalated: true, escalated_at_pass: s.pass }
        log({ pass: s.pass, score: s.current_score, best: s.best_score, status: 'running', reason: 'no-op — escalating to the stronger editor' })
        continue
      }
      v = { status: 'error', reason: noopReason }
      s = { ...s, status: 'error', status_reason: noopReason }
      break
    }
    s = persist(s, { ...(await evaluate(s)), costUsd: a.costUsd ?? 0 })

    const target = restoreTarget(s)
    if (target != null && restore != null) await restore(target)

    if (s.budget_usd != null && s.spent_usd > s.budget_usd) {
      v = { status: 'capped', reason: `budget $${s.budget_usd} exceeded (spent $${s.spent_usd.toFixed(2)})` }
      s = { ...s, status: 'capped', status_reason: v.reason }
      break
    }

    v = gateVerdict(s)

    if (v.status === 'plateau') {
      if (s.pass < graceUntilPass) {
        v = { status: 'running', reason: 'post-escalation grace window' }
      } else if (actEscalated && !escalated) {
        escalated = true
        currentAct = actEscalated
        graceUntilPass = s.pass + (escalationGrace ?? s.plateau_window)
        s = { ...s, escalated: true, escalated_at_pass: s.pass }
        v = { status: 'running', reason: `plateau at pass ${s.pass} — escalating to the stronger editor` }
      }
      // else: already escalated (or no escalation available) -> plateau stands, loop exits
    }

    log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })
  }

  if (s.status === 'running') s = { ...s, status: v.status, status_reason: v.reason }
  return { state: s, verdict: v }
}
