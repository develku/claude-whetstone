#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL): score 100 iff the artifact's exported <fn> returns the
// expected output for EVERY --case 'JSON_INPUT=>JSON_OUTPUT'. Unlike `contains` (which fossilizes one
// textual phrasing and so wrongly rejects equally-correct alternate implementations), this checks BEHAVIOUR
// — it passes any correct implementation and fails a gamed one. Args are DATA only (JSON in/out), never
// code, so it stays inside the Verifier Forge allowlist trust boundary.
//
// A --case is 'JSON_INPUT=>JSON_OUTPUT'; INPUT is the argument list (a scalar is one arg, a JSON array is
// spread: '[a,b]=>c' means f(a,b)===c). Contract: read --output/--fn/--case (repeatable), print
// {score, critique, findings} JSON, exit 0; exit 2 on scorer error (missing export, bad case, bad import).
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const allArgs = (name) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === name ? [...a, v] : a), [])
const die = (msg) => { process.stderr.write(`io-assert: ${msg}\n`); process.exit(2) }

// Split 'IN=>OUT' into JSON-parsed input/output. Exported for test.
export function parseCase(s) {
  const i = String(s).indexOf('=>')
  if (i < 0) throw new Error(`bad --case (need INPUT=>OUTPUT): ${s}`)
  return { input: JSON.parse(s.slice(0, i)), output: JSON.parse(s.slice(i + 2)) }
}

// Run fn against each case and return {pass} or {pass:false, failing}. The case INPUT is the argument LIST:
// a bare scalar is one argument, a JSON array is SPREAD (so '[a,b]=>c' means f(a,b) === c). Pure + exported.
export function evaluateCases(fn, cases) {
  for (const c of cases) {
    const args = Array.isArray(c.input) ? c.input : [c.input]
    let got
    try { got = fn(...args) } catch (e) { return { pass: false, failing: { input: c.input, error: e.message } } }
    try { assert.deepEqual(got, c.output) } catch { return { pass: false, failing: { input: c.input, expected: c.output, got } } }
  }
  return { pass: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output = arg('--output')
  const fnName = arg('--fn')
  if (!output) die('--output <path> is required')
  try { output = resolveOutput(output, arg('--rel')) } catch (e) { die(e.message) } // scope mode: --output root + --rel file
  if (!fnName) die('--fn <exported function name> is required')
  let cases
  try { cases = allArgs('--case').map(parseCase) } catch (e) { die(e.message) }
  if (!cases.length) die('at least one --case INPUT=>OUTPUT is required')

  let mod
  try { mod = await import(pathToFileURL(output).href) } catch (e) { die(`cannot import artifact ${output}: ${e.message}`) }
  const fn = mod[fnName]
  if (typeof fn !== 'function') die(`artifact does not export a function named "${fnName}"`)

  const r = evaluateCases(fn, cases)
  process.stdout.write(JSON.stringify({
    score: r.pass ? 100 : 0,
    critique: r.pass ? `all ${cases.length} behavioural cases pass` : `behavioural case failed: ${JSON.stringify(r.failing)}`,
    findings: [],
  }))
}
