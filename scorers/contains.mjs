#!/usr/bin/env node
// Reference scorer (deterministic): score 100 if the produced output contains
// --needle, else 0. Trivial — useful for canary/validation runs of the act step.
//
// Contract: read --output/--needle, print {score, critique, findings} JSON to
// stdout, exit 0 on success, exit 2 on scorer error.
import { readFileSync } from 'node:fs'

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const die = (msg) => {
  process.stderr.write(`contains: ${msg}\n`)
  process.exit(2)
}

const needle = arg('--needle')
const output = arg('--output')
if (!needle) die('--needle <string> is required')
if (!output) die('--output <path> is required')

let text = ''
try {
  text = readFileSync(output, 'utf8')
} catch (e) {
  die(`cannot read output ${output}: ${e.message}`)
}

const has = text.includes(needle)
process.stdout.write(
  JSON.stringify({
    score: has ? 100 : 0,
    critique: has ? `output contains "${needle}"` : `the file must contain the text "${needle}" — add it`,
    findings: has ? [] : [{ area: 'content', severity: 'high', suggestion: `insert "${needle}"` }],
  }),
)
