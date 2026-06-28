// Track A's fence — the whole "model output is DATA, never a privileged path" safety story. The model
// proposes {scorerId, args[]} (an allowlist KEY + quoted args), NEVER an executable name or a command
// string. CODE resolves the id against the operator's data-only allowlist (plan-allowlist.mjs) and
// constructs `node <op-path> <shq args>`. The model never names the binary, never controls cwd/scope, and
// its free-text goal is never executed (it reaches the editor through the already-fenced buildEditorPrompt).
// The editScope is canonicalized to the SAME repo-relative form the gate's pathsIntersect uses.
//
// Mirrors decompose.resolveSubGate with three intentional IMPROVEMENTS over that sibling:
//   (1) the repo-root scope is checked SEPARATELY before containment — decompose's combined
//       `(full !== base && !startsWith(base+sep))` lets a '.' editScope slip through; here 3a catches it,
//   (2) editScope is canonicalized via canonRel(relative(...)) rather than kept as a raw string, and
//   (3) a non-string editScope is guarded BEFORE resolve() (which would otherwise throw).
// These close two checks convergeRefusal itself does NOT do: 3a (a '.'/'' editScope passes the whole
// refusal suite today) and 3b (a '../../etc' / '/etc' / sibling-prefix editScope likewise passes today).
//
// KNOWN LIMITATION (documented, not a bug): containment is LEXICAL (path.resolve), not physical
// (fs.realpath). A symlink INSIDE scopeDir pointing outside the repo would pass this fence. Adding
// realpath would make the fence impure + add a throw path, breaking the "null-only, never throws"
// contract; the right mitigation is operator hygiene on the repo, matching decompose/safe-rel/scope-act.
//
// Pure (path math only); returns null to DROP an unsafe objective and never throws on adversarial input.
import { resolve, relative, sep } from 'node:path'
import { shq } from './shq.mjs'
import { canonRel } from './converge-shared.mjs'

// resolveObjective(proposal, { scopeDir, allowlist }) -> objective | null
export function resolveObjective(proposal, { scopeDir, allowlist }) {
  if (proposal == null) return null
  const scriptPath = allowlist.get(proposal.scorerId) // 1. known DATA-only id (a non-string id misses the Map -> undefined)
  if (typeof scriptPath !== 'string' || !scriptPath) return null // also self-defends vs an upstream allowlist bug (M1)
  if (!Array.isArray(proposal.args) || !proposal.args.every((a) => typeof a === 'string')) return null // 2. args = string[]
  if (typeof proposal.editScope !== 'string') return null // editScope must be a string or resolve() throws
  const scorer = ['node', shq(scriptPath), ...proposal.args.map(shq)].join(' ') // 3. CODE builds the command
  const baseDir = resolve(scopeDir)
  const full = resolve(baseDir, proposal.editScope)
  if (full === baseDir) return null // 3a. REJECT repo-root scope (refuter BREAK#3)
  if (!full.startsWith(baseDir + sep)) return null // 3b. REJECT traversal / absolute / sibling-prefix
  const editScope = canonRel(relative(baseDir, full)) // 4. canonical repo-relative — SAME canon as pathsIntersect
  return { id: proposal.id, goal: proposal.goal, scorer, editScope, target: proposal.target }
}
