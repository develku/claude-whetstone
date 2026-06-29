// Track A's data-only scorer allowlist — the #1 risk, closed (spec §7). Track A is the FORGE case: the
// MODEL authors the scorer args, so a scorer whose contract is "run my argument" (shell:true / API call)
// is model-reaches-shell and must NEVER be model-selectable. This is STRICTLY broader than scope-cli's
// SUBGATE_UNSAFE={composite,floor}: that denylist ADMITS test-pass-rate (a model-authorable --cmd) and
// llm-judge (a model-authored rubric), both holes here. Two independent refuters confirmed reusing it.
//
// Design: a POSITIVE allowlist for the SHIPPED scorers (fail-closed — a newly shipped scorer is excluded
// until consciously classified), and an isUnsafeScorer denylist for operator --scorer-allow paths (whose
// ids are unknown, so positive-by-id is impossible; this still HARD-subtracts a renamed/symlinked shipped
// shell scorer). A novel operator-authored shell scorer cannot be detected by id and is the operator's
// own documented trust decision (§11.4, mirroring scorer-safety.mjs's caveat and --scorer/--confirm-scorer).
import { readdirSync } from 'node:fs'
import { dirname, basename, join, resolve as rpath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUnsafeScorer } from './scorer-safety.mjs'

const SCORERS_DIR = rpath(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')

// The DATA-only scorers: they read the editor's structured output (JSON / call traces / effects) and compare.
// Their args are DATA, never a command, and they run NO shell. NOTE (post-#2): the io-* scorers DO spawn a
// child — but it is `node --permission` with a static arg array (no shell:true) running the artifact in a
// locked-down sandbox (src/iso-runner.mjs); that hardened, no-shell, data-stdin spawn is what makes them safe
// to be model-selectable, NOT a zero-subprocess property. contains/doc-lint spawn nothing.
// POSITIVE allowlist: ONLY these shipped ids are model-selectable.
// doc-lint reads a markdown file + checks repo file-existence/version (node:fs reads only — no
// child_process/spawn/exec/shell/--cmd/API); its model-authorable args redirect WHAT to read, never
// WHAT to execute, so it is genuinely data-only and safe to be model-selectable.
export const PLAN_DATA_ONLY = new Set(['contains', 'io-assert', 'io-trace', 'io-invariant', 'io-effect', 'doc-lint'])

// The shell-executing scorers, HARD-subtracted (lowercased stems — also the denySet for isUnsafeScorer).
// composite runs manifest lines via shell:true; floor runs an operator --cmd; test-pass-rate runs a
// model-authorable --cmd; llm-judge calls an API with a model-authored rubric (judge-class capture surface).
export const PLAN_SHELL_SCORERS = new Set(['composite', 'floor', 'test-pass-rate', 'llm-judge'])
const PLAN_SHELL_PATHS = [...PLAN_SHELL_SCORERS].map((id) => join(SCORERS_DIR, `${id}.mjs`))

// loadPlanAllowlist(scorerAllowPaths) -> Map<id, absPath> of DATA-only scorers only.
export function loadPlanAllowlist(scorerAllowPaths = []) {
  const m = new Map()
  // shipped: POSITIVE allowlist (fail-closed) — only the known data-only ids are admitted
  for (const f of readdirSync(SCORERS_DIR)) {
    if (!f.endsWith('.mjs')) continue
    const id = f.replace(/\.mjs$/, '')
    if (PLAN_DATA_ONLY.has(id)) m.set(id, join(SCORERS_DIR, f))
  }
  // operator --scorer-allow: the operator's trust decision, EXCEPT a renamed/symlinked shipped SHELL
  // scorer is still HARD-subtracted (isUnsafeScorer is stem-robust + realpath-aware, shared with the Forge).
  for (const p of scorerAllowPaths) {
    if (isUnsafeScorer(p, PLAN_SHELL_SCORERS, PLAN_SHELL_PATHS)) continue
    const id = basename(p).replace(/\.[^.]+$/, '')
    // A shipped data-only id is NEVER overwritten by an operator path: otherwise a `--scorer-allow
    // /tmp/contains.mjs` (a shell-executing file) would silently replace the security-verified shipped
    // contains, and the model selecting id 'contains' would reach the malicious file (power-review MEDIUM).
    if (PLAN_DATA_ONLY.has(id)) continue
    m.set(id, rpath(p))
  }
  return m
}
