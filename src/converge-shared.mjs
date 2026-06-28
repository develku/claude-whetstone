// Leaf module (node stdlib only) shared by converge-cli (input validation / guards), converge-state (the
// ledger), and converge (the orchestrator). It holds the canonical-path + read-only-footprint helpers so
// NONE of those three import each other in a cycle — the same anti-cycle discipline as safe-rel.mjs /
// scorer-safety.mjs. (converge.mjs is the only one with a CLI entry that dynamically imports its siblings;
// keeping it out of a static cycle is what lets that entry's top-level await settle.)
import { resolve, relative, normalize, sep } from 'node:path'

export function canonRel(p) {
  let s = normalize(String(p).trim()).replace(/\/+$/, '')
  if (s.startsWith('./')) s = s.slice(2)
  return s === '.' ? '' : s
}

// Two repo-relative paths intersect iff equal, or one is an ancestor DIRECTORY of the other. '' (the repo
// root) intersects everything. Ancestry uses the trailing separator so 'src/a' does NOT contain 'src/app'.
export function pathsIntersect(a, b) {
  const x = canonRel(a)
  const y = canonRel(b)
  if (x === '' || y === '') return true
  if (x === y) return true
  return x.startsWith(y + '/') || y.startsWith(x + '/')
}

// Script-like tokens of a scorer command (operator-authored, space-separated).
export function scriptTokens(cmd) {
  return String(cmd ?? '').split(/\s+/).filter((t) => /\.(mjs|cjs|js|ts)$/.test(t))
}

// Project-LOCAL scorer scripts: script tokens that resolve INSIDE --scope (relative to the scope, where the
// scorer runs). These must be read-only or the editor could game its own scorer by editing the script. An
// absolute whetstone scorer (outside scope) is NOT model-reachable and is not added.
function scorerScriptPaths(cmd, scope) {
  const base = resolve(scope)
  const out = []
  for (const t of scriptTokens(cmd)) {
    const abs = resolve(base, t)
    if (abs === base || abs.startsWith(base + sep)) out.push(relative(base, abs))
  }
  return out
}

// A judge-class objective is operator-flagged OR has a scorer/confirm that resolves to llm-judge.
export function isJudgeClass(o) {
  if (o.judgeClass === true) return true
  return /llm-judge/.test(`${o.scorer ?? ''} ${o.confirmScorer ?? ''}`)
}

// The union read-only set: every objective's own readOnly, the floor's declared footprint, and every
// project-local scorer/confirm SCRIPT. Reads the SAME shape from a manifest OR a converge-state (both carry
// floor.readOnly + objectives[].readOnly/scorer/confirmScorer), so resume reconstructs it identically.
export function globalReadOnly(manifestOrState, scope) {
  const set = new Set()
  for (const ro of manifestOrState?.floor?.readOnly ?? []) set.add(canonRel(ro))
  for (const o of manifestOrState?.objectives ?? []) {
    for (const ro of o.readOnly ?? []) set.add(canonRel(ro))
    for (const s of scorerScriptPaths(o.scorer ?? '', scope)) set.add(canonRel(s))
    if (o.confirmScorer) for (const s of scorerScriptPaths(o.confirmScorer, scope)) set.add(canonRel(s))
  }
  return [...set].filter(Boolean)
}
