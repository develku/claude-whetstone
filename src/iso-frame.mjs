// src/iso-frame.mjs
// Cross-process transport for the isolated behavioural runner (#2). Two jobs:
//   - serialize(): turn an ALREADY-INERT value (post canonicalData) into JSON text WITHOUT ever invoking
//     toJSON/getters. It stringifies only PRIMITIVE leaves via a captured JSON.stringify; objects/arrays are
//     walked by hand with captured primordials, so a gamed artifact's polluted Object.prototype.toJSON /
//     Array.prototype is never consulted (plain JSON.stringify on an object WOULD call a polluted toJSON).
//   - frameOpen/frameClose/extractPayload(): wrap the payload in an unforgeable per-run hex-nonce frame.
//     The child can write anything to fd 3, but without the nonce (kept out of its reach by the capability
//     lockdown) it cannot produce a valid frame — so the parent extracts ONLY the runner's real payload.
// A leaf module: NO imports (stdlib globals only), so the locked-down child can load it before the artifact
// and its captured primordials stay clean. Primordials captured at MODULE LOAD (before any artifact runs).
const _stringify = JSON.stringify
const _isArray = Array.isArray
const _keys = Object.keys

// `v` is INERT (canonicalData output): null | finite number | string | boolean | plain array | plain object.
export function serialize(v) {
  if (v === null) return 'null'
  if (typeof v !== 'object') return _stringify(v) // number | string | boolean — primitive, no toJSON lookup
  if (_isArray(v)) {
    let s = '['
    for (let i = 0; i < v.length; i++) s += (i ? ',' : '') + serialize(v[i])
    return s + ']'
  }
  const ks = _keys(v)
  let s = '{'
  for (let i = 0; i < ks.length; i++) s += (i ? ',' : '') + _stringify(ks[i]) + ':' + serialize(v[ks[i]])
  return s + '}'
}

export const frameOpen = (nonce) => `<<${nonce}>>`
export const frameClose = (nonce) => `<<${nonce}>>`

// Extract the text BETWEEN the first open marker and the next identical marker after it. Returns null if a
// complete nonce frame is absent — the parent treats that as "no valid result" (artifact suppressed/forged).
export function extractPayload(wire, nonce) {
  const marker = `<<${nonce}>>`
  const i = wire.indexOf(marker)
  if (i < 0) return null
  const start = i + marker.length
  const j = wire.indexOf(marker, start)
  if (j < 0) return null
  return wire.slice(start, j)
}
