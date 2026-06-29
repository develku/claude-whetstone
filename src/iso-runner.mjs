// src/iso-runner.mjs
// PARENT side of the isolated behavioural runner (#2). runIsolated() spawns a locked-down child that imports
// the untrusted artifact, executes the contract, and returns an INERT observation; the calling scorer then runs
// its oracle (deep-equal / invariant checks) on that observation in THIS clean process — which never imports the
// artifact. That process boundary is the real isolation: corrupting the child's assert/JSON/stdout is pointless.
//
// Spawn shape (NO shell — argument array): node --permission --allow-fs-read=<src> --allow-fs-read=<artifact dir>
// child <stdin: {nonce,artifact,mode,spec}>. The grants are REALPATHS (the ESM loader realpaths the artifact;
// the permission model checks the real path). --permission denies fs-write/worker/child_process/inspector; the
// child's own lockdown denies the in-memory heap/escape routes. The job (incl. the nonce) goes over stdin, so it
// never touches disk and needs no extra fs grant.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { extractPayload } from './iso-frame.mjs'

const TOOL_DIR = realpathSync(dirname(fileURLToPath(import.meta.url))) // src/: child + iso-execute + iso-frame + canonical-data
const CHILD = join(TOOL_DIR, 'iso-runner-child.mjs')
const DEFAULT_TIMEOUT_MS = Number(process.env.WHET_ISO_TIMEOUT_MS) || 60 * 1000

// Run one behavioural check out-of-process. `artifact` is the already-resolved file path (the scorer resolves
// --output/--rel via resolveOutput first). `readRoot` (optional) is the original --output: in scope mode that
// is the repo/worktree ROOT, granted so an artifact that imports repo siblings across directories still loads
// (matching the prior in-process behaviour — the artifact never had less fs-read than the code it tests). The
// nonce/expected are never files, so widening read does not leak the oracle. Returns the child's observation
// object, or a typed { ok:false, reason } when no valid framed result came back (crash/timeout/suppressed/forged).
export function runIsolated({ artifact, mode, spec, readRoot, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let realArtifact
  try { realArtifact = realpathSync(artifact) } catch (e) { return { ok: false, reason: 'artifact', error: `cannot resolve artifact: ${e.message}` } }
  const grants = new Set([TOOL_DIR, dirname(realArtifact)]) // src/ (runner+deps) + the artifact's own dir
  if (readRoot) { try { grants.add(realpathSync(readRoot)) } catch { /* unresolvable root: dirname grant still covers the file */ } }
  const nonce = randomBytes(8).toString('hex')
  const r = spawnSync(process.execPath, [
    '--permission',
    ...[...grants].map((d) => '--allow-fs-read=' + d),
    CHILD,
  ], {
    input: JSON.stringify({ nonce, artifact: realArtifact, mode, spec }),
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'], // stdin=job, stdout ignored, stderr captured, fd3=result
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024, // a gamed child flooding fd3 hits ENOBUFS -> r.error -> no-frame, never OOM
  })
  if (r.error) return { ok: false, reason: 'spawn', error: String(r.error.message || r.error) }
  const fd3 = r.output && r.output[3] ? r.output[3].toString('utf8') : ''
  const payload = extractPayload(fd3, nonce)
  if (payload == null) {
    const err = (r.stderr ? r.stderr.toString('utf8') : '').trim().split('\n').slice(-1)[0] || ''
    return { ok: false, reason: 'no-frame', status: r.status, signal: r.signal, stderr: err.slice(0, 200) }
  }
  try { return JSON.parse(payload) } catch { return { ok: false, reason: 'unparseable' } }
}

// Reduce a non-ok observation to a scorer outcome (shared by all four io-* CLIs so the reason->exit mapping
// can't drift). Returns null when ok:true (caller proceeds to its oracle). Otherwise:
//   { kind:'scorer-error', message } — the scorer cannot proceed: bad import (preserves the documented
//     exit-2-on-import contract), or a missing export when `missingExportExits` (io-assert/io-invariant do).
//   { kind:'score-zero', critique } — the artifact ran but failed to meet the bar (execute threw, non-JSON
//     return, suppressed/forged/crashed child): a verdict (score 0), not a scorer malfunction.
export function classifyObservation(obs, { missingExportExits = false } = {}) {
  if (obs.ok) return null
  if (obs.reason === 'import') return { kind: 'scorer-error', message: `cannot import artifact: ${obs.error}` }
  if (obs.reason === 'missing-export') {
    return missingExportExits
      ? { kind: 'scorer-error', message: `artifact does not export a function named "${obs.name}"` }
      : { kind: 'score-zero', critique: `artifact has no export "${obs.name}"` }
  }
  const detail = obs.error || obs.reason
  return { kind: 'score-zero', critique: `artifact failure: ${detail}${obs.stderr ? ` (${obs.stderr})` : ''}` }
}
