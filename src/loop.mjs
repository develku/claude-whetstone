// The control flow of loop engineering. CODE runs this; the model only supplies
// edits (via `act`) and the scorer only supplies a number (via `evaluate`).
// Side effects (spawning Claude, running the scorer, writing files) are injected
// so this orchestrator stays pure-ish and unit-testable with stubs — no spend.
import { gateVerdict, validScore } from './gate.mjs'
import { restoreTarget } from './regression.mjs'

const noopReason = 'pass produced no artifact change (permission block? max-turns starvation?)'

// Budget is enforced in the loop, not the gate (the gate sees only scores). Every paid path —
// including a no-op that changed nothing — must check spend, so this lives in one helper.
const overBudgetVerdict = (s) =>
  s.budget_usd != null && s.spent_usd > s.budget_usd
    ? { status: 'capped', reason: `budget $${s.budget_usd} exceeded (spent $${s.spent_usd.toFixed(2)})` }
    : null

// deps:
//   evaluate(state) -> { score, critique }       observe the real output + score it
//   act(state)      -> { changed, costUsd }      cheap editor: model edits the artifact using the last critique
//   actEscalated(state) -> { changed, costUsd }  OPTIONAL stronger editor, used ONLY after a plateau (spend Opus only when the cheap model is provably stuck)
//   persist(state, { score, critique, costUsd }) -> newState   snapshot + review + recordPass + save
//   escalationGrace                              passes the escalated editor gets before plateau is re-judged (default = plateau_window)
//   log(event)                                   progress sink
export async function runLoop({ state, evaluate, act, persist, save = null, log = () => {}, actEscalated = null, escalationGrace = null, restore = null, confirm = null, noopThreshold = 2, skipBaseline = false }) {
  let currentAct = act
  let escalated = false
  let graceUntilPass = -1 // while pass < this, a plateau is ignored (give the escalated editor a fresh window)
  let consecutiveNoops = 0
  let s
  let v

  // done-branch confirmation: an independent confirm scorer re-scores ONLY when the gate would
  // declare done — cheap normal passes, expensive skepticism at the finish line. A confirm score
  // below target means the editor gamed the primary signal, so reject the done, keep going, and
  // steer the next edit with the confirm critique. The cap is RE-CHECKED here because the gate
  // hides it behind `done` while the primary stays >= target (else a vetoed done loops forever).
  async function confirmDone(st, vd) {
    if (vd.status !== 'done' || !confirm) return { s: st, v: vd }
    const c = await confirm(st)
    // The confirm score never flows through the gate, so guard it here to the same 0..100 invariant:
    // an out-of-range score must not confirm a gamed done, and a missing/NaN one must not silently
    // veto every pass to the cap. Either is a broken confirm scorer → halt with a clear error.
    if (!validScore(c.score)) {
      const reason = `confirm scorer returned an invalid score: ${String(c.score)} (need a number in 0..100)`
      return { s: { ...st, status: 'error', status_reason: reason }, v: { status: 'error', reason } }
    }
    if (c.score >= st.target_score) return { s: st, v: vd } // confirmed — done stands
    // Stamp the veto on the pass and persist it NOW: the on-disk state from the prior `persist` has a
    // primary score >= target, so a kill during the next (post-veto) editor spawn would otherwise make
    // --resume see `done` and refuse. The marker (== this pass) tells prepareResume it is still running.
    const ns = { ...st, last_critique: c.critique, confirm_vetoed_at_pass: st.pass }
    if (save) save(ns)
    const v2 =
      ns.pass >= ns.hard_cap
        ? { status: 'capped', reason: `cap ${ns.hard_cap} hit; primary met target but confirmation vetoed (score ${c.score} < ${ns.target_score})` }
        : { status: 'running', reason: `done vetoed by confirmation (score ${c.score} < target ${ns.target_score})` }
    return { s: ns, v: v2 }
  }

  // A side effect (scorer crash, editor spawn failure/timeout, maxBuffer overflow, disk error)
  // throws out of evaluate/act/persist. Convert it to a terminal status=error verdict so the run
  // returns a consistent state the caller can save — a later --resume sees the failure, not a
  // half-finished loop that rejected and skipped its final save.
  try {
    // Baseline: score the initial artifact before any edit (iter_000). On --resume the state
    // already carries a scored history and the live artifact is the best snapshot, so skip the
    // baseline and continue straight into the edit loop from the loaded state.
    s = skipBaseline ? state : persist(state, await evaluate(state))
    ;({ s, v } = await confirmDone(s, gateVerdict(s)))
    log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })

    while (v.status === 'running') {
      const a = await currentAct(s)
      if (!a.changed) {
        // A no-op still spent (the editor ran, returned cost, changed nothing). Charge it so a
        // sequence of paid no-ops can still trip --budget — otherwise the spend silently vanishes.
        s = { ...s, spent_usd: s.spent_usd + (a.costUsd ?? 0) }
        const overBudget = overBudgetVerdict(s)
        if (overBudget) {
          v = overBudget
          s = { ...s, status: 'capped', status_reason: overBudget.reason }
          break
        }
        consecutiveNoops++
        // Escalate only after N consecutive no-ops, not on the first.
        if (consecutiveNoops >= noopThreshold && actEscalated && !escalated) {
          escalated = true
          currentAct = actEscalated
          graceUntilPass = s.pass + (escalationGrace ?? s.plateau_window)
          s = { ...s, escalated: true, escalated_at_pass: s.pass }
          log({ pass: s.pass, score: s.current_score, best: s.best_score, status: 'running', reason: 'no-op — escalating to the stronger editor' })
          consecutiveNoops = 0
          continue
        }
        if (consecutiveNoops < noopThreshold) {
          log({ pass: s.pass, score: s.current_score, best: s.best_score, status: 'running', reason: `no-op (${consecutiveNoops}/${noopThreshold}) — retrying` })
          continue
        }
        v = { status: 'error', reason: noopReason }
        s = { ...s, status: 'error', status_reason: noopReason }
        break
      }
      consecutiveNoops = 0
      s = persist(s, { ...(await evaluate(s)), costUsd: a.costUsd ?? 0 })

      const target = restoreTarget(s)
      if (target != null && restore != null) await restore(target)

      ;({ s, v } = await confirmDone(s, gateVerdict(s)))

      // Budget cap AFTER the gate, so precedence holds (error > done > capped): a pass that meets
      // the target (done) or returns an invalid score (error) is NOT overridden by the budget cap.
      if (v.status !== 'done' && v.status !== 'error') {
        const overBudget = overBudgetVerdict(s)
        if (overBudget) {
          v = overBudget
          s = { ...s, status: 'capped', status_reason: overBudget.reason }
          break
        }
      }

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
  } catch (e) {
    const reason = `pass failed: ${e.message}`
    s = { ...(s ?? state), status: 'error', status_reason: reason }
    v = { status: 'error', reason }
  }

  if (s.status === 'running') s = { ...s, status: v.status, status_reason: v.reason }
  return { state: s, verdict: v }
}
