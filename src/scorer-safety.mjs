// src/scorer-safety.mjs
// Shared trust-boundary helper for the two places that resolve OPERATOR-named scorer paths into a
// model-reachable allowlist: the Verifier Forge (src/forge/hook.mjs forgeAllowlist) and the scope
// decompose sub-gate set (src/scope-cli.mjs buildAllowlist extraPaths). A command-executing scorer
// (one whose contract is "run my argument" via shell:true — e.g. composite, test-pass-rate) must
// never become a model-selectable check, because the MODEL picks the id/finding while the operator
// only names paths. Both boundaries denylist such scorers; this is the ONE canonicalization they
// share so they cannot drift (the bug a prior per-boundary ad-hoc filter had: the denylist key and
// the derived id used different normalizations, so composite.v2.mjs / Composite.mjs / bare composite
// all slipped past). A leaf module (node stdlib only) so neither boundary import creates a cycle.
import { basename, resolve, dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Canonical stem for the denylist comparison: drop the directory, strip ALL extensions (not just the
// last), and lowercase — so composite.mjs, Composite.mjs, composite.v2.mjs, composite.backup.mjs and
// bare 'composite' ALL collapse to 'composite'. This is stricter than the allowlist MAP KEY (which
// keeps single-extension-strip, case-preserving, as the scorerId the model names); it exists ONLY to
// make the unsafe test robust against renamed/copied/cased dodges of a shipped command-executing scorer.
export function scorerStem(p) {
  // Strip a leading dotfile prefix FIRST: otherwise `.composite.mjs` -> /\..*$/ matches from the leading
  // dot -> '' (empty stem), letting a dotfile-named copy of a denylisted command-executing scorer dodge.
  return basename(p).replace(/^\.+/, '').replace(/\..*$/, '').toLowerCase()
}

// True if `p` names a command-executing scorer that must be excluded from a model-reachable allowlist.
// Two layers: (1) name-stem match against `denySet` — catches rename/copy/case/extension variants of a
// shipped unsafe scorer (the realistic operator-iterating-on-scorers dodge); (2) realpath identity match
// against `unsafePaths` — catches a symlink/hardlink to the real shipped scorer hiding under an unrelated
// basename. A path that cannot be realpath-resolved (missing file) falls through to the name-stem result;
// a non-existent allowlist entry never resolves/runs anyway. NOTE: this does NOT (and cannot) catch an
// operator allowlisting an arbitrary NEW shell-executing scorer they authored — that is the operator's
// own trust decision, the same as --confirm-scorer/--scorer, which run verbatim.
export function isUnsafeScorer(p, denySet, unsafePaths = []) {
  if (denySet.has(scorerStem(p))) return true
  let real
  try { real = realpathSync(resolve(p)) } catch { return false }
  return unsafePaths.some((u) => {
    try { return realpathSync(u) === real } catch { return false }
  })
}

// The canonical set of SHIPPED scorers that are unsafe to be MODEL-SELECTABLE, because their contract is
// "run my argument": composite (manifest lines via shell:true), floor (an operator --cmd via a second shell),
// test-pass-rate (a model-authorable --cmd), llm-judge (a model-authored --rubric / --mcp-config). Defined
// ONCE here so the TWO model-authors-args boundaries — Track A's loadPlanAllowlist (plan-allowlist.mjs) and
// the Verifier Forge's forgeAllowlist (forge/hook.mjs) — BOTH subtract the SAME set and cannot drift. (A prior
// drift left the Forge denylist missing floor + llm-judge: a proven model-authored-RCE hole.) Lowercased stems
// (matching scorerStem). NOTE: this is the model-AUTHORS-args threat; scope/converge's SUBGATE_UNSAFE =
// {composite, floor} is a DIFFERENT, smaller threat model (a model-EDITED file pathed into as a scorer cmd)
// and is intentionally a separate, narrower denylist.
const SCORERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')
export const SHELL_SCORERS = new Set(['composite', 'floor', 'test-pass-rate', 'llm-judge'])
export const SHELL_SCORER_PATHS = [...SHELL_SCORERS].map((id) => join(SCORERS_DIR, `${id}.mjs`))
