#!/usr/bin/env node
// A fake `claude -p --output-format json` for the act-claude REAL-SPAWN test. $0, no network, no auth.
// makeClaudeAct spawns claudeBin DIRECTLY (argv is `-p <prompt> --output-format json ...`), so this must be
// an executable script (shebang + +x). It ignores the prompt and is driven entirely by env vars, so a single
// fixture covers every editor exit shape the loop must handle:
//   WHET_FAKE_MODE   success (default) | max_turns | fatal | hang
//   WHET_FAKE_EDIT   absolute path to append to (simulates the model editing the artifact); omitted = no-op
//   WHET_FAKE_COST   total_cost_usd to report (default 0.01)
//   WHET_FAKE_FAIL_TIMES + WHET_FAKE_COUNTER   fail-then-succeed for the retry test: behave as 'fatal' for
//                    the first N invocations, then 'success'. Env is static per spawn, so the invocation
//                    count is persisted in the WHET_FAKE_COUNTER file across spawns.
// Emits the same [init, result] stream `claude -p --output-format json` produces so extractCost/extractTokens/
// editorExitDisposition/editorFailureReason all parse it exactly as they would the real CLI.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

let mode = process.env.WHET_FAKE_MODE || 'success'
const failTimes = Number(process.env.WHET_FAKE_FAIL_TIMES || 0)
if (failTimes > 0 && process.env.WHET_FAKE_COUNTER) {
  let n = 0
  try { n = Number(readFileSync(process.env.WHET_FAKE_COUNTER, 'utf8')) || 0 } catch { /* first invocation — no counter yet */ }
  writeFileSync(process.env.WHET_FAKE_COUNTER, String(n + 1))
  mode = n < failTimes ? 'fatal' : 'success'
}
if (mode === 'hang') {
  setInterval(() => {}, 1000) // stay alive past the caller's timeoutMs so spawn-editor's timeout kill fires
} else {
  if (process.env.WHET_FAKE_EDIT) appendFileSync(process.env.WHET_FAKE_EDIT, '\n// edited by fake claude\n')
  const cost = Number(process.env.WHET_FAKE_COST ?? 0.01)
  const result = {
    type: 'result',
    subtype: mode === 'max_turns' ? 'error_max_turns' : mode === 'fatal' ? 'error_during_execution' : 'success',
    is_error: mode === 'fatal',
    total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
    ...(mode === 'fatal' ? { api_error_status: 529, result: 'Overloaded' } : {}),
  }
  process.stdout.write(JSON.stringify([{ type: 'system', subtype: 'init' }, result]))
  process.exit(mode === 'success' ? 0 : 1) // max_turns + fatal both exit non-zero, like the real CLI
}
