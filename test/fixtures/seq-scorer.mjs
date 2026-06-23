#!/usr/bin/env node
// Test-only scorer: returns the score for the current --pass from a --scores list
// (comma-separated), so a test can script an ARBITRARY trajectory including regressions
// (which the always-increasing scripted-scorer can't). Reads --output but ignores it.
const arg = (n) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const scores = (arg('--scores') || '').split(',').map(Number)
const pass = Number(arg('--pass') ?? 0)
const score = scores[pass] ?? scores[scores.length - 1]
process.stdout.write(JSON.stringify({ score, critique: `pass ${pass}`, findings: [] }))
