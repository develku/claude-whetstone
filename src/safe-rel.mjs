// src/safe-rel.mjs
// Resolve a per-file check target for SCOPE-mode behavioural scorers: the data-only scorers (io-assert,
// io-trace, contains) receive the repo/worktree ROOT as --output and an optional --rel (repo-relative path)
// naming the one file to check. This lets composite.mjs forward a single --output to every sub-scorer while
// each check targets its own file — so the gate stays a plain string (no function composer). The rel is
// containment-guarded (it MUST stay inside --output), mirroring the decompose sub-gate CR#5 guard. A leaf
// module (stdlib only) imported by the scorers.
import { resolve, isAbsolute, sep } from 'node:path'

export function resolveOutput(output, rel) {
  if (rel == null || rel === '') return output
  if (isAbsolute(rel)) throw new Error(`--rel must be repo-relative, got absolute: ${rel}`)
  const base = resolve(output)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`--rel escapes --output: ${rel}`)
  return full
}
