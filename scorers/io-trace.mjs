#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL — STATEFUL). The generalization of io-assert beyond pure
// functions: where io-assert checks one IN=>OUT of an exported function, io-trace constructs a SUBJECT
// (a class instance via --new, or a factory's return via --factory) and replays a SEQUENCE of method calls
// (--trace), asserting the observed return values (--expect). This expresses behaviour that a single IN=>OUT
// cannot — "push then pop returns the pushed value", "two incs then read is 2" — and, like io-assert, it
// passes ANY correct implementation (array- or list-backed stack, closure- or class-based counter) and fails
// a gamed one. End a trace with a getter to assert FINAL STATE (no separate concept needed).
//
// Args are DATA only (JSON method/args/returns), never code; combined with out-of-process isolation (#2) this
// stays inside the Verifier Forge allowlist trust boundary. A 1-step trace IS io-assert's case; io-trace is the
// N-step superset for stateful surfaces.
//
// ISOLATION (#2): the subject is constructed and the method sequence replayed in a locked-down CHILD process
// (src/iso-runner.mjs), which returns the INERT, canonicalData-snapshotted per-step returns; the oracle
// (assert.deepEqual vs --expect) runs HERE in this clean process the artifact can't reach.
//
// Contract: --output <path>; exactly one of --new <ClassExport> | --factory <fnExport>; optional
// --init '<JSON args>' (constructor/factory args); --trace '<JSON [[method,...args],...]>'; --expect
// '<JSON [returnValue,...]>'. Prints {score,critique,findings} JSON, exit 0; exit 2 on scorer error.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'
import { runIsolated, classifyObservation } from '../src/iso-runner.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (msg) => { process.stderr.write(`io-trace: ${msg}\n`); process.exit(2) }

// JUDGE (parent-side oracle): deep-equal the isolated, inert per-step returns against `expect`. The returns are
// already JSON-normalized by the child (undefined -> null), so a mutator returning undefined compares against
// JSON `expect`. Returns {pass} or {pass:false, failing}. Pure + exported (a test passes a fake observation).
export function judgeTrace(returns, expect) {
  try { assert.deepEqual(returns, expect) } catch { return { pass: false, failing: { expected: expect, got: returns } } }
  return { pass: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output = arg('--output')
  const newName = arg('--new')
  const factoryName = arg('--factory')
  if (!output) die('--output <path> is required')
  try { output = resolveOutput(output, arg('--rel')) } catch (e) { die(e.message) } // scope mode: --output root + --rel file
  if (!newName && !factoryName) die('one of --new <ClassExport> or --factory <fnExport> is required')
  if (newName && factoryName) die('pass only one of --new / --factory')
  let init = []
  let steps
  let expect
  try { if (arg('--init') !== undefined) init = JSON.parse(arg('--init')) } catch (e) { die(`bad --init JSON: ${e.message}`) }
  try { steps = JSON.parse(arg('--trace') ?? '') } catch (e) { die(`bad --trace JSON: ${e.message}`) }
  try { expect = JSON.parse(arg('--expect') ?? '') } catch (e) { die(`bad --expect JSON: ${e.message}`) }
  if (!Array.isArray(steps) || !steps.every(Array.isArray)) die('--trace must be a JSON array of [method, ...args] steps')
  if (!Array.isArray(expect)) die('--expect must be a JSON array of return values')
  if (!Array.isArray(init)) die('--init must be a JSON array of arguments')

  const obs = runIsolated({ artifact: output, mode: 'trace', spec: { newName, factoryName, init, steps }, readRoot: arg('--output') })
  const c = classifyObservation(obs) // trace: a missing export / construction failure is a score-0 verdict
  if (c) {
    if (c.kind === 'scorer-error') die(c.message)
    process.stdout.write(JSON.stringify({ score: 0, critique: c.critique, findings: [] }))
  } else {
    const r = judgeTrace(obs.returns, expect)
    process.stdout.write(JSON.stringify({
      score: r.pass ? 100 : 0,
      critique: r.pass ? `all ${steps.length} trace steps behave as expected` : `behavioural trace failed: ${JSON.stringify(r.failing)}`,
      findings: [],
    }))
  }
}
