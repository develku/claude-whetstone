// src/iso-execute.mjs
// The CHILD-side execution half of the isolated behavioural runner (#2). Each function imports the artifact's
// module (passed as `mod`), runs the contract, and snapshots every artifact-controlled value through
// canonicalData so the observation it returns is INERT plain data — no getter/toJSON/proxy/proto trick
// survives. The PARENT (the scorer) owns the oracle: it deep-equals / invariant-checks these observations in a
// clean process. Splitting EXECUTE (here, child) from JUDGE (parent) is what closes the import-capture hole —
// corrupting the child's assert/JSON is pointless because the comparison never happens in the child.
//
// A leaf module: only canonicalData (which captures ITS primordials at load). Imported by the locked-down
// child BEFORE the artifact, so its references stay clean. Observations use a small typed vocabulary:
//   { ok:true, ...payload }                         — executed; payload is mode-specific, all values inert
//   { ok:false, reason:'missing-export', name }     — named export absent (parent decides exit 2 vs score 0)
//   { ok:false, reason:'artifact', error }          — construction/method threw, or a non-JSON return
import { canonicalData } from './canonical-data.mjs'

// VOID-method normalization, used ONLY by io-trace: a method that returns nothing (push()) yields undefined,
// which JSON can't express — io-trace's documented contract maps it to null. The value-checking scorers
// (assert / effect returns / invariant) do NOT use this: for them a top-level `undefined` is an anomaly
// (a pure fn that returns nothing can never equal a JSON output), so canonicalData rejects it -> the case fails.
const voidToNull = (v) => (v === undefined ? null : canonicalData(v))

// assert: call mod[fn] once per case; INPUT is the arg LIST (scalar => one arg, array => spread).
export function executeAssert(mod, { fn, cases }) {
  const f = mod[fn]
  if (typeof f !== 'function') return { ok: false, reason: 'missing-export', name: fn }
  const results = []
  for (const input of cases) {
    const args = Array.isArray(input) ? input : [input]
    let got
    try { got = f(...args) } catch (e) { results.push({ threw: true, error: String(e && e.message || e) }); continue }
    // STRICT: undefined (and any non-JSON return) throws -> a failed case, never coerced to null.
    try { results.push({ value: canonicalData(got) }) } catch (e) { results.push({ threw: true, error: `return is not plain JSON data (${e.message})` }) }
  }
  return { ok: true, results }
}

// trace: construct a subject (class via newName | factory via factoryName), replay a method SEQUENCE, collect
// the per-step return values (snapshotted). End a trace with a getter step to assert final state.
export function executeTrace(mod, { newName, factoryName, init = [], steps }) {
  let subject
  if (newName) {
    const Ctor = mod[newName]
    if (typeof Ctor !== 'function') return { ok: false, reason: 'missing-export', name: newName }
    try { subject = new Ctor(...init) } catch (e) { return { ok: false, reason: 'artifact', error: `constructing ${newName} threw: ${e.message}` } }
  } else {
    const make = mod[factoryName]
    if (typeof make !== 'function') return { ok: false, reason: 'missing-export', name: factoryName }
    try { subject = make(...init) } catch (e) { return { ok: false, reason: 'artifact', error: `factory ${factoryName} threw: ${e.message}` } }
  }
  const returns = []
  for (const step of steps) {
    const [method, ...args] = step
    const fn = subject == null ? undefined : subject[method]
    if (typeof fn !== 'function') return { ok: false, reason: 'artifact', error: `subject has no method "${method}"` }
    let r
    try { r = fn.apply(subject, args) } catch (e) { return { ok: false, reason: 'artifact', error: e.message } }
    // io-trace uses voidToNull: a void method (push) returns undefined -> null, by documented contract.
    try { returns.push(voidToNull(r)) } catch (e) { return { ok: false, reason: 'artifact', error: `a return value is not plain JSON data (${e.message})` } }
  }
  return { ok: true, returns }
}

// effect: call fn(sink, ...args) per entry, mutating the carried first argument; report the post-call sink
// state and (only when the parent asked for them via `wantReturns`) the per-call returns. Returns are
// snapshotted STRICTLY — an undefined/non-JSON return when --expect-returns is given is an artifact failure,
// matching the prior contract; when returns aren't checked, a void fn's undefined return is simply ignored.
export function executeEffect(mod, { fn, sink, calls, wantReturns = false }) {
  const f = mod[fn]
  if (typeof f !== 'function') return { ok: false, reason: 'missing-export', name: fn }
  const returns = []
  for (const args of calls) {
    try { returns.push(f(sink, ...args)) } catch (e) { return { ok: false, reason: 'artifact', error: e.message } }
  }
  let finalSink, inertReturns = []
  try { finalSink = canonicalData(sink ?? null) } catch (e) { return { ok: false, reason: 'artifact', error: `sink is not plain JSON data after the call (${e.message})` } }
  if (wantReturns) {
    try { inertReturns = returns.map((r) => canonicalData(r)) } catch (e) { return { ok: false, reason: 'artifact', error: `a return value is not plain JSON data (${e.message})` } }
  }
  return { ok: true, returns: inertReturns, finalSink }
}

// invariant: call mod[fn](...argList) per case; report the snapshotted output and the POST-CALL live basis arg
// (so the parent can check input-unchanged). A throw / async return is flagged per-case (the parent fails it).
export function executeInvariants(mod, { fn, cases, basis = 0 }) {
  const f = mod[fn]
  if (typeof f !== 'function') return { ok: false, reason: 'missing-export', name: fn }
  const out = []
  for (const argList of cases) {
    let raw
    try { raw = f(...argList) } catch (e) { out.push({ threw: true, error: String(e && e.message || e) }); continue }
    if (raw != null && typeof raw.then === 'function') { raw.catch(() => {}); out.push({ promise: true }); continue }
    // STRICT: an undefined/non-JSON output fails its case (the invariants reject null/undefined the same way).
    try { out.push({ out: canonicalData(raw), basisLive: canonicalData(argList[basis] ?? null) }) } catch (e) { out.push({ threw: true, error: `not plain JSON data (${e.message})` }) }
  }
  return { ok: true, cases: out }
}
