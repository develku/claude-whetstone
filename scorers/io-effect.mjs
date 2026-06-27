#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL — SIDE EFFECT). The argument-mutation / IO-side-effect twin of
// io-trace: where io-trace asserts the RETURNS of a method sequence on a constructed subject, io-effect asserts
// the POST-CALL STATE of a carried mutable FIRST argument (the "sink") across a call sequence fn(sink, ...args).
// This expresses the surfaces whose CONTRACT is a side effect — an in-place mutation (sortInPlace(arr)), an
// accumulator/logger (logEvent(sink, evt) pushes to sink, tally(counts, k) increments counts[k]) — where the
// return is often undefined and io-trace (returns-only) cannot see the real work. A gamed impl that returns the
// right value but does NOT perform the mutation (or mutates wrongly) is caught here.
//
// Args are DATA only (JSON sink/calls/expected), never code, so it stays inside the Verifier Forge allowlist
// trust boundary. The sink is the FIRST argument to every call (the carried mutable input); this MVP convention
// covers target-first APIs (Object.assign-style, pushAll(target, items), logEvent(sink, evt), and a single-call
// in-place transform fn(sink) via --calls '[[]]'). In-memory effects only — external IO (files/network) is NOT
// DATA and is out of the DATA-only fence.
//
// Contract: --output <path> [--rel <file>] --fn <name> --sink '<JSON>' --calls '<JSON [[...args],...]>'
// --expect-sink '<JSON>' [--expect-returns '<JSON [...]>']. Prints {score,critique,findings} JSON, exit 0;
// score 100/0; exit 2 on SCORER error (missing flag, bad JSON, calls not an array of arrays, expect-returns
// length != calls length, un-importable artifact). A missing/wrong export or non-JSON artifact OUTPUT is an
// ARTIFACT failure -> score 0 (NOT exit 2).
//
// SECURITY (codex review): the artifact CONTROLS the sink object it mutates, so the post-call state must NOT be
// read via JSON.stringify — that invokes a user-controlled `toJSON`/getters, letting a gamed artifact attach
// `sink.toJSON = () => expectedSink` (or accessor properties) to FORGE the observed state and pass while the real
// state is wrong. We read the sink with canonicalData (src/canonical-data.mjs): a strict OWN-DATA-property walker
// that never invokes a getter/toJSON and rejects accessors, non-plain prototypes, symbols, BigInt, non-finite
// numbers, undefined, and cycles. An artifact-produced non-JSON sink is an ARTIFACT failure (score 0), never a
// crash. The walker is SHARED with io-trace's returns normalization (which uses {undefinedToNull:true} for void
// methods); io-effect's sink stays STRICT (default opts) — JSON input can never carry undefined.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'
import { canonicalData } from '../src/canonical-data.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (msg) => { process.stderr.write(`io-effect: ${msg}\n`); process.exit(2) }

// Re-export so existing importers (test/io-effect.test.mjs) keep resolving `canonicalData` from here.
export { canonicalData }

// Call fn(sink, ...args) for each entry in `calls`, mutating the carried `sink` in place, then strict-deep-equal
// the canonicalized post-call sink against `expectSink` (and, if given, the per-call returns against
// `expectReturns`). Returns {pass:true} or {pass:false, failing}. Pure + exported (a test passes a fake module).
export function evaluateEffect(mod, { fnName, sink, calls, expectSink, expectReturns }) {
  const fn = mod[fnName]
  if (typeof fn !== 'function') return { pass: false, failing: { error: `artifact has no exported function "${fnName}"` } }
  const returns = []
  for (const args of calls) {
    try { returns.push(fn(sink, ...args)) } catch (e) { return { pass: false, failing: { args, error: e.message } } }
  }
  let finalSink
  try { finalSink = canonicalData(sink ?? null) } catch (e) { return { pass: false, failing: { error: `sink is not plain JSON data after the call (${e.message})` } } }
  try { assert.deepEqual(finalSink, expectSink) } catch { return { pass: false, failing: { expectedSink: expectSink, gotSink: finalSink } } }
  if (expectReturns != null) {
    let got
    try { got = canonicalData(returns) } catch (e) { return { pass: false, failing: { error: `a return value is not plain JSON data (${e.message})` } } }
    try { assert.deepEqual(got, expectReturns) } catch { return { pass: false, failing: { expectedReturns: expectReturns, gotReturns: got } } }
  }
  return { pass: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output = arg('--output')
  const fnName = arg('--fn')
  if (!output) die('--output <path> is required')
  try { output = resolveOutput(output, arg('--rel')) } catch (e) { die(e.message) } // scope mode: --output root + --rel file
  if (!fnName) die('--fn <exported function name> is required')
  if (arg('--sink') === undefined) die("--sink '<JSON>' (the initial carried mutable value) is required")
  if (arg('--calls') === undefined) die("--calls '<JSON [[...args],...]>' is required")
  if (arg('--expect-sink') === undefined) die("--expect-sink '<JSON>' (the expected post-call sink state) is required")

  let sink, calls, expectSink, expectReturns
  try { sink = JSON.parse(arg('--sink')) } catch (e) { die(`bad --sink JSON: ${e.message}`) }
  try { calls = JSON.parse(arg('--calls')) } catch (e) { die(`bad --calls JSON: ${e.message}`) }
  try { expectSink = JSON.parse(arg('--expect-sink')) } catch (e) { die(`bad --expect-sink JSON: ${e.message}`) }
  if (arg('--expect-returns') !== undefined) {
    try { expectReturns = JSON.parse(arg('--expect-returns')) } catch (e) { die(`bad --expect-returns JSON: ${e.message}`) }
    if (!Array.isArray(expectReturns)) die('--expect-returns must be a JSON array of return values')
  }
  if (!Array.isArray(calls) || !calls.every(Array.isArray)) die('--calls must be a JSON array of [...args] arrays (a single call with no extra args is [[]])')
  if (expectReturns !== undefined && expectReturns.length !== calls.length) die(`--expect-returns length (${expectReturns.length}) must equal --calls length (${calls.length})`)

  let mod
  try { mod = await import(pathToFileURL(output).href) } catch (e) { die(`cannot import artifact ${output}: ${e.message}`) }

  const r = evaluateEffect(mod, { fnName, sink, calls, expectSink, expectReturns })
  process.stdout.write(JSON.stringify({
    score: r.pass ? 100 : 0,
    critique: r.pass ? `all ${calls.length} call(s) produce the expected side effect on the sink` : `side-effect mismatch: ${JSON.stringify(r.failing)}`,
    findings: [],
  }))
}
