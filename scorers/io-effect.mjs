#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL — SIDE EFFECT). The argument-mutation / IO-side-effect twin of
// io-trace: where io-trace asserts the RETURNS of a method sequence on a constructed subject, io-effect asserts
// the POST-CALL STATE of a carried mutable FIRST argument (the "sink") across a call sequence fn(sink, ...args).
// This expresses the surfaces whose CONTRACT is a side effect — an in-place mutation (sortInPlace(arr)), an
// accumulator/logger (logEvent(sink, evt) pushes to sink, tally(counts, k) increments counts[k]) — where the
// return is often undefined and io-trace (returns-only) cannot see the real work. A gamed impl that returns the
// right value but does NOT perform the mutation (or mutates wrongly) is caught here.
//
// Args are DATA only (JSON sink/calls/expected), never code; combined with out-of-process isolation (#2) this
// stays inside the Verifier Forge allowlist trust boundary. The sink is the FIRST argument to every call (the
// carried mutable input); this MVP convention covers target-first APIs (Object.assign-style, pushAll(target,
// items), logEvent(sink, evt), and a single-call in-place transform fn(sink) via --calls '[[]]'). In-memory
// effects only — external IO (files/network) is NOT DATA and is out of the DATA-only fence.
//
// Contract: --output <path> [--rel <file>] --fn <name> --sink '<JSON>' --calls '<JSON [[...args],...]>'
// --expect-sink '<JSON>' [--expect-returns '<JSON [...]>']. Prints {score,critique,findings} JSON, exit 0;
// score 100/0; exit 2 on SCORER error (missing flag, bad JSON, calls not an array of arrays, expect-returns
// length != calls length, un-importable artifact). A missing/wrong export or non-JSON artifact OUTPUT is an
// ARTIFACT failure -> score 0 (NOT exit 2).
//
// SECURITY (#2): the artifact CONTROLS the sink it mutates, so it runs the call sequence in a locked-down CHILD
// (src/iso-runner.mjs); the child reads the post-call sink with canonicalData — a strict OWN-DATA walker that
// never invokes a getter/toJSON and rejects accessors, non-plain prototypes, symbols, BigInt, non-finite,
// undefined, cycles — and returns INERT data. The oracle (assert.deepEqual vs --expect-sink/--expect-returns)
// then runs HERE in this clean process. So a gamed `sink.toJSON = () => expectedSink`, a getter forge, OR a
// child-side oracle monkeypatch all fail: the comparison is out of the artifact's reach.
import { isMainModule } from '../src/is-main.mjs'
import assert from 'node:assert/strict'
import { resolveOutput } from '../src/safe-rel.mjs'
import { runIsolated, classifyObservation } from '../src/iso-runner.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (msg) => { process.stderr.write(`io-effect: ${msg}\n`); process.exit(2) }

// JUDGE (parent-side oracle): strict-deep-equal the isolated, inert post-call sink against `expectSink` (and, if
// given, the per-call returns against `expectReturns`). `observation` is the child's {returns, finalSink}.
// Returns {pass:true} or {pass:false, failing}. Pure + exported (a test passes a fake observation).
export function judgeEffect({ returns, finalSink }, expectSink, expectReturns) {
  try { assert.deepEqual(finalSink, expectSink) } catch { return { pass: false, failing: { expectedSink: expectSink, gotSink: finalSink } } }
  if (expectReturns != null) {
    try { assert.deepEqual(returns, expectReturns) } catch { return { pass: false, failing: { expectedReturns: expectReturns, gotReturns: returns } } }
  }
  return { pass: true }
}

if (isMainModule(import.meta.url)) {
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

  const obs = runIsolated({ artifact: output, mode: 'effect', spec: { fn: fnName, sink, calls, wantReturns: expectReturns !== undefined }, readRoot: arg('--output') })
  const c = classifyObservation(obs) // effect: a missing export / mutation throw is a score-0 verdict
  if (c) {
    if (c.kind === 'scorer-error') die(c.message)
    process.stdout.write(JSON.stringify({ score: 0, critique: c.critique, findings: [] }))
  } else {
    const r = judgeEffect(obs, expectSink, expectReturns)
    process.stdout.write(JSON.stringify({
      score: r.pass ? 100 : 0,
      critique: r.pass ? `all ${calls.length} call(s) produce the expected side effect on the sink` : `side-effect mismatch: ${JSON.stringify(r.failing)}`,
      findings: [],
    }))
  }
}
