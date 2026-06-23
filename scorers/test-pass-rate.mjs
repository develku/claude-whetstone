#!/usr/bin/env node
// Reference scorer (deterministic): score = 100 * passed / (passed + failed),
// parsed from a test command's output. The most portable scorer — zero extra deps.
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

// node --test prints the per-failure DETAIL (AssertionError + expected vs actual)
// AFTER the "✖ failing tests:" marker, not before. Return that section — the diff
// is the gradient the editor needs — with the noisy stack frames stripped out.
// Exported so the extraction can be unit-tested without spawning a test run.
export function failureDetail(out) {
  const s = String(out)
  const i = s.search(/^\s*✖ failing tests:/m)
  const section = i >= 0 ? s.slice(i) : s
  return section
    .split('\n')
    .filter((l) => !/^\s+at\s/.test(l)) // drop stack-frame lines
    .join('\n')
    .trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = arg('--cmd')
  if (!cmd) die('--cmd "<test command>" is required')

  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = `${res.stdout || ''}${res.stderr || ''}`

  const passM = out.match(/(?:ℹ|#)\s*pass\s+(\d+)/i)
  const failM = out.match(/(?:ℹ|#)\s*fail\s+(\d+)/i)
  if (!passM && !failM) die('could not parse pass/fail counts from the test output')

  const pass = passM ? Number(passM[1]) : 0
  const fail = failM ? Number(failM[1]) : 0
  const total = pass + fail
  if (total === 0) die('test command reported zero tests')

  const score = Math.round((100 * pass) / total * 100) / 100
  const mainBody = out.split(/^\s*✖ failing tests:/m)[0]
  const names = [...mainBody.matchAll(/^\s*✖\s+(.+?)(?:\s+\(\d|\s*$)/gm)].map((m) => m[1].trim()).slice(0, 10)
  const critique =
    fail === 0 ? `all ${total} tests pass` : `${fail}/${total} tests failing.\n${failureDetail(out)}`.slice(0, 3000)
  const findings = names.map((n) => ({ area: n, severity: 'high', suggestion: 'make this failing test pass' }))

  process.stdout.write(JSON.stringify({ score, critique, findings }))
}
