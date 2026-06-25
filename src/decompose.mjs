// The v2 planner tier: the ONLY genuinely new decision logic. At a coarse-signal plateau the
// escalated-slot closure fans out one short child whetstone run per code-owned finding, each with a
// narrower scorer-emitted gate, then the unchanged parent loop re-measures the whole repo. runLoop /
// gateVerdict / recordPass are untouched; runChild + rescueAct are injected (no driver/scope-cli import).
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { gateVerdict } from './gate.mjs'
import { gitHead, gitTreeChanged, gitRestore } from './git-snapshot.mjs'
import { scopeChanged } from './scope-act.mjs'

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
    // FLOOR the token share: budget_tokens is a COUNTED integer (validate.mjs requires Number.isInteger),
    // so a fractional share would make every child's validateConfig throw and decompose would silently
    // no-op. Floor (not round) keeps the children's shares summing to <= the remaining token budget.
    budgetTokens: remaining.tokens == null ? null : Math.floor(remaining.tokens / n),
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

const sevRank = { critical: 3, high: 2, medium: 1, low: 0 }
const sev = (f) => sevRank[String(f?.severity).toLowerCase()] ?? 0
const rem = (budget, spent) => (budget == null ? null : Math.max(0, budget - spent))
const exhausted = (r) => (r.usd != null && r.usd <= 0) || (r.tokens != null && r.tokens <= 0)
const cleanTree = (dir) => !scopeChanged(dir)

// The escalated-slot closure. Because runLoop makes actEscalated sticky, the FIRST thing it does is
// re-check it is genuinely at a plateau [CR#1] (no-op-path entries and post-improvement passes fall
// through to a single rescue edit). It then fans out one short child per fresh, resolvable finding,
// sequentially on the shared branch, each transactional [CR#2], with spend recomputed against the
// budget before each launch [CR#6]. Child spend always charges the parent (money is spent even when
// the git edits are rolled back). `changed` is a TREE diff so an all-no-op fan-out reads honest.
export function makeDecomposeAct({ repoDir, parentLoopDir, parentCfg, runChild, rescueAct, allowlist, maxChildren = 4, childCap = 3, log = () => {} }) {
  const seen = new Set()
  const ctx = { repoDir, allowlist }
  return async (state) => {
    if (!coarseSignalPlateau(state)) return rescueAct(state)
    const fresh = decomposable(readLatestFindings(parentLoopDir, state), seen, ctx)
    if (!fresh.length) return rescueAct(state)
    const picked = [...fresh].sort((a, b) => sev(b) - sev(a)).slice(0, maxChildren)
    log({ event: 'decompose', children: picked.length, areas: picked.map(key), childCap })
    const headBefore = gitHead(repoDir)
    let costUsd = 0
    let tokens = 0
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i]
      const remaining = { usd: rem(state.budget_usd, state.spent_usd + costUsd), tokens: rem(state.budget_tokens, (state.spent_tokens ?? 0) + tokens) }
      if (exhausted(remaining)) { log({ event: 'decompose-budget-stop', after: i }); break }
      seen.add(key(f))
      const childHead = gitHead(repoDir)
      const cfg = buildChildCfg(parentCfg, state, f, resolveSubGate(f, ctx), splitBudget(remaining, picked.length - i), childCap, parentLoopDir)
      try {
        const { state: cs, verdict } = await runChild(cfg)
        costUsd += cs.spent_usd ?? 0           // money is spent regardless of whether we keep the edits
        tokens += cs.spent_tokens ?? 0
        if (verdict.status === 'error' || !cleanTree(repoDir)) gitRestore(repoDir, childHead) // discard a bad child
      } catch (e) {
        gitRestore(repoDir, childHead)
        log({ event: 'decompose-child-error', area: key(f), error: e.message })
      }
    }
    return { changed: gitTreeChanged(repoDir, headBefore), costUsd, tokens }
  }
}
