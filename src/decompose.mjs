// The v2 planner tier: the ONLY genuinely new decision logic. At a coarse-signal plateau the
// escalated-slot closure fans out one short child whetstone run per code-owned finding, each with a
// narrower scorer-emitted gate, then the unchanged parent loop re-measures the whole repo. runLoop /
// gateVerdict / recordPass are untouched; runChild + rescueAct are injected (no driver/scope-cli import).
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { gateVerdict } from './gate.mjs'

const key = (f) => String(f?.area ?? '')

// Decompose fires ONLY at a genuine plateau below target. The escalated slot is "sticky" (runLoop sets
// currentAct = actEscalated permanently), so without this self-check the closure would fan out on EVERY
// later pass and on the no-op escalation path with stale findings — the worst cost bug. [CR#1]
export function coarseSignalPlateau(state) {
  return gateVerdict(state).status === 'plateau' && state.best_score < state.target_score
}

// Findings are code-owned: read them from the last review file on disk, never from a model-supplied
// state field. Returns [] when there is no scored history, no review ref, or an unreadable/torn file.
export function readLatestFindings(parentLoopDir, state) {
  const ref = state.history?.at(-1)?.critique_ref
  if (!ref) return []
  try {
    const review = JSON.parse(readFileSync(join(parentLoopDir, ref), 'utf8'))
    return Array.isArray(review.findings) ? review.findings : []
  } catch {
    return []
  }
}

// POSIX single-quote: every finding-supplied arg is wrapped so a metacharacter can never reach the
// shell unquoted. Inlined (like scope-context) to keep decompose off the driver/CLI import graph.
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

// Build a child sub-gate from a finding, or null when it is not SAFELY decomposable. The scorer id is
// resolved against an operator-owned allowlist (never executed as a raw string) and every arg is
// shq-quoted [CR#4]; an optional scope must stay inside the repo [CR#5]. This is the whole injection
// fence — a finding can only ever name a known scorer and pass quoted args to it.
export function resolveSubGate(finding, { repoDir, allowlist }) {
  const sg = finding?.scorer
  if (!sg || typeof sg.id !== 'string' || !Array.isArray(sg.args)) return null
  const scriptPath = allowlist.get(sg.id)
  if (!scriptPath) return null
  let editScope = null
  if (finding.scope != null) {
    const base = resolve(repoDir)
    const full = resolve(base, finding.scope)
    if (full !== base && !full.startsWith(base + sep)) return null // escapes the repo -> refuse
    editScope = String(finding.scope)
  }
  const scorerCmd = ['node', shq(scriptPath), ...sg.args.map(shq)].join(' ')
  return { editScope, scorerCmd }
}

// The findings worth fanning out: resolvable to a sub-gate AND not already decomposed this run.
export function decomposable(findings, seen, ctx) {
  return findings.filter((f) => !seen.has(key(f)) && resolveSubGate(f, ctx) != null)
}

// Per-child budget share: divide each SET dial by the children still to launch; a null dial stays null
// (cap-only bounding). Recomputed before each child by the closure so spend can't outrun the budget. [CR#6]
export function splitBudget(remaining, n) {
  return {
    budgetUsd: remaining.usd == null ? null : remaining.usd / n,
    budgetTokens: remaining.tokens == null ? null : remaining.tokens / n,
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'finding'

// A child is a normal whetstone-scope run, narrowed: same repo (NEVER finding.scope as cwd [CR#5]),
// a focused goal, the scorer-emitted sub-gate, a small cap, its budget share, and decompose:false so
// it cannot recurse (depth cap 1). Its loop dir nests under the parent's (which is gitignored/outside).
export function buildChildCfg(parentCfg, state, finding, subgate, share, childCap, parentLoopDir) {
  return {
    goal: `${state.goal} — specifically: ${finding.suggestion ?? finding.area}`,
    scope: parentCfg.scope,
    artifactPath: parentCfg.scope,
    editScope: subgate.editScope,
    scorerCmd: subgate.scorerCmd,
    confirmScorerCmd: null,
    observeCmd: null,
    readOnly: parentCfg.readOnly,
    targetScore: state.target_score,
    hardCap: childCap,
    budgetUsd: share.budgetUsd,
    budgetTokens: share.budgetTokens,
    model: parentCfg.model,
    effort: parentCfg.effort,
    escalateModel: parentCfg.escalateModel,
    noEscalate: parentCfg.noEscalate,
    mcpConfig: parentCfg.mcpConfig,
    decompose: false,
    loopDir: join(parentLoopDir, 'children', slug(finding.area)),
  }
}
