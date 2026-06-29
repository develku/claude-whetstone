// src/safe-rel.mjs
// Resolve a per-file check target for SCOPE-mode behavioural scorers: the data-only scorers (io-assert,
// io-trace, contains) receive the repo/worktree ROOT as --output and an optional --rel (repo-relative path)
// naming the one file to check. This lets composite.mjs forward a single --output to every sub-scorer while
// each check targets its own file — so the gate stays a plain string (no function composer). The rel is
// containment-guarded (it MUST stay inside --output), mirroring the decompose sub-gate CR#5 guard. A leaf
// module (stdlib only) imported by the scorers.
import { resolve, isAbsolute, sep } from 'node:path'
import { realpathSync } from 'node:fs'

export function resolveOutput(output, rel) {
  if (rel == null || rel === '') return output
  if (isAbsolute(rel)) throw new Error(`--rel must be repo-relative, got absolute: ${rel}`)
  const base = resolve(output)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`--rel escapes --output: ${rel}`)
  // The lexical guard above is realpath-blind: an in-scope SYMLINK whose target is OUTSIDE --output passes
  // it, yet the caller (readFileSync / await import) FOLLOWS the link — an out-of-repo read + import-RCE in
  // every --rel scorer. Re-check containment on the REAL paths. A path not yet materialized (realpathSync
  // throws) has no symlink to follow — the lexical guard already held, so return it (the caller's own
  // read/import then fails or proceeds normally). Mirrors scorers/doc-lint.mjs refResolves.
  let realFull
  try {
    realFull = realpathSync(full)
  } catch {
    return full
  }
  const realBase = realpathSync(base) // base must exist since `full` (under it) resolved
  if (realFull !== realBase && !realFull.startsWith(realBase + sep)) {
    throw new Error(`--rel escapes --output via symlink: ${rel}`)
  }
  return full
}
