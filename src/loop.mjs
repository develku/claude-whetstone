// The control flow of loop engineering. CODE runs this; the model only supplies
// edits (via `act`) and the scorer only supplies a number (via `evaluate`).
// Side effects (spawning Claude, running the scorer, writing files) are injected
// so this orchestrator stays pure-ish and unit-testable with stubs — no spend.
import { gateVerdict, validScore } from './gate.mjs'
import { restoreTarget } from './regression.mjs'

const noopReason = 'pass produced no artifact change (permission block? max-turns starvation?)'

// Budget is enforced in the loop, not the gate (the gate sees only scores). Every paid path —
// including a no-op that changed nothing — must check spend, so this lives in one helper. Two
// parallel dials: --budget (USD, the real charge on API-key auth) and --budget-tokens (the real
// constraint on a subscription/Max plan, where USD is only notional). Either one tripping caps the run.
const overBudgetVerdict = (s) => {
  if (s.budget_usd != null && s.spent_usd > s.budget_usd)
    return { status: 'capped', reason: `budget $${s.budget_usd} exceeded (spent $${s.spent_usd.toFixed(2)})` }
  if (s.budget_tokens != null && (s.spent_tokens ?? 0) > s.budget_tokens)
    return { status: 'capped', reason: `token budget ${s.budget_tokens} exceeded (spent ${s.spent_tokens})` }
  return null
}

// deps:
//   evaluate(state) -> { score, critique }       observe the real output + score it
//   act(state)      -> { changed, costUsd }      cheap editor: model edits the artifact using the last critique
//   actEscalated(state) -> { changed, costUsd }  OPTIONAL stronger editor(s), used ONLY after a plateau (spend the pricier
//                                                model only when the cheaper one is provably stuck). A single fn or an
//                                                ORDERED ARRAY (ladder, e.g. opus then fable): each proven stall climbs
//                                                ONE rung; a stall after the last rung stands.
//   persist(state, { score, critique, costUsd }) -> newState   snapshot + review + recordPass + save
//   escalationGrace                              passes each escalated editor gets before plateau is re-judged (default = plateau_window)
//   log(event)                                   progress sink
export async function runLoop({ state, evaluate, act, persist, save = null, log = () => {}, actEscalated = null, escalationGrace = null, restore = null, confirm = null, noopThreshold = 2, skipBaseline = false }) {
  // A single escalated act is a one-rung ladder, so the historical single-jump behavior is unchanged.
  const rungs = Array.isArray(actEscalated) ? actEscalated.filter(Boolean) : actEscalated ? [actEscalated] : []
  let currentAct = act
  let rung = 0 // rungs consumed so far; the run is escalated once rung > 0
  let graceUntilPass = -1 // while pass < this, a plateau is ignored (give the escalated editor a fresh window)
  let consecutiveNoops = 0
  let s
  let v

  // Climb one rung of the escalation ladder: swap in the next stronger editor, open a fresh grace
  // window, and stamp the climb on the state — escalations is the full per-rung provenance,
  // escalated_at_pass stays the latest climb (the historical single-jump field).
  const climb = (st) => {
    currentAct = rungs[rung]
    rung++
    graceUntilPass = st.pass + (escalationGrace ?? st.plateau_window)
    return { ...st, escalated: true, escalated_at_pass: st.pass, escalations: [...(st.escalations ?? []), { pass: st.pass, rung }] }
  }

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
    // veto_source records WHICH check vetoed (here: 'confirm' = a held-out scorer caught gaming). It is the
    // PROVENANCE of the LAST veto stamp (written with confirm_vetoed_at_pass, shares its set-at-veto/never-
    // cleared lifecycle), NOT a live "currently vetoed" status — read it only as "the marker was last written
    // by X". Record-only today (no gate/resume path reads it); a future consumer needs its own design review.
    // (RECORD-ONLY, provenance-not-status.)
    const ns = { ...st, last_critique: c.critique, confirm_vetoed_at_pass: st.pass, veto_source: 'confirm' }
    if (save) save(ns)
    const v2 =
      ns.pass >= ns.hard_cap
        ? { status: 'capped', reason: `cap ${ns.hard_cap} hit; primary met target but confirmation vetoed (score ${c.score} < ${ns.target_score})` }
        : { status: 'running', reason: `done vetoed by confirmation (score ${c.score} < target ${ns.target_score})` }
    return { s: ns, v: v2 }
  }

  // Done-edge stability re-measurement (the Confidence Gate): when the gate would declare done, re-run
  // the PRIMARY scorer (state.stability_runs total readings incl. the triggering one) and require the
  // WEAKEST >= target — a flaky scorer that spiked to target on ONE pass does not finish on luck. Only
  // catches scorers nondeterministic on repeated identical runs (real flaky tests), and only probabilistically
  // (min-of-K); K is the operator's dial. Re-runs the scorer (cheap, not model spend) only at the done-edge.
  // Each probe re-runs the FULL evaluate pipeline — incl. observe_cmd if set — so it measures the whole
  // observe->score path's reproducibility, not just the scorer. K=1 (default) => no re-runs => unchanged.
  async function stabilityCheck(st, vd) {
    if (vd.status !== 'done' || (st.stability_runs ?? 1) <= 1) return { s: st, v: vd }
    let min = st.current_score
    for (let i = 1; i < st.stability_runs; i++) {
      const { score } = await evaluate(st)
      // Guard the probe to the same 0..100 invariant the gate enforces: an out-of-range/NaN re-measurement
      // must never confirm a (flaky) done, nor silently veto to the cap — a broken scorer halts with error.
      if (!validScore(score)) {
        const reason = `stability re-measurement returned an invalid score: ${String(score)} (need a number in 0..100)`
        return { s: { ...st, status: 'error', status_reason: reason }, v: { status: 'error', reason } }
      }
      if (score < min) min = score
    }
    if (min >= st.target_score) return { s: st, v: vd } // every reading clears target — done stands
    // Veto like confirmDone: reuse the SAME done-edge marker so a kill during the next editor spawn is
    // not mistaken for done on --resume (prepareResume treats confirm_vetoed_at_pass == pass as running).
    const critique = `score not reproducible: min ${min} over ${st.stability_runs} runs is below target ${st.target_score} — make the solution deterministic, not luck-dependent`
    // veto_source: 'stability' = a flaky/non-reproducible primary (NOT gaming). Same provenance semantics as the
    // confirm site (last-write provenance, not live status). See the confirmDone comment.
    const ns = { ...st, last_critique: critique, confirm_vetoed_at_pass: st.pass, veto_source: 'stability' }
    if (save) save(ns)
    const v2 =
      ns.pass >= ns.hard_cap
        ? { status: 'capped', reason: `cap ${ns.hard_cap} hit; primary met target but stability vetoed (min ${min} < ${ns.target_score})` }
        : { status: 'running', reason: `done vetoed by stability (min ${min} < target ${ns.target_score} over ${ns.stability_runs} runs)` }
    return { s: ns, v: v2 }
  }

  // The done-edge: first re-measure the primary for reproducibility (stability), THEN re-score with the
  // held-out confirm scorer. Either vetoes a gate `done`; both reuse the same veto marker. Stability runs
  // first so a flaky primary is rejected before paying for a confirm run.
  async function verifyDone(st, vd) {
    const stable = await stabilityCheck(st, vd)
    if (stable.v.status !== 'done') return stable
    return confirmDone(stable.s, stable.v)
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
    ;({ s, v } = await verifyDone(s, gateVerdict(s)))
    log({ pass: s.pass, score: s.current_score, best: s.best_score, ...v })

    while (v.status === 'running') {
      const a = await currentAct(s)
      if (!a.changed) {
        // A no-op still spent (the editor ran, returned cost, changed nothing). Charge BOTH dials so a
        // sequence of paid no-ops can still trip --budget / --budget-tokens — otherwise spend vanishes.
        s = { ...s, spent_usd: s.spent_usd + (a.costUsd ?? 0), spent_tokens: (s.spent_tokens ?? 0) + (a.tokens ?? 0) }
        const overBudget = overBudgetVerdict(s)
        if (overBudget) {
          v = overBudget
          s = { ...s, status: 'capped', status_reason: overBudget.reason }
          break
        }
        consecutiveNoops++
        // Escalate only after N consecutive no-ops, not on the first — one rung per proven stall.
        if (consecutiveNoops >= noopThreshold && rung < rungs.length) {
          s = climb(s)
          log({ pass: s.pass, score: s.current_score, best: s.best_score, status: 'running', reason: `no-op — escalating to the stronger editor (rung ${rung}/${rungs.length})` })
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
      s = persist(s, { ...(await evaluate(s)), costUsd: a.costUsd ?? 0, tokens: a.tokens ?? 0 })

      const target = restoreTarget(s)
      if (target != null && restore != null) await restore(target)

      ;({ s, v } = await verifyDone(s, gateVerdict(s)))

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
        } else if (rung < rungs.length) {
          s = climb(s)
          v = { status: 'running', reason: `plateau at pass ${s.pass} — escalating to the stronger editor (rung ${rung}/${rungs.length})` }
        }
        // else: ladder exhausted (or no escalation available) -> plateau stands, loop exits
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
