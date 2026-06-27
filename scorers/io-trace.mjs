#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL — STATEFUL). The generalization of io-assert beyond pure
// functions: where io-assert checks one IN=>OUT of an exported function, io-trace constructs a SUBJECT
// (a class instance via --new, or a factory's return via --factory) and replays a SEQUENCE of method calls
// (--trace), asserting the observed return values (--expect). This expresses behaviour that a single IN=>OUT
// cannot — "push then pop returns the pushed value", "two incs then read is 2" — and, like io-assert, it
// passes ANY correct implementation (array- or list-backed stack, closure- or class-based counter) and fails
// a gamed one. End a trace with a getter to assert FINAL STATE (no separate concept needed).
//
// Args are DATA only (JSON method/args/returns), never code, so it stays inside the Verifier Forge allowlist
// trust boundary. A 1-step trace IS io-assert's case; io-trace is the N-step superset for stateful surfaces.
//
// Contract: --output <path>; exactly one of --new <ClassExport> | --factory <fnExport>; optional
// --init '<JSON args>' (constructor/factory args); --trace '<JSON [[method,...args],...]>'; --expect
// '<JSON [returnValue,...]>'. Prints {score,critique,findings} JSON, exit 0; exit 2 on scorer error.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (msg) => { process.stderr.write(`io-trace: ${msg}\n`); process.exit(2) }

// Construct the subject, replay the call sequence, and deep-equal the observed returns against `expect`.
// Returns {pass} or {pass:false, failing}. Pure + exported (a test passes a fake module). Returns are
// JSON-normalized (undefined -> null) so a mutator that returns undefined compares against JSON `expect`.
export function evaluateTrace(mod, { newName, factoryName, init = [], steps, expect }) {
  let subject
  if (newName) {
    const Ctor = mod[newName]
    if (typeof Ctor !== 'function') return { pass: false, failing: { error: `artifact has no constructor export "${newName}"` } }
    try { subject = new Ctor(...init) } catch (e) { return { pass: false, failing: { error: `constructing ${newName} threw: ${e.message}` } } }
  } else {
    const make = mod[factoryName]
    if (typeof make !== 'function') return { pass: false, failing: { error: `artifact has no factory export "${factoryName}"` } }
    try { subject = make(...init) } catch (e) { return { pass: false, failing: { error: `factory ${factoryName} threw: ${e.message}` } } }
  }
  const returns = []
  for (const step of steps) {
    const [method, ...args] = step
    const fn = subject == null ? undefined : subject[method]
    if (typeof fn !== 'function') return { pass: false, failing: { step, error: `subject has no method "${method}"` } }
    try { returns.push(fn.apply(subject, args)) } catch (e) { return { pass: false, failing: { step, error: e.message } } }
  }
  const got = JSON.parse(JSON.stringify(returns)) // undefined -> null, DATA-comparable
  try { assert.deepEqual(got, expect) } catch { return { pass: false, failing: { expected: expect, got } } }
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

  let mod
  try { mod = await import(pathToFileURL(output).href) } catch (e) { die(`cannot import artifact ${output}: ${e.message}`) }

  const r = evaluateTrace(mod, { newName, factoryName, init, steps, expect })
  process.stdout.write(JSON.stringify({
    score: r.pass ? 100 : 0,
    critique: r.pass ? `all ${steps.length} trace steps behave as expected` : `behavioural trace failed: ${JSON.stringify(r.failing)}`,
    findings: [],
  }))
}
