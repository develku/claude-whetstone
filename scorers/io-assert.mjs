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
//
// ISOLATION (#2): the artifact is imported and called in a locked-down CHILD process (src/iso-runner.mjs); the
// child returns the INERT return value, and the oracle (assert.deepEqual) runs HERE in this clean process. The
// artifact can no longer monkeypatch the comparison, hijack stdout, or steal the result frame — it is the
// out-of-process boundary, not the data-only args, that makes this safe to import a model's code.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'
import { runIsolated, classifyObservation } from '../src/iso-runner.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const allArgs = (name) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === name ? [...a, v] : a), [])
const die = (msg) => { process.stderr.write(`io-assert: ${msg}\n`); process.exit(2) }

// Split 'IN=>OUT' into JSON-parsed input/output. Exported for test.
export function parseCase(s) {
  const i = String(s).indexOf('=>')
  if (i < 0) throw new Error(`bad --case (need INPUT=>OUTPUT): ${s}`)
  return { input: JSON.parse(s.slice(0, i)), output: JSON.parse(s.slice(i + 2)) }
}

// JUDGE (parent-side oracle): deep-equal each isolated, inert per-case result against its expected output.
// `results` is the child's per-case observation ({value} or {threw,error}); `cases` the parsed [{input,output}].
// A throwing case fails (the artifact erred on that input). Returns {pass} or {pass:false, failing}. Pure + exported.
export function judgeCases(results, cases) {
  for (let i = 0; i < cases.length; i++) {
    const r = results[i]
    if (!r || r.threw) return { pass: false, failing: { input: cases[i].input, error: r ? r.error : 'no result' } }
    try { assert.deepEqual(r.value, cases[i].output) } catch { return { pass: false, failing: { input: cases[i].input, expected: cases[i].output, got: r.value } } }
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

  const obs = runIsolated({ artifact: output, mode: 'assert', spec: { fn: fnName, cases: cases.map((c) => c.input) }, readRoot: arg('--output') })
  const c = classifyObservation(obs, { missingExportExits: true })
  if (c) {
    if (c.kind === 'scorer-error') die(c.message)
    process.stdout.write(JSON.stringify({ score: 0, critique: c.critique, findings: [] }))
  } else {
    const r = judgeCases(obs.results, cases)
    process.stdout.write(JSON.stringify({
      score: r.pass ? 100 : 0,
      critique: r.pass ? `all ${cases.length} behavioural cases pass` : `behavioural case failed: ${JSON.stringify(r.failing)}`,
      findings: [],
    }))
  }
}
