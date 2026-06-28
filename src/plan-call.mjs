// Track A's ONE paid model call (spec §3.1, §10). realPlanCall runs a single-shot `claude -p` planning
// call, SIGKILL wall-clock-capped (mirrors makeClaudeAct's 10-min cap so a hung planner can't wedge an
// unattended run). spawn is INJECTED so the whole thing is $0-testable with a canned result. Reuses
// buildClaudeArgs + extractCost/extractTokens (token-primary spend; tokens are the subscription
// rate-limit currency). Returns { text, spentUsd, spentTokens }; the UNTRUSTED text goes straight to
// parsePlannerReply (never executed).
import { spawnSync } from 'node:child_process'
import { extractCost, extractTokens } from './act-claude.mjs'

// The planner is a single-shot JSON emitter that needs NO tools (all context is in the prompt). Build its
// own argv rather than reuse buildClaudeArgs: that helper forces `--permission-mode acceptEdits`, which
// would AUTO-ACCEPT any edit a deviant planner attempted. Here we OMIT --permission-mode (the DEFAULT
// mode): in headless `-p` there is no approver, so an edit/bash attempt is DENIED, not auto-accepted —
// a mechanical no-edit guarantee, not a prompt-discipline hope (power-review M1). --output-format json +
// --max-turns 1 mirror the editor; extractCost/extractTokens parse the same result.usage.
export function buildPlannerArgs({ prompt, model = null, mcpConfig = null, effort = null }) {
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1']
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config')
  return args
}

// The model's reply text lives in result.result (claude -p --output-format json). Fall back to raw stdout
// so parsePlannerReply's JSON-slicer can still recover a manifest from a non-result-wrapped reply.
export function extractPlannerText(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    const result = Array.isArray(parsed) ? parsed.find((e) => e?.type === 'result') : parsed
    const t = result?.result ?? result?.text
    return t != null ? String(t) : String(stdout ?? '')
  } catch {
    return String(stdout ?? '')
  }
}

// realPlanCall(prompt, opts) -> { text, spentUsd, spentTokens }. opts.spawn defaults to spawnSync (injected
// for tests). The planner is single-shot (--max-turns 1) and not expected to edit anything; it just emits
// the objectives JSON. A spawn error / timeout / non-zero exit throws (surfaced, never a silent $0 no-op).
export async function realPlanCall(prompt, {
  model = 'opus', claudeBin = 'claude', mcpConfig = null, effort = null,
  timeoutMs = 10 * 60 * 1000, spawn = spawnSync, cwd = undefined,
} = {}) {
  const args = buildPlannerArgs({ prompt, model, mcpConfig, effort })
  const res = spawn(claudeBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL', cwd })
  if (res.error) throw new Error(`planner ${claudeBin} failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`planner ${claudeBin} exited ${res.status}: ${String(res.stderr || res.stdout || '').slice(0, 300)}`)
  return { text: extractPlannerText(res.stdout), spentUsd: extractCost(res.stdout), spentTokens: extractTokens(res.stdout) }
}
