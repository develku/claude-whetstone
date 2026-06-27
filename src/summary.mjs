import { formatTrajectory } from './trajectory.mjs';
import { formatSpend } from './spend-format.mjs';

export function formatReport(state) {
  return summarizeRun(state) + '\n' + formatTrajectory(state);
}

export function summarizeRun(state) {
  const passes = state.history.length;
  // best_score is null on a baseline-error run — render '—' rather than 'best null @ pass 0'.
  const best = state.best_score == null ? '—' : `${state.best_score} @ pass ${state.best_pass}`;
  // ?? 0: a state.json written before token budgeting has no spent_tokens — render 0, not 'undefined'.
  const tokens = state.spent_tokens ?? 0;
  // Token-primary: on a subscription plan USD is only notional; tokens are the rate-limit currency (spend-format.mjs).
  let out = `${state.status.toUpperCase()} — best ${best}\n${passes} passes / cap ${state.hard_cap} · spent ${formatSpend({ tokens, costUsd: state.spent_usd })}`;
  if (state.escalated_at_pass != null) out += `\nescalated at pass ${state.escalated_at_pass}`;
  return out;
}
