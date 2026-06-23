// The ACT step: the only place the model touches the artifact. It is isolated
// here on purpose — this is the costly, environment-sensitive part the spike
// exists to measure (headless `claude -p` spend, auth, and whether the nested
// edit is actually permitted). The loop treats it as a black box returning
// { changed, costUsd }; everything else stays testable with a stub.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

const hashFile = (p) => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

// Parse the per-call cost from `claude -p --output-format json`. Best-effort: unparseable or
// cost-less output reads as 0 — a pass with no readable cost does not freeze the budget because
// --cap is the hard backstop (the README requires pairing --budget with --cap). Exported for test.
export function extractCost(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    // --output-format json may be a single result object or a stream array.
    const result = Array.isArray(parsed) ? parsed.find((e) => e?.type === 'result') : parsed
    return Number(result?.total_cost_usd ?? result?.cost_usd ?? 0) || 0
  } catch {
    return 0
  }
}

// opts: { artifactPath, maxTurns, model, claudeBin, mcpConfig, timeoutMs }
// mcpConfig: path to an empty/whitelist MCP config to suppress the per-spawn
// context tax (loading every MCP server). Strongly recommended for cost control.
// timeoutMs: hard wall-clock cap so a hung/stalled editor can't wedge an unattended
// loop forever (and keep a paid session open). Default 10 min.
export function makeClaudeAct({ artifactPath, maxTurns = 12, model = null, claudeBin = 'claude', mcpConfig = null, timeoutMs = 10 * 60 * 1000 } = {}) {
  return async (state) => {
    const before = hashFile(artifactPath)
    const critique = state.last_critique || 'Improve the artifact toward the goal.'
    const prompt = [
      `You are ONE iteration of an automated refinement loop. Goal: ${state.goal}`,
      '',
      `Make the SINGLE highest-impact edit to the file at ${artifactPath} that addresses this critique — and nothing else:`,
      '',
      critique,
      '',
      `Rules: edit ONLY ${artifactPath}. Make one coherent change. Do not run tests, do not explain, do not bundle unrelated work.`,
    ].join('\n')

    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', String(maxTurns)]
    if (model) args.push('--model', model)
    if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config')

    // Run in the artifact's own directory so the nested edit inherits THAT project's
    // config — not whatever cwd the driver was launched from. (A driver launched inside
    // another project's session would otherwise hand the child a restrictive deny layer
    // that silently blocks the edit; validated 2026-06-22.)
    const res = spawnSync(claudeBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: dirname(artifactPath), timeout: timeoutMs, killSignal: 'SIGKILL' })
    // res.error is set on spawn failure, timeout (ETIMEDOUT), or maxBuffer overflow. Surface the
    // code so the loop's error handler records an actionable reason instead of a silent hang.
    if (res.error) throw new Error(`editor ${claudeBin} failed (${res.error.code || res.error.message})`)

    const after = hashFile(artifactPath)
    return { changed: before !== after, costUsd: extractCost(res.stdout) }
  }
}
