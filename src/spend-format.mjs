// src/spend-format.mjs
// Token-primary spend formatting. On a SUBSCRIPTION (Max/Pro) plan total_cost_usd is only a notional
// API-equivalent price (see act-claude.mjs:36); tokens are the real rate-limit constraint, so tokens LEAD
// and USD trails in parens. The $ paren is DROPPED at zero cost — a $0 stub/ledger reads "1,234 tokens",
// not "1,234 tokens ($0.0000)" noise (a real subscription call always has a nonzero notional cost, so it
// keeps the $). Both fields are Number()-coerced so a stringy "0.5" formats instead of crashing on .toFixed,
// and garbage/missing degrades to 0 rather than NaN/undefined. Unit is the full word "tokens", not "tok".
export function formatSpend({ tokens = 0, costUsd = 0 } = {}) {
  const t = `${(Number(tokens) || 0).toLocaleString('en-US')} tokens`
  const c = Number(costUsd) || 0
  return c > 0 ? `${t} ($${c.toFixed(4)})` : t
}
