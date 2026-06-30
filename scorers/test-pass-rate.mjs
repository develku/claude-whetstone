#!/usr/bin/env node
// Reference scorer (deterministic): score = 100 * passed / (passed + failed),
// parsed from a test command's output. The most portable scorer — zero extra deps.
// Recognizes node:test (`ℹ pass N`) AND pytest (`N passed, N failed`, plus collection `N error`)
// output; node:test patterns are matched first so its behavior is unchanged. Teaching it another
// runner (jest, go test) = one more pattern pair in parseCounts() + failingNames().
//
// The critique carries the ASSERTION DETAIL (expected vs actual) of each failing
// test, not just its name — that diff IS the gradient the editor needs to climb.
//
// Contract (every whetstone scorer honors this): read --output/--target/--loop-dir/--pass,
// print {score, critique, findings} JSON to stdout, exit 0 on success, exit 2 on scorer error.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const arg = (name, def = undefined) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const die = (msg) => {
  process.stderr.write(`test-pass-rate: ${msg}\n`)
  process.exit(2)
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

// Narrow a test command to one test by name. The pattern is single-quoted so a test name with shell
// metacharacters can never inject — node's runner takes it as a literal regex. Exported for test.
export function quoteOnly(cmd, only) {
  return `${cmd} --test-name-pattern ${shq(only)}`
}

// The sub-gate a finding carries so decompose can fan out a child whose gate is "this one test passes".
// id is the scorer's own name (resolved against decompose's allowlist); args re-run THIS scorer with
// --only. Exported for test.
export function buildSubGateArgs(cmd, area) {
  return { id: 'test-pass-rate', args: ['--cmd', cmd, '--only', area] }
}

// node --test prints the per-failure DETAIL (AssertionError + expected vs actual)
// AFTER the "✖ failing tests:" marker, not before. Return that section — the diff
// is the gradient the editor needs — with the noisy stack frames stripped out.
// Exported so the extraction can be unit-tested without spawning a test run.
export function failureDetail(out) {
  const s = String(out)
  const i = s.search(/^\s*✖ failing tests:/m)
  if (i >= 0) {
    // node:test: the per-failure detail (AssertionError + expected vs actual) follows the marker
    return s
      .slice(i)
      .split('\n')
      .filter((l) => !/^\s+at\s/.test(l)) // drop stack-frame lines
      .join('\n')
      .trim()
  }
  // pytest: the failing expression (`>`), the error (`E `), and the FAILED summary line are the
  // gradient; surrounding source context and the pass/fail tally are noise.
  const py = s.split('\n').filter((l) => /^E\s/.test(l) || /^>\s/.test(l) || /^FAILED\s/.test(l))
  if (py.length) return py.join('\n').trim()
  // unknown runner: whole output, stack frames stripped
  return s
    .split('\n')
    .filter((l) => !/^\s+at\s/.test(l))
    .join('\n')
    .trim()
}

// Parse pass/fail counts from a test runner's output. node:test patterns are tried FIRST so the
// long-standing node:test behavior is byte-identical; pytest (and jest-ish "N passed/failed") is a
// fallback. Returns {pass, fail} or null when nothing parses. Exported for unit testing.
export function parseCounts(out) {
  const s = String(out)
  // node:test / TAP-ish: "ℹ pass N", "# pass N"
  const nPass = s.match(/(?:ℹ|#)\s*pass\s+(\d+)/i)
  const nFail = s.match(/(?:ℹ|#)\s*fail\s+(\d+)/i)
  if (nPass || nFail) return { pass: nPass ? Number(nPass[1]) : 0, fail: nFail ? Number(nFail[1]) : 0 }
  // pytest / jest summary: "2 failed, 98 passed in 1.27s"; collection "1 error" counts as a failure.
  const pPass = s.match(/(\d+) passed/)
  const pFail = s.match(/(\d+) failed/)
  const pErr = s.match(/(\d+) error(?:s|ed)?\b/)
  if (pPass || pFail || pErr) {
    return {
      pass: pPass ? Number(pPass[1]) : 0,
      fail: (pFail ? Number(pFail[1]) : 0) + (pErr ? Number(pErr[1]) : 0),
    }
  }
  return null
}

// Failing test names for the findings array. node:test "✖ <name>" lines first (unchanged); pytest
// "FAILED <nodeid>" as a fallback. Exported for unit testing.
export function failingNames(out) {
  const s = String(out)
  const mainBody = s.split(/^\s*✖ failing tests:/m)[0]
  const nodeNames = [...mainBody.matchAll(/^\s*✖\s+(.+?)(?:\s+\(\d|\s*$)/gm)].map((m) => m[1].trim()).slice(0, 10)
  if (nodeNames.length) return nodeNames
  return [...s.matchAll(/^FAILED\s+(\S+)/gm)].map((m) => m[1]).slice(0, 10)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = arg('--cmd')
  if (!cmd) die('--cmd "<test command>" is required')

  const only = arg('--only')
  const runCmd = only ? quoteOnly(cmd, only) : cmd
  const res = spawnSync(runCmd, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = `${res.stdout || ''}${res.stderr || ''}`

  const counts = parseCounts(out)
  if (!counts) die('could not parse pass/fail counts from the test output')

  const { pass, fail } = counts
  const total = pass + fail
  if (total === 0) die('test command reported zero tests')
  // A non-zero exit with ZERO reported failures is a contradiction: the run died for a reason the
  // counts don't reflect (a crash, a SIGKILL/timeout that printed partial all-pass output, a
  // coverage/lint gate, a collection abort). Scoring that 100 would let the loop declare victory on a
  // broken run. A non-zero exit WITH failures is normal (failing tests), so only this case errors.
  if (res.status !== 0 && fail === 0) {
    die(`test command exited ${res.status} but reported no failures — exit code contradicts the all-pass output: ${out.slice(-300)}`)
  }

  const score = Math.round((100 * pass) / total * 100) / 100
  const names = failingNames(out)
  const critique =
    fail === 0 ? `all ${total} tests pass` : `${fail}/${total} tests failing.\n${failureDetail(out)}`.slice(0, 3000)
  const findings = names.map((n) => ({ area: n, severity: 'high', suggestion: 'make this failing test pass', scorer: buildSubGateArgs(cmd, n) }))

  process.stdout.write(JSON.stringify({ score, critique, findings }))
}
