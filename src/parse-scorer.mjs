// Turn a scorer's spawnSync result into its {score,critique,findings} JSON, or throw a LOUD,
// actionable error. The bare `JSON.parse(res.stdout)` throws a cryptic "Unexpected end of JSON
// input" when a scorer exits 0 with empty stdout — the silent-no-op case (e.g. a scorer whose main
// guard failed to fire because it was launched via a symlink). This names the offending command, its
// exit code, and a snippet, so the failure points at the cause instead of a bare parser error.
// Fail loud, never cryptic. Callers keep their own res.error / non-zero-exit guards; this covers the
// exit-0-but-unusable-stdout gap those guards miss.
export function parseScorerJson(res, cmd) {
  const out = String(res?.stdout ?? '')
  if (!out.trim()) {
    throw new Error(
      `scorer produced no output (exit ${res?.status}) — expected JSON {score,critique}. ` +
        `Is it a valid whetstone scorer, or did its main guard fail to fire (e.g. launched via a symlink)?\n` +
        `  cmd: ${cmd}${res?.stderr ? `\n  stderr: ${String(res.stderr).slice(0, 500)}` : ''}`,
    )
  }
  try {
    return JSON.parse(out)
  } catch (e) {
    throw new Error(
      `scorer printed non-JSON output (exit ${res?.status}): ${e.message}\n  cmd: ${cmd}\n  output: ${out.slice(0, 300)}`,
    )
  }
}
