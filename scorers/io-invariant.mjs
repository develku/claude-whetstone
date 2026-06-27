#!/usr/bin/env node
// Reference scorer (deterministic, BEHAVIOURAL — PROPERTY). The relaxation of io-assert for outputs that
// cannot be pinned to an EXACT value (non-deterministic ordering, input-dependent, large) but still obey a
// structural PROPERTY a gamed implementation violates. Where io-assert asserts f(input) === exactOutput,
// io-invariant asserts f(input) satisfies one or more NAMED invariants (AND-combined) — e.g. "sorted AND a
// permutation of the input" passes ANY correct sort and fails `return input` (not sorted) or a hardcoded
// constant (not a permutation of an arbitrary input).
//
// Args are DATA only (JSON), never code, so it stays inside the Verifier Forge allowlist trust boundary. The
// input arg list is SNAPSHOT before the call, so a destructive impl cannot mutate its argument to fake
// permutation/length/input-unchanged. It does NOT strengthen admit beyond pass-good/fail-the-observed-bad —
// an over-strong invariant that would falsely veto a FUTURE honest impl is the separately-deferred
// mutation-backed admit; the non-brittle ledger leg (pass an ALTERNATE honest impl) is the mitigation here.
//
// Contract: --output <root> [--rel <file>] --fn <name> --case '<JSON arg-list>' (repeatable, SPREAD like
// io-assert — a unary array fn is DOUBLE-wrapped, e.g. '[[3,1,2]]') --invariant '<name>[:<JSON param>]'
// (repeatable, ALL must hold) [--basis <argIndex>=0]. Prints {score,critique,findings} JSON, exit 0;
// score 100/0; exit 2 on SCORER error (unknown invariant, bad param, zero case/invariant, missing export,
// bad JSON). An applicable invariant the output VIOLATES is score 0 (admit then rejects a check that can't
// discriminate the right way).
import { pathToFileURL } from 'node:url'
import { resolveOutput } from '../src/safe-rel.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const allArgs = (name) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === name ? [...a, v] : a), [])
const die = (msg) => { process.stderr.write(`io-invariant: ${msg}\n`); process.exit(2) }

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x)
// Bounded, crash-proof value for a failing-case critique (cycles / BigInt / huge values must not turn a valid
// score-0 verdict into a scorer crash). Truncates and degrades to a placeholder instead of throwing.
const safe = (v) => { try { const s = JSON.stringify(v); return s == null ? String(v) : (s.length > 200 ? s.slice(0, 200) + '…' : s) } catch { return '<unserializable>' } }

// Stable string key for a JSON value (object keys sorted); THROWS on a non-JSON leaf (undefined, function,
// symbol, NaN/Infinity, BigInt) or a cycle. Used for multiset/uniqueness comparison and deep-equality without
// the under-specified "sort arbitrary JSON values" hazard. A throw inside an invariant makes that invariant
// FAIL (score 0), never a scorer crash — a gamed fn returning NaN/undefined is caught, not fatal.
export function canonicalKey(v, seen = new Set()) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return 'n:' + v }
  if (t === 'string') return 's:' + v
  if (t === 'boolean') return 'b:' + v
  if (t !== 'object') throw new Error(`non-JSON value: ${t}`) // undefined, function, symbol, bigint
  if (seen.has(v)) throw new Error('cyclic value')
  seen.add(v)
  const key = Array.isArray(v)
    ? '[' + v.map((e) => canonicalKey(e, seen)).join(',') + ']'
    : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalKey(v[k], seen)).join(',') + '}'
  seen.delete(v)
  return key
}

const counts = (arr) => { const m = new Map(); for (const e of arr) { const k = canonicalKey(e); m.set(k, (m.get(k) ?? 0) + 1) } return m }
const mapsEqual = (a, b) => a.size === b.size && [...a].every(([k, n]) => b.get(k) === n)

// Each check: (out, ctx) => boolean. ctx = {basis (pre-call snapshot of args[basis]), basisLive (post-call live
// arg, for input-unchanged), param}. Checks that read output values wrap canonicalKey so a non-JSON output FAILS.
const INVARIANTS = {
  sorted: { check: (out) => {
    if (!Array.isArray(out)) return false
    const allNum = out.every(isFiniteNum)
    const allStr = out.every((x) => typeof x === 'string')
    // Type gate BEFORE the length shortcut: rejects mixed/non-orderable types AND a single non-finite element
    // like [NaN] (which would otherwise pass vacuously). An empty array passes vacuously (both .every() true).
    if (!allNum && !allStr) return false
    for (let i = 1; i < out.length; i++) if (out[i - 1] > out[i]) return false
    return true
  } },
  'permutation-of-input': { check: (out, { basis }) => {
    if (!Array.isArray(out) || !Array.isArray(basis)) return false
    try { return mapsEqual(counts(out), counts(basis)) } catch { return false }
  } },
  'length-preserved': { check: (out, { basis }) => Array.isArray(out) && Array.isArray(basis) && out.length === basis.length },
  unique: { check: (out) => {
    if (!Array.isArray(out)) return false
    try { return counts(out).size === out.length } catch { return false }
  } },
  'in-range': { needsParam: true, check: (out, { param: [min, max] }) => {
    const vals = Array.isArray(out) ? out : [out]
    // empty output fails conservatively — nothing in range is not a positive signal
    return vals.length > 0 && vals.every((x) => isFiniteNum(x) && x >= min && x <= max)
  } },
  'input-unchanged': { check: (_out, { basis, basisLive }) => {
    try { return canonicalKey(basis) === canonicalKey(basisLive) } catch { return false }
  } },
}

// Validate the parsed invariant list — a malformed CHECK (unknown name, missing/bad param) is a SCORER error
// (exit 2 at the CLI), distinct from an artifact that merely violates an applicable invariant (score 0).
export function assertInvariants(invariants) {
  if (!invariants.length) throw new Error('at least one --invariant is required')
  for (const { name, param } of invariants) {
    const spec = INVARIANTS[name]
    if (!spec) throw new Error(`unknown invariant "${name}"`)
    if (spec.needsParam && (!Array.isArray(param) || param.length !== 2 || !param.every(isFiniteNum) || param[0] > param[1]))
      throw new Error(`invariant "${name}" needs a finite [min,max] param with min<=max`)
  }
}

// '<name>[:<JSON param>]' -> {name, param}. Splits on the FIRST colon (names have hyphens, never colons).
// A malformed JSON param throws (CLI -> exit 2). Exported for test.
export function parseInvariant(s) {
  const str = String(s)
  const i = str.indexOf(':')
  return i < 0 ? { name: str, param: undefined } : { name: str.slice(0, i), param: JSON.parse(str.slice(i + 1)) }
}

// Run every case through every invariant (AND). Each case's arg list is snapshot to JSON BEFORE the call so a
// destructive impl cannot fake input-referencing invariants. A throwing fn fails the case (score 0). Assumes
// invariants are already validated (assertInvariants). Pure + exported (a test passes a plain fn).
export function evaluateInvariants(fn, argLists, invariants, { basis = 0 } = {}) {
  for (const argList of argLists) {
    const snapshot = JSON.parse(JSON.stringify(argList)) // faithful: --case args are JSON
    let out
    try { out = fn(...argList) } catch (e) { return { pass: false, failing: { args: safe(snapshot), error: String(e?.message ?? e) } } }
    // io-invariant checks SYNCHRONOUS pure functions; an async fn returns a Promise we cannot property-check.
    // Fail with a clear reason and swallow the eventual rejection so it never surfaces as an unhandled rejection.
    if (out != null && typeof out.then === 'function') { out.catch(() => {}); return { pass: false, failing: { args: safe(snapshot), error: 'fn returned a Promise — io-invariant checks synchronous functions' } } }
    const ctx = { basis: snapshot[basis], basisLive: argList[basis] }
    for (const inv of invariants) {
      if (!INVARIANTS[inv.name].check(out, { ...ctx, param: inv.param })) {
        return { pass: false, failing: { invariant: inv.name, args: safe(snapshot), out: safe(out) } }
      }
    }
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
  try { cases = allArgs('--case').map((c) => JSON.parse(c)) } catch (e) { die(`bad --case JSON: ${e.message}`) }
  if (!cases.length) die('at least one --case <JSON arg-list> is required')
  if (!cases.every(Array.isArray)) die('each --case must be a JSON array (the argument LIST; a unary array fn is double-wrapped, e.g. [[3,1,2]])')

  let invariants
  try { invariants = allArgs('--invariant').map(parseInvariant) } catch (e) { die(`bad --invariant param JSON: ${e.message}`) }
  try { assertInvariants(invariants) } catch (e) { die(e.message) }

  const basisRaw = arg('--basis')
  const basis = basisRaw === undefined ? 0 : Number(basisRaw)
  if (!Number.isInteger(basis) || basis < 0) die('--basis must be a non-negative integer')

  let mod
  try { mod = await import(pathToFileURL(output).href) } catch (e) { die(`cannot import artifact ${output}: ${e.message}`) }
  const fn = mod[fnName]
  if (typeof fn !== 'function') die(`artifact does not export a function named "${fnName}"`)

  const r = evaluateInvariants(fn, cases, invariants, { basis })
  const names = invariants.map((i) => i.name).join(', ')
  process.stdout.write(JSON.stringify({
    score: r.pass ? 100 : 0,
    critique: r.pass ? `all ${cases.length} case(s) satisfy: ${names}` : `invariant failed: ${JSON.stringify(r.failing)}`,
    findings: [],
  }))
}
