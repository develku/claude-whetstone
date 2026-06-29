// src/canonical-data.mjs
// Strict own-DATA-property walker shared by the DATA-only scorers (io-effect's sink, io-trace's returns). The
// artifact under test CONTROLS the objects it produces, so the observed value must NOT be read via JSON.stringify
// — that invokes a user-controlled `toJSON`/getters, letting a gamed artifact attach `x.toJSON = () => expected`
// (or accessor properties) to FORGE the observed value and pass a behavioural check while the real value is wrong.
// This walker NEVER invokes a getter or toJSON: it reads OWN DATA DESCRIPTORS directly (objects AND array
// indices) and rejects accessors, non-plain prototypes (class instance / Map / Set / Date), symbol-keyed own
// props, Proxies, functions (incl. a toJSON data property — rejected, never called), BigInt, symbol, non-finite
// numbers, undefined, and cycles. A rejection means the artifact produced non-JSON / forge-shaped data → the
// caller treats it as an ARTIFACT failure (score 0), never a scorer crash.
//
// Hardening (codex review, 2026-06-28): (a) primordials are CAPTURED at module load — this module is imported
// before any artifact is — so a gamed artifact that patches `Object.getOwnPropertyDescriptor`/`Array.isArray`/
// etc. AFTER loading cannot subvert the walker; (b) the array branch reads own descriptors too (a getter at an
// index `Object.defineProperty(a,'0',{get})` is rejected, not invoked); (c) Proxies are rejected up front
// (reflection on a proxy invokes its traps); (d) output props are built with defineProperty so a `__proto__`
// key becomes a data prop, not prototype pollution. EXECUTION isolation (a separate concern) is now provided by
// src/iso-runner.mjs (#2): the io-* scorers import & run the artifact in a locked-down CHILD process, and call
// THIS walker IN that child to reduce each artifact-controlled value to INERT data before it crosses the
// process boundary back to the parent's oracle. So this module governs how a value is READ (no getter/toJSON),
// and the iso-runner governs WHERE the artifact runs (out of the oracle's process) — together they close the
// import-capture hole. (canonicalData captures its primordials at load, so it stays sound even in the child,
// which imports it before the artifact.)
import { types } from 'node:util'
const isProxy = types.isProxy
const getProto = Object.getPrototypeOf
const getOwnDesc = Object.getOwnPropertyDescriptor
const getOwnNames = Object.getOwnPropertyNames
const getOwnSyms = Object.getOwnPropertySymbols
const defineProp = Object.defineProperty
const isArray = Array.isArray
const numIsFinite = Number.isFinite
const ObjProto = Object.prototype
const setHas = Set.prototype.has
const setAdd = Set.prototype.add
const setDelete = Set.prototype.delete

// `seen` is the CURRENT PATH (post-order delete) so a shared sub-object (DAG/diamond) is allowed; only a true
// cycle throws. Exported for direct test. ALWAYS strict on `undefined` (JSON can't carry it) — a void method's
// top-level `undefined` return is normalized to null by the CALLER (io-trace), not here, so nested `undefined`
// stays a failure rather than silently diverging from JSON object semantics.
export function canonicalData(v, seen = new Set()) {
  if (v === null) return null
  const t = typeof v
  if (t === 'number') { if (!numIsFinite(v)) throw new Error('non-finite number'); return v }
  if (t === 'string' || t === 'boolean') return v
  if (t !== 'object') throw new Error(`non-JSON value (${t})`) // undefined, function, symbol, bigint
  if (isProxy(v)) throw new Error('proxy object — reflection would invoke its traps')
  if (setHas.call(seen, v)) throw new Error('cyclic reference')
  setAdd.call(seen, v)
  let out
  if (isArray(v)) {
    out = []
    const n = v.length
    for (let i = 0; i < n; i++) {
      const d = getOwnDesc(v, '' + i)
      if (!d) { out[i] = null; continue } // hole -> null (JSON array semantics)
      if (d.get || d.set) throw new Error(`accessor array index "${i}"`) // never invoke an index getter
      out[i] = canonicalData(d.value, seen)
    }
  } else {
    const proto = getProto(v)
    if (proto !== ObjProto && proto !== null) throw new Error('non-plain object (class instance / Map / Set / Date)')
    if (getOwnSyms(v).length) throw new Error('symbol-keyed property')
    out = {}
    for (const k of getOwnNames(v)) {
      const d = getOwnDesc(v, k)
      if (d.get || d.set) throw new Error(`accessor property "${k}"`) // forge defense — never read a getter
      if (!d.enumerable) continue // JSON-visible state only
      // defineProperty (not out[k]=) so a "__proto__" key becomes a data prop, not prototype pollution.
      defineProp(out, k, { value: canonicalData(d.value, seen), enumerable: true, writable: true, configurable: true })
    }
  }
  setDelete.call(seen, v)
  return out
}
