// The ACT step: the only place the model touches the artifact. It is isolated
// here on purpose — this is the costly, environment-sensitive part the spike
// exists to measure (headless `claude -p` spend, auth, and whether the nested
// edit is actually permitted). The loop treats it as a black box returning
// { changed, costUsd }; everything else stays testable with a stub.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const hashFile = (p) => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

function extractCost(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    // --output-format json may be a single result object or a stream array.
    const result = Array.isArray(parsed) ? parsed.find((e) => e?.type === 'result') : parsed
    return Number(result?.total_cost_usd ?? result?.cost_usd ?? 0) || 0
  } catch {
    return 0
  }
}

// opts: { artifactPath, maxTurns, model, claudeBin, mcpConfig }
// mcpConfig: path to an empty/whitelist MCP config to suppress the per-spawn
// context tax (loading every MCP server). Strongly recommended for cost control.
export function makeClaudeAct({ artifactPath, maxTurns = 12, model = null, claudeBin = 'claude', mcpConfig = null } = {}) {
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

    const res = spawnSync(claudeBin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (res.error) throw new Error(`failed to spawn ${claudeBin}: ${res.error.message}`)

    const after = hashFile(artifactPath)
    return { changed: before !== after, costUsd: extractCost(res.stdout) }
  }
}
