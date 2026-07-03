import { formatTrajectory } from './trajectory.mjs';
import { formatSpend } from './spend-format.mjs';

export function formatReport(state) {
  return summarizeRun(state) + '\n' + formatTrajectory(state);
}

// The "converged too easily" thin-scorer suspicion signal (the autoresearch eval-evolution insight):
// an UNWIRED run (no --confirm-scorer, no --stability-runs) that reaches done in <=1 edit pass is
// evidence the SCORER may be thin — the done-edge paid zero skepticism and the artifact barely had to
// change. Wired runs stay quiet (stability/confirm already re-probed the done); >=2-edit runs stay
// quiet (convergence took real work). Code-owned fixed prose + numbers only — no model text, so the
// warning itself can never be a capture channel. Returns the warning line, or null.
export function thinScorerWarning(state) {
  if (state.status !== 'done') return null;
  if (state.confirm_scorer_cmd || (state.stability_runs ?? 1) > 1) return null;
  const editPasses = (state.history?.length ?? 0) - 1; // history includes the pass-0 baseline
  if (editPasses < 0 || editPasses > 1) return null;
  const advice = 'Consider --confirm-scorer or --stability-runs.';
  if (editPasses === 0) return `⚠ done at baseline — 0 edits; the scorer may not discriminate (or the goal was already met). ${advice}`;
  const margin = state.current_score - state.target_score;
  return `⚠ thin-scorer suspicion: done in 1 edit pass, margin +${margin}, no done-edge check wired. ${advice}`;
}

export function summarizeRun(state) {
  const passes = state.history.length;
  // best_score is null on a baseline-error run — render '—' rather than 'best null @ pass 0'.
  const best = state.best_score == null ? '—' : `${state.best_score} @ pass ${state.best_pass}`;
  // ?? 0: a state.json written before token budgeting has no spent_tokens — render 0, not 'undefined'.
  const tokens = state.spent_tokens ?? 0;
  // Token-primary: on a subscription plan USD is only notional; tokens are the rate-limit currency (spend-format.mjs).
  let out = `${state.status.toUpperCase()} — best ${best}\n${passes} passes / cap ${state.hard_cap} · spent ${formatSpend({ tokens, costUsd: state.spent_usd })}`;
  // Ladder runs (v1.6.0) carry per-rung provenance — name each climb ('pass 3 → opus, pass 6 → fable').
  // Older state.json files (single-jump era) have only escalated_at_pass; keep their historical line.
  if (state.escalations?.length) {
    const models = state.escalate_models ?? [];
    const rungs = state.escalations.map((e) => `pass ${e.pass} → ${models[e.rung - 1] ?? `rung ${e.rung}`}`).join(', ');
    out += `\nescalated at ${rungs}`;
  } else if (state.escalated_at_pass != null) out += `\nescalated at pass ${state.escalated_at_pass}`;
  const thin = thinScorerWarning(state);
  if (thin) out += `\n${thin}`;
  return out;
}
